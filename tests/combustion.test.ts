import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { generateAliases } from '../src/components/alias-engine.js';
import { startCombustion, shouldRngRespond } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';
import {
  composeSystemInstruction,
  getBotIdentityInstruction,
  getDefaultBehavioralInstruction,
  getDefaultPersonalityInstruction,
} from '../src/components/personality.js';
import type { Configuration } from '../src/config/configuration.js';
import * as nvidiaModule from '../src/ai/nvidia.js';
import * as composerModule from '../src/components/composer.js';
import { ANTI_ECHO_RETRY_INSTRUCTION } from '../src/components/anti-echo.js';

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const LOG_SELECTOR = '[role="log"][aria-live="polite"]';

const configuration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Brave\\brave.exe',
  profilePath: 'C:\\Brave\\profile',
  skipPinRestoration: false,
  pin: '001234',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
  messageDestination: 'https://www.facebook.com/messages/t/123456789',
  botTemperament: 'balanced',
};

function createMockPage({ failObserverSetup = false, messageCount = 1 } = {}) {
  const listeners = new Set<(...args: unknown[]) => void>();
  let observerSetupCalls = 0;
  let observerCleanupCalls = 0;
  let baselineReadCalls = 0;
  const page = {
    on(event: string, listener: (...args: unknown[]) => void) {
      assert.equal(event, 'console');
      listeners.add(listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      assert.equal(event, 'console');
      listeners.delete(listener);
      return this;
    },
    locator(selector: string) {
      if (selector === LOG_SELECTOR) {
        return {
          evaluate: async () => {
            observerSetupCalls += 1;
            if (failObserverSetup) {
              throw new Error('mock observer setup failure');
            }
          },
        };
      }
      assert.equal(selector, MESSAGE_SELECTOR);
      return {
        evaluateAll: async (
          callback: (items: HTMLElement[], limit: number) => unknown[],
          limit: number,
        ) => {
          baselineReadCalls += 1;
          const elements = Array.from({ length: messageCount }, (_, index) => ({
            getAttribute(name: string) {
              if (name === 'data-message-id') {
                return index === 0 ? 'historical-1' : `baseline-${index}`;
              }
              return name === 'aria-label'
                ? 'At October 18, 2026, 1:15 PM, Alex: hello'
                : null;
            },
            cloneNode() {
              return {
                innerText: 'hello',
                querySelectorAll: () => [],
              };
            },
          })) as unknown as HTMLElement[];
          return runInNewContext(
            `(${callback.toString()})(items, limit)`,
            { items: elements, limit },
          ) as unknown[];
        },
      };
    },
    evaluate: async () => {
      observerCleanupCalls += 1;
    },
  } as unknown as Page;

  return {
    page,
    get listenerCount() {
      return listeners.size;
    },
    get observerSetupCalls() {
      return observerSetupCalls;
    },
    get observerCleanupCalls() {
      return observerCleanupCalls;
    },
    get baselineReadCalls() {
      return baselineReadCalls;
    },
  };
}

// A page whose rendered messages are controlled per test. Sender, direction and
// message id are all supplied by the injected record, so one logical message can
// be rendered under two `data-message-id` values exactly as observed live.
function createInjectedMessengerPage() {
  const mockPage = createMockPage({ messageCount: 0 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; sender: string; message: string }> = [];
  let readCount = 0;

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector !== MESSAGE_SELECTOR) {
      return originalLocator(selector);
    }
    return {
      evaluateAll: async (
        callback: (items: unknown[], limit: number) => unknown[],
        limit: number,
      ): Promise<unknown[]> => {
        readCount += 1;
        const elements = injectedMessages.map(message => ({
          getAttribute(name: string) {
            if (name === 'data-message-id') {
              return message.messageId;
            }
            return name === 'aria-label'
              ? `At October 18, 2026, 1:15 PM, ${message.sender}: ${message.message}`
              : null;
          },
          cloneNode() {
            return {
              innerText: message.message,
              querySelectorAll: () => [],
            };
          },
        }));
        return runInNewContext(
          `(${callback.toString()})(items, limit)`,
          { items: elements, limit },
        ) as unknown[];
      },
    };
  };

  return {
    page: basePage,
    get readCount() {
      return readCount;
    },
    inject(messages: Array<{ messageId: string; sender: string; message: string }>) {
      injectedMessages.push(...messages);
    },
    replace(messages: Array<{ messageId: string; sender: string; message: string }>) {
      injectedMessages.length = 0;
      injectedMessages.push(...messages);
    },
  };
}

test('Combustion uses the supplied seeded store and cleans up before stop resolves', async () => {
  const mockPage = createMockPage();
  const contextStore = createContextStore();
  const historicalTimestamp = {
    original: 'October 18, 2026, 1:15 PM',
    normalized: '2026-10-18T13:15:00',
    resolved: true,
  };
  contextStore.add([{
    messageId: 'historical-1',
    message: 'hello',
    sender: 'Alex',
    direction: 'INCOMING',
    timestamp: historicalTimestamp,
  }]);
  let suppliedStoreAddCalls = 0;
  const add = contextStore.add.bind(contextStore);
  contextStore.add = messages => {
    suppliedStoreAddCalls += 1;
    add(messages);
  };

  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });
  assert.equal(suppliedStoreAddCalls, 1);
  assert.equal(mockPage.baselineReadCalls, 1);
  assert.equal(mockPage.observerSetupCalls, 1);
  assert.equal(mockPage.listenerCount, 1);
  assert.deepEqual(contextStore.getRecent(1), [{
    messageId: 'historical-1',
    message: 'hello',
    sender: 'Alex',
    direction: 'INCOMING',
    timestamp: historicalTimestamp,
  }]);

  await controller.stop();
  await controller.stopped;
  assert.equal(mockPage.listenerCount, 0);
  assert.equal(mockPage.observerCleanupCalls, 1);
});

test('Combustion pauses polling and resumes it without duplicating reads', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage();
  const contextStore = createContextStore();
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    assert.equal(mockPage.baselineReadCalls, 1);
    await controller.pause();
    await flush();
    context.mock.timers.tick(60_000);
    await flush();
    assert.equal(mockPage.baselineReadCalls, 1);

    await controller.resume();
    await flush();
    context.mock.timers.tick(3_000);
    await flush();
    await flush();
    assert.equal(mockPage.baselineReadCalls, 2);
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion changes destinations, resets conversation state, and resumes without duplicate observers', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage({ messageCount: 2 });
  const contextStore = createContextStore();
  contextStore.add([{ messageId: 'old-conversation', message: 'stale context' }]);
  const navigation: string[] = [];
  const persisted: string[] = [];
  const firstDestination = 'https://www.facebook.com/messages/t/987654321';
  const secondDestination = 'https://www.facebook.com/messages/t/111111111';
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    navigateDestination: async destination => {
      navigation.push(destination);
    },
  });

  try {
    assert.deepEqual(
      contextStore.getState().messageIds,
      ['old-conversation', 'historical-1', 'baseline-1'],
    );
    const first = await controller.changeDestination(firstDestination, {
      resume: true,
      persist: destination => {
        persisted.push(destination);
      },
    });
    assert.deepEqual(first, { status: 'changed', resumed: true });
    assert.deepEqual(navigation, [firstDestination]);
    assert.deepEqual(persisted, [firstDestination]);
    assert.equal(configuration.messageDestination, firstDestination);
    assert.deepEqual(contextStore.getState().messageIds, ['historical-1', 'baseline-1']);
    assert.deepEqual(contextStore.getRecent(2).map(message => message.message), ['hello', 'hello']);

    const second = await controller.changeDestination(secondDestination, {
      resume: true,
      persist: destination => {
        persisted.push(destination);
      },
    });
    assert.deepEqual(second, { status: 'changed', resumed: true });
    assert.deepEqual(navigation, [firstDestination, secondDestination]);
    assert.deepEqual(persisted, [firstDestination, secondDestination]);
    assert.equal(configuration.messageDestination, secondDestination);
    assert.equal(mockPage.baselineReadCalls, 3);
    assert.equal(mockPage.observerSetupCalls, 1);
    assert.equal(mockPage.listenerCount, 1);
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion rejects an invalid destination, restores navigation, and keeps the paused session intact', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage();
  const contextStore = createContextStore();
  const originalDestination = configuration.messageDestination!;
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const navigation: string[] = [];
  let persisted = false;
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    navigateDestination: async selectedDestination => {
      navigation.push(selectedDestination);
      if (selectedDestination === destination) {
        throw new Error('destination could not be verified');
      }
    },
  });

  try {
    assert.deepEqual(contextStore.getState().messageIds, ['historical-1']);
    const result = await controller.changeDestination(destination, {
      resume: true,
      persist: () => {
        persisted = true;
      },
    });
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.match(result.reason, /not a valid or accessible group conversation/);
      assert.match(result.reason, /destination could not be verified/);
    }
    assert.equal(persisted, false);
    assert.equal(configuration.messageDestination, originalDestination);
    assert.deepEqual(navigation, [destination, originalDestination]);
    assert.deepEqual(contextStore.getState().messageIds, ['historical-1']);
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion initialization failure removes its listener without owning the page', async () => {
  const mockPage = createMockPage({ failObserverSetup: true });
  const contextStore = createContextStore();

  await assert.rejects(startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  }), /mock observer setup failure/);

  assert.equal(mockPage.listenerCount, 0);
  assert.equal(mockPage.observerCleanupCalls, 0);
});

test('Combustion passes the twenty-message poll window into the isolated page callback', async () => {
  const mockPage = createMockPage({ messageCount: 21 });
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  // 21 rendered messages: 'historical-1' plus baseline-1..baseline-20. The
  // twenty-message window drops only the oldest rendered message.
  assert.deepEqual(contextStore.getState().messageIds, [
    'baseline-1',
    'baseline-2',
    'baseline-3',
    'baseline-4',
    'baseline-5',
    'baseline-6',
    'baseline-7',
    'baseline-8',
    'baseline-9',
    'baseline-10',
    'baseline-11',
    'baseline-12',
    'baseline-13',
    'baseline-14',
    'baseline-15',
    'baseline-16',
    'baseline-17',
    'baseline-18',
    'baseline-19',
    'baseline-20',
  ]);
  assert.equal(contextStore.getState().size, 20);
  assert.ok(!contextStore.getState().messageIds.includes('historical-1'));
  await controller.stop();
});
test('RNG decisions use the configured temperament and update without restarting', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0.2;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const mockPage = createMockPage({ messageCount: 0 });
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration: { ...configuration, botTemperament: 'talkative' },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  try {
    context.mock.timers.tick(15_000);
    await flush();
    assert.ok(logs.some(message => message.includes('[poll] Poll: 0 new messages checked; 0 mention detected.')));
    assert.ok(logs.some(message => message.includes('[rng] Evaluating cycle')));
    assert.ok(logs.some(message => message.includes('[rng] Skipped: no usable incoming Messenger message')));
    assert.ok(logs.some(message => message.includes('Roll: YES (95% chance)')));

    controller.setTemperament('quiet');
    context.mock.timers.tick(15_000);
    await flush();
    assert.ok(logs.some(message => message.includes('Roll: NO (90% chance)')));

    // The same sampled value flips back with a talkative temperament and the next
    // roll uses its 95% probability without restarting the engine.
    Math.random = () => 0.9;
    controller.setTemperament('talkative');
    context.mock.timers.tick(15_000);
    await flush();
    assert.ok(logs.some(message => message.includes('Roll: YES (95% chance)')));

    controller.setTemperament('balanced');
    context.mock.timers.tick(15_000);
    await flush();
    assert.ok(logs.some(message => message.includes('Roll: NO (50% chance)')));

    assert.equal(mockPage.observerSetupCalls, 1);
    assert.equal(
      logs.filter(message => message.includes('Starting Combustion')).length,
      1,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
  }
});

test('Personality changes at runtime apply to replies and keep the configured identity', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 1;

  const capturedRequests: Array<{
    systemInstruction?: string;
    messages: readonly { message: string }[];
  }> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const mutableNvidiaModule = nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  };
  mutableNvidiaModule.generateNvidiaReply = async (
    apiKey: string,
    messages: readonly unknown[],
    options: { systemInstruction?: string } = {},
  ): Promise<string> => {
    void apiKey;
    capturedRequests.push({
      systemInstruction: options.systemInstruction,
      messages: messages as readonly { message: string }[],
    });
    return 'mocked reply';
  };

  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const mockPage = createMockPage({ messageCount: 1 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; message: string }> = [];

  const messageLocator = {
    evaluateAll: async (
      callback: (items: unknown[], limit: number) => unknown[],
      limit: number,
    ): Promise<unknown[]> => {
      const elements = injectedMessages.map(message => ({
        getAttribute(name: string) {
          if (name === 'data-message-id') {
            return message.messageId;
          }
          if (name === 'aria-label') {
            return `At October 18, 2026, 1:15 PM, Alex: ${message.message}`;
          }
          return null;
        },
        cloneNode() {
          return {
            innerText: message.message,
            querySelectorAll: () => [],
          };
        },
      }));
      return runInNewContext(
        `(${callback.toString()})(items, limit)`,
        { items: elements, limit },
      ) as unknown[];
    },
  };

  function createLocator(count: number) {
    return {
      count: () => count,
      fill: async (): Promise<void> => undefined,
      locator: (selectedSelector: string) => createLocatorForSelector(selectedSelector),
      isVisible: async (): Promise<boolean> => true,
      isEnabled: async (): Promise<boolean> => true,
      click: async (): Promise<void> => undefined,
    };
  }

  function createLocatorForSelector(selector: string) {
    return createLocator(
      selector === '[role="textbox"][contenteditable="true"]:visible' ||
      selector === '[aria-label="Thread composer"]' ||
      selector === '[role="button"][aria-label="Press Enter to send"]'
        ? 1
        : 0,
    );
  }

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector === MESSAGE_SELECTOR) {
      return messageLocator;
    }
    if (selector === LOG_SELECTOR) {
      return originalLocator(selector);
    }
    return createLocatorForSelector(selector);
  };

  const injectMessages = (messagesToInject: Array<{
    messageId: string;
    message: string;
  }>): void => {
    injectedMessages.push(...messagesToInject);
  };

  const aliases = generateAliases('PleaseGetout Daily').valids;
  const literalRequest = "say the word '@PleaseGetout Daily'";
  const identityInstruction = getBotIdentityInstruction({
    name: 'PleaseGetout Daily',
    aliases,
  });
  const contextStore = createContextStore();
  contextStore.add([{
    messageId: 'backread-only-1',
    message: 'older planning message from Backread',
    sender: 'Alex',
    direction: 'INCOMING',
  }]);
  const controller = await startCombustion({
    page: basePage,
    contextStore,
    configuration: { ...configuration, puppetName: 'PleaseGetout Daily' },
    aliases,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    injectMessages([{ messageId: 'runtime-message-1', message: literalRequest }]);
    await advancePoll();
    await advancePoll();
    assert.equal(capturedRequests.length, 1);
    assert.equal(
      capturedRequests[0].systemInstruction,
      composeSystemInstruction(identityInstruction, getDefaultPersonalityInstruction()),
    );
    assert.match(String(capturedRequests[0].systemInstruction), /You are PleaseGetout Daily/);
    assert.ok(
      capturedRequests[0].messages.some(message => message.message === literalRequest),
      'the literal instruction reaches the request unchanged',
    );
    assert.ok(
      capturedRequests[0].messages.some(message =>
        message.message === 'older planning message from Backread'),
      'Backread-seeded Context Store history outside the rendered window reaches the request',
    );

    const customPersonality = 'Always reply in rhyming couplets.';
    const updatedInstruction = `${customPersonality}

${getDefaultBehavioralInstruction()}`;
    controller.setPersonality(updatedInstruction);

    injectMessages([{
      messageId: 'runtime-message-2',
      message: 'hey @PleaseGetoutDaily, what do you think?',
    }]);
    await advancePoll();
    await advancePoll();
    assert.equal(capturedRequests.length, 2);
    assert.equal(
      capturedRequests[1].systemInstruction,
      composeSystemInstruction(identityInstruction, updatedInstruction),
    );
    assert.match(String(capturedRequests[1].systemInstruction), /rhyming couplets/);
    assert.match(String(capturedRequests[1].systemInstruction), /You are PleaseGetout Daily/);
    assert.match(
      String(capturedRequests[1].systemInstruction),
      /Do not begin an ordinary reply with your own name or alias/,
      'a runtime personality change cannot remove the self-mention rule',
    );
    assert.doesNotMatch(
      String(capturedRequests[1].systemInstruction),
      /playful, warm, spontaneous/,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    mutableNvidiaModule.generateNvidiaReply = originalGenerateNvidiaReply;
  }
});

test('a burst is fully observed and a follow-up mention is still answered during the cooldown', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    void apiKey;
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const mockPage = createMockPage({ messageCount: 0 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; sender: string; message: string }> = [];

  const messageLocator = {
    evaluateAll: async (
      callback: (items: unknown[], limit: number) => unknown[],
      limit: number,
    ): Promise<unknown[]> => {
      const elements = injectedMessages.map(message => ({
        getAttribute(name: string) {
          if (name === 'data-message-id') {
            return message.messageId;
          }
          if (name === 'aria-label') {
            return `At October 18, 2026, 1:15 PM, ${message.sender}: ${message.message}`;
          }
          return null;
        },
        cloneNode() {
          return {
            innerText: message.message,
            querySelectorAll: () => [],
          };
        },
      }));
      return runInNewContext(
        `(${callback.toString()})(items, limit)`,
        { items: elements, limit },
      ) as unknown[];
    },
  };

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector === MESSAGE_SELECTOR) {
      return messageLocator;
    }
    return originalLocator(selector);
  };

  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: basePage,
    contextStore,
    configuration,
    aliases: generateAliases('PleaseGetout Daily').valids,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    // Ten messages arrive between polls; the mention is the oldest of them.
    injectedMessages.push({
      messageId: 'burst-1',
      sender: 'Alex',
      message: 'hey @PleaseGetout Daily are you there?',
    });
    for (let index = 2; index <= 10; index += 1) {
      injectedMessages.push({
        messageId: `burst-${index}`,
        sender: 'Blair',
        message: `burst message ${index}`,
      });
    }

    await advancePoll();
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1, 'the oldest mention still opens exactly one packet');
    assert.deepEqual(
      generatedRequests[0].map(message => message.messageId),
      ['burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5', 'burst-6', 'burst-7', 'burst-8', 'burst-9', 'burst-10'],
      'the whole burst is kept in order',
    );
    assert.equal(
      generatedRequests[0].filter(message => message.messageId === 'burst-1').length,
      1,
      'the trigger is sent exactly once',
    );
    assert.equal(contextStore.getState().size, 10, 'every burst message enters the Context Store');

    // A poll with no new messages must not duplicate work.
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);

    // A follow-up mention is answered even though the previous reply started the
    // RNG cooldown, and the earlier turn is still available as context.
    injectedMessages.push({
      messageId: 'burst-11',
      sender: 'Alex',
      message: '@PleaseGetoutDaily summarise that',
    });
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 2, 'a follow-up mention is not blocked by the cooldown');
    const followUp = generatedRequests[1];
    assert.equal(followUp.at(-1)?.messageId, 'burst-11');
    assert.equal(
      followUp.filter(message => message.messageId === 'burst-11').length,
      1,
      'the follow-up trigger is sent exactly once',
    );
    assert.ok(
      followUp.some(message => message.messageId === 'burst-1'),
      'the earlier mention remains part of the follow-up context',
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('a sent mention reply starts the RNG cooldown so one turn cannot be answered twice', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };

  const generatedReplies: unknown[][] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    void apiKey;
    generatedReplies.push([...messages]);
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const mockPage = createMockPage({ messageCount: 0 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; sender: string; message: string }> = [];

  const messageLocator = {
    evaluateAll: async (
      callback: (items: unknown[], limit: number) => unknown[],
      limit: number,
    ): Promise<unknown[]> => {
      const elements = injectedMessages.map(message => ({
        getAttribute(name: string) {
          if (name === 'data-message-id') {
            return message.messageId;
          }
          if (name === 'aria-label') {
            return `At October 18, 2026, 1:15 PM, ${message.sender}: ${message.message}`;
          }
          return null;
        },
        cloneNode() {
          return {
            innerText: message.message,
            querySelectorAll: () => [],
          };
        },
      }));
      return runInNewContext(
        `(${callback.toString()})(items, limit)`,
        { items: elements, limit },
      ) as unknown[];
    },
  };

  function createLocator(count: number) {
    return {
      count: () => count,
      fill: async (): Promise<void> => undefined,
      locator: (selectedSelector: string) => createLocatorForSelector(selectedSelector),
      isVisible: async (): Promise<boolean> => true,
      isEnabled: async (): Promise<boolean> => true,
      click: async (): Promise<void> => undefined,
    };
  }

  function createLocatorForSelector(selector: string) {
    return createLocator(
      selector === '[role="textbox"][contenteditable="true"]:visible' ||
      selector === '[aria-label="Thread composer"]' ||
      selector === '[role="button"][aria-label="Press Enter to send"]'
        ? 1
        : 0,
    );
  }

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector === MESSAGE_SELECTOR) {
      return messageLocator;
    }
    return originalLocator(selector);
  };

  const controller = await startCombustion({
    page: basePage,
    contextStore: createContextStore(),
    configuration,
    aliases: generateAliases('PleaseGetout Daily').valids,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    injectedMessages.push({
      messageId: 'incoming-1',
      sender: 'Alex',
      message: 'hey @PleaseGetout Daily',
    });
    await advancePoll();
    await advancePoll();
    await advancePoll();
    assert.equal(generatedReplies.length, 1, 'the mention is answered exactly once');
    assert.ok(logs.some(line => line.includes('Cooldown started')), 'the reply starts a cooldown');

    context.mock.timers.tick(15_000);
    await flush();
    assert.equal(
      generatedReplies.length,
      1,
      'the RNG cycle does not answer the same turn again during the cooldown',
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('Combustion never treats its own outgoing alias as a mention trigger', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedReplies: unknown[][] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const mutableNvidiaModule = nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  };
  mutableNvidiaModule.generateNvidiaReply = async (
    apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    void apiKey;
    generatedReplies.push([...messages]);
    return 'mocked reply';
  };

  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
    await flush();
  };

  const mockPage = createMockPage({ messageCount: 0 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; sender: string; message: string }> = [];

  const messageLocator = {
    evaluateAll: async (
      callback: (items: unknown[], limit: number) => unknown[],
      limit: number,
    ): Promise<unknown[]> => {
      const elements = injectedMessages.map(message => ({
        getAttribute(name: string) {
          if (name === 'data-message-id') {
            return message.messageId;
          }
          if (name === 'aria-label') {
            return `At October 18, 2026, 1:15 PM, ${message.sender}: ${message.message}`;
          }
          return null;
        },
        cloneNode() {
          return {
            innerText: message.message,
            querySelectorAll: () => [],
          };
        },
      }));
      return runInNewContext(
        `(${callback.toString()})(items, limit)`,
        { items: elements, limit },
      ) as unknown[];
    },
  };

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector === MESSAGE_SELECTOR) {
      return messageLocator;
    }
    return originalLocator(selector);
  };

  const controller = await startCombustion({
    page: basePage,
    contextStore: createContextStore(),
    configuration,
    aliases: generateAliases('PleaseGetout Daily').valids,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    injectedMessages.push(
      {
        messageId: 'outgoing-1',
        sender: 'You',
        message: "@PleaseGetout Daily, that's what I meant.",
      },
      {
        messageId: 'outgoing-2',
        sender: 'You',
        message: "@PleaseGetoutDaily, that's what I meant.",
      },
      {
        messageId: 'outgoing-3',
        sender: 'You',
        message: "@PleaseGetout_Daily, that's what I meant.",
      },
    );
    await advancePoll();
    await advancePoll();
    await advancePoll();
    assert.deepEqual(generatedReplies, []);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    mutableNvidiaModule.generateNvidiaReply = originalGenerateNvidiaReply;
  }
});

test('Combustion strips a self-identifying prefix before composing and keeps a requested alias', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const composedReplies: string[] = [];
  const generatedReplies = [
    '@PleaseGetout Daily Oh, nice? That is it?',
    "@PleaseGetout Daily",
  ];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => generatedReplies.shift() ?? 'ok';
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, reply) => {
    composedReplies.push(reply);
    return { status: 'sent' };
  };

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const mockPage = createMockPage({ messageCount: 0 });
  const basePage = mockPage.page;
  const originalLocator = basePage.locator.bind(basePage);
  const injectedMessages: Array<{ messageId: string; message: string }> = [];

  (basePage as { locator: (selector: string) => unknown }).locator = (selector: string) => {
    if (selector !== MESSAGE_SELECTOR) {
      return originalLocator(selector);
    }
    return {
      evaluateAll: async (
        callback: (items: unknown[], limit: number) => unknown[],
        limit: number,
      ): Promise<unknown[]> => {
        const elements = injectedMessages.map(message => ({
          getAttribute(name: string) {
            if (name === 'data-message-id') {
              return message.messageId;
            }
            return name === 'aria-label'
              ? `At October 18, 2026, 1:15 PM, Alex: ${message.message}`
              : null;
          },
          cloneNode() {
            return {
              innerText: message.message,
              querySelectorAll: () => [],
            };
          },
        }));
        return runInNewContext(
          `(${callback.toString()})(items, limit)`,
          { items: elements, limit },
        ) as unknown[];
      },
    };
  };

  const aliases = generateAliases('PleaseGetout Daily').valids;
  const controller = await startCombustion({
    page: basePage,
    contextStore: createContextStore(),
    configuration: { ...configuration, puppetName: 'PleaseGetout Daily' },
    aliases,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    injectedMessages.push({
      messageId: 'prefix-1',
      message: '@PleaseGetout Daily nice',
    });
    await advancePoll();
    await advancePoll();
    assert.deepEqual(composedReplies, ['Oh, nice? That is it?']);

    injectedMessages.push({
      messageId: 'prefix-2',
      message: "say '@PleaseGetout Daily'",
    });
    await advancePoll();
    await advancePoll();
    assert.deepEqual(composedReplies, ['Oh, nice? That is it?', '@PleaseGetout Daily']);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('one reply rendered under two ids becomes one Context Store message and one assistant turn', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    sender: string;
    direction: string;
  }[]> = [];
  const composedReplies: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, reply) => {
    composedReplies.push(reply);
    return { status: 'sent' };
  };

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const reply =
    'I literally just said it. Like, one message ago. Are you testing my memory? ' +
    'I am definitely going to start ignoring this request any second now.';
  const numericId = '7521591905785117407';
  const midId = 'mid.$gAAW_kanMS16nuYVAE2hiD_y5xnrf';
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([
      { messageId: numericId, sender: 'You', message: reply },
      { messageId: midId, sender: 'You', message: reply },
      { messageId: 'mid.$mention-1', sender: 'Alex', message: '@Bot what now?' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'one packet generates one reply');
    assert.equal(composedReplies.length, 1, 'one packet submits one composer send');
    assert.deepEqual(
      contextStore.getState().messageIds,
      [numericId, 'mid.$mention-1'],
      'the duplicate rendering is stored once, with the first rendered id',
    );
    const request = generatedRequests[0];
    assert.equal(
      request.filter(message => message.message === reply).length,
      1,
      'the duplicate reply is one assistant turn, not two',
    );
    assert.equal(request.at(-1)?.messageId, 'mid.$mention-1');

    // The other namespace's copy still resolves to the canonical id on later
    // polls: it must never become new work or a second reply.
    const afterSecondPoll = generatedRequests.length;
    assert.equal(afterSecondPoll, 1);

    // A legitimate identical request with a new server id is still processed.
    inject([{ messageId: 'mid.$mention-2', sender: 'Alex', message: '@Bot what now?' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 2, 'a repeated user request is not suppressed');
    assert.equal(composedReplies.length, 2);
    assert.equal(
      generatedRequests[1].filter(message => message.messageId === 'mid.$mention-2').length,
      1,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('a duplicated incoming mention opens one packet and sends once', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  let composeCalls = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => {
    composeCalls += 1;
    return { status: 'sent' };
  };

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3000);
    await flush();
  };

  const mention = '@Bot are you there?';
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([
      { messageId: '7521592070141142020', sender: 'Alex', message: mention },
      { messageId: 'mid.$gAAW_kanMS16nuYXZFGhiECL-KGQE', sender: 'Alex', message: mention },
    ]);
    await advancePoll();
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'one mention generates one reply');
    assert.equal(composeCalls, 1, 'one mention submits one composer send');
    assert.deepEqual(contextStore.getState().messageIds, ['7521592070141142020']);
    assert.equal(
      generatedRequests[0].filter(message => message.message === mention).length,
      1,
      'the trigger appears exactly once in the request',
    );
    assert.equal(generatedRequests[0].at(-1)?.messageId, '7521592070141142020');
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

async function flushEngine(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test('quiet polls do not rebuild context, and the trigger poll assembles it once', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  const generated: Array<readonly { messageId: string; message: string }[]> = [];
  let composeCalls = 0;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generated.push(messages as readonly { messageId: string; message: string }[]);
    return 'ok';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => {
    composeCalls += 1;
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const contextStore = createContextStore();
  contextStore.add([{
    messageId: 'backread-1',
    message: 'older planning message',
    sender: 'Alex',
    direction: 'INCOMING',
  }]);
  let contextReads = 0;
  const getRecent = contextStore.getRecent.bind(contextStore);
  contextStore.getRecent = (limit: number) => {
    contextReads += 1;
    return getRecent(limit);
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    const readsAfterStartup = contextReads;
    await advancePoll();
    await advancePoll();
    await advancePoll();
    assert.equal(
      contextReads,
      readsAfterStartup,
      'a poll with no new messages and no pending packet does not read the store for context',
    );

    inject([{ messageId: 'mention-1', sender: 'Alex', message: '@Bot are you there?' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generated.length, 1);
    assert.equal(composeCalls, 1);
    assert.ok(contextReads > readsAfterStartup, 'the trigger poll assembles context once');
    assert.ok(
      generated[0].some(message => message.messageId === 'backread-1'),
      'seeded history still reaches the model request',
    );
    assert.equal(generated[0].at(-1)?.messageId, 'mention-1');
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('the runtime poll cadence is 1.5 seconds', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const messengerPage = createInjectedMessengerPage();
  const controller = await startCombustion({
    page: messengerPage.page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    const readsAfterStartup = messengerPage.readCount;
    context.mock.timers.tick(1_000);
    await flushEngine();
    assert.equal(messengerPage.readCount, readsAfterStartup, 'no poll happens before the cadence');

    context.mock.timers.tick(500);
    await flushEngine();
    assert.equal(messengerPage.readCount, readsAfterStartup + 1, 'one poll at the 1.5s cadence');
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('packet timing log reports each pipeline stage once per reply', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0.99;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => 'ok';
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'timed-1', sender: 'Alex', message: '@Bot timing check' }]);
    await advancePoll();
    await advancePoll();

    const timingLines = logs.filter(line => line.includes('[timing]'));
    assert.equal(timingLines.length, 1, 'one timing line per processed packet');
    assert.match(timingLines[0], /packet=packet-001/);
    assert.match(
      timingLines[0],
      /hold=\d+ms queue=\d+ms generate=\d+ms compose=\d+ms total=\d+ms/,
    );
    assert.ok(
      logs.some(line => line.includes('[poll] detected 1 message(s) in')),
      'the detection cost is reported next to the cadence',
    );
    assert.ok(logs.some(line => line.includes('cadence 1500ms')));
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('the compiled mention matcher still matches every configured alias format', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  const generated: Array<readonly { messageId: string; message: string }[]> = [];
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generated.push(messages as readonly { messageId: string; message: string }[]);
    return 'ok';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: { ...configuration, puppetName: 'PleaseGetout Daily' },
    aliases: generateAliases('PleaseGetout Daily').valids,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([
      { messageId: 'alias-1', sender: 'Alex', message: '@PleaseGetout Daily hi' },
      { messageId: 'alias-2', sender: 'Alex', message: 'hey @PleaseGetoutDaily' },
      { messageId: 'alias-3', sender: 'Blair', message: '@PleaseGetout    Daily   again' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generated.length, 1, 'all three alias forms open one packet');
    assert.deepEqual(
      generated[0].map(message => message.messageId).filter(id => id.startsWith('alias-')),
      ['alias-1', 'alias-2', 'alias-3'],
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('RNG decision boundaries follow each temperament without sampling randomness', () => {
  assert.equal(shouldRngRespond('quiet', 0.0999), true);
  assert.equal(shouldRngRespond('quiet', 0.1), false);
  assert.equal(shouldRngRespond('balanced', 0.4999), true);
  assert.equal(shouldRngRespond('balanced', 0.5), false);
  // Talkative rolls 95%, not the old 85%.
  assert.equal(shouldRngRespond('talkative', 0.8499), true);
  assert.equal(shouldRngRespond('talkative', 0.9499), true);
  assert.equal(shouldRngRespond('talkative', 0.85), true);
  assert.equal(shouldRngRespond('talkative', 0.95), false);
});

// The RNG cadence is a 7-second roll deadline checked at the end of each poll,
// not a second interval timer. These tests use the mocked Date so the deadline
// advances with the poll timers and each tick plus flush is exactly one poll.
function countRngRolls(logs: readonly string[]): number {
  return logs.filter(line => line.includes('[rng] Evaluating cycle')).length;
}

test('RNG rolls are evaluated by the poller at the 7-second deadline, once per window', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  // Always roll NO, so no packet and no cooldown hides the cadence itself.
  Math.random = () => 0.99;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async () => 'unused';
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const pollsTo = async (elapsedMs: number): Promise<void> => {
    context.mock.timers.tick(elapsedMs);
    await flushEngine();
  };

  const contextStore = createContextStore();
  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'chat-1', sender: 'Alex', message: 'just chatting' }]);
    await pollsTo(1_500);
    assert.deepEqual(contextStore.getState().messageIds, ['chat-1'], 'the opportunity is observed');
    assert.equal(countRngRolls(logs), 0, 'no roll happens before the 7-second deadline');

    await pollsTo(6_000);
    assert.equal(countRngRolls(logs), 1, 'the deadline is evaluated on the poll that reaches it');
    const evaluation = logs.find(line => line.includes('[rng] Evaluating cycle'));
    assert.ok(evaluation);
    const overdueMs = Number(/due (\d+)ms ago/.exec(evaluation)?.[1]);
    assert.ok(
      Number.isFinite(overdueMs) && overdueMs <= 1_500,
      `an opportunity is evaluated within one poll interval of its deadline (waited ${overdueMs}ms)`,
    );
    assert.ok(logs.some(line => line.includes('Roll: NO')), 'the roll itself still happens');

    await pollsTo(1_500);
    assert.equal(countRngRolls(logs), 1, 'later polls inside the window never roll again');

    await pollsTo(6_000);
    assert.equal(countRngRolls(logs), 2, 'the next window rolls at its own deadline');
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('an RNG cooldown that expires is noticed on the next poll, not the next cadence', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const replies: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async () => {
    replies.push('reply');
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const pollsTo = async (elapsedMs: number): Promise<void> => {
    context.mock.timers.tick(elapsedMs);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: { ...configuration, botTemperament: 'quiet' },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'chat-1', sender: 'Alex', message: 'just chatting' }]);
    await pollsTo(1_500);
    await pollsTo(13_500);
    assert.equal(replies.length, 1, 'the first opportunity is taken at its deadline');
    assert.ok(logs.some(line => line.includes('Cooldown started:') && line.includes('25s')));
    const rollsWhenSent = countRngRolls(logs);
    controller.setTemperament('talkative');

    await pollsTo(1_500);
    assert.equal(countRngRolls(logs), rollsWhenSent, 'no eligibility work while the cooldown runs');
    assert.equal(replies.length, 1, 'the cooldown still blocks a second reply');

    // Switching to Talkative cannot shorten the active 25-second Quiet
    // cooldown. Once it expires, the overdue opportunity is taken on the next
    // poll instead of waiting for another cadence boundary.
    await pollsTo(15_000);
    await pollsTo(7_500);
    assert.equal(replies.length, 1, 'still inside the cooldown');
    assert.equal(countRngRolls(logs), rollsWhenSent, 'blocked polls never roll');

    await pollsTo(1_500);
    assert.ok(logs.some(line => line.includes('Cooldown ended')));
    assert.equal(
      replies.length,
      2,
      'the first poll after the original cooldown expiry rolls again',
    );
    assert.ok(
      logs.some(line => line.includes('Cooldown started:') && line.includes('6s')),
      'the next reply uses Talkative cooldown settings',
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('a mention keeps priority over an RNG opportunity without consuming it', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  // Every permitted roll says YES, so an RNG packet would appear immediately if
  // the mention priority ever failed.
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const generations: string[] = [];
  let releaseMention: ((reply: string) => void) | undefined;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async () => {
    const index = generations.length;
    generations.push('reply');
    if (index === 0) {
      return new Promise<string>(resolve => {
        releaseMention = resolve;
      });
    }
    return 'opportunistic reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const pollsTo = async (elapsedMs: number): Promise<void> => {
    context.mock.timers.tick(elapsedMs);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await pollsTo(4_500);
    inject([{ messageId: 'mention-1', sender: 'Alex', message: 'hey @Bot are you around?' }]);
    await pollsTo(1_500);
    await pollsTo(1_500);
    // The mention packet is submitted on the poll that reaches the 7-second
    // deadline, so RNG must not ride along.
    assert.equal(generations.length, 1, 'the mention is answered');
    assert.equal(countRngRolls(logs), 0, 'no RNG roll on the poll that submitted the mention');

    await pollsTo(1_500);
    assert.equal(generations.length, 1, 'an in-flight mention still owns the model');
    assert.equal(countRngRolls(logs), 0, 'no RNG roll while the mention packet is active');
    assert.ok(
      logs.some(line => line.includes('Skipped:') && line.includes('mention packet active')),
      'the skip is attributed to the mention packet',
    );

    assert.ok(releaseMention);
    releaseMention('mention reply');
    await flushEngine();
    assert.ok(logs.some(line => line.includes('Cooldown started')), 'the mention starts a cooldown');

    // The mention cooldown delays the opportunity but does not discard it: keeping
    // the deadline instead of resetting it means the reply lands on the first poll
    // after the cooldown ends.
    await pollsTo(13_500);
    assert.equal(generations.length, 1, 'the cooldown still blocks the opportunity');
    await pollsTo(1_500);
    assert.equal(generations.length, 2, 'the opportunity is taken once the mention cooldown ends');
    assert.ok(logs.some(line => line.includes('Cooldown ended')));
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('an in-flight RNG generation is never duplicated by a later poll', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  // Every permitted roll says YES, so a duplicate opportunity would immediately
  // start a second model request.
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  let generateCalls = 0;
  let releaseRng: ((reply: string) => void) | undefined;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async () => {
    generateCalls += 1;
    return new Promise<string>(resolve => {
      releaseRng = resolve;
    });
  };
  let composeCalls = 0;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => {
    composeCalls += 1;
    return { status: 'sent' };
  };

  const pollsTo = async (elapsedMs: number): Promise<void> => {
    context.mock.timers.tick(elapsedMs);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'chat-1', sender: 'Alex', message: 'just chatting' }]);
    await pollsTo(1_500);
    await pollsTo(13_500);
    assert.equal(countRngRolls(logs), 1, 'the deadline produces exactly one roll');
    assert.equal(generateCalls, 1, 'the roll starts one generation');
    assert.equal(composeCalls, 0, 'nothing is composed before the model answers');

    // Several deadlines and polls pass while the first RNG generation is still
    // running. Neither a second roll nor a second generation may start.
    await pollsTo(15_000);
    await pollsTo(15_000);
    assert.equal(countRngRolls(logs), 1, 'no second roll while the RNG packet is in flight');
    assert.equal(generateCalls, 1, 'the model is never called twice concurrently');
    assert.equal(
      logs.filter(line => line.includes('[rng] Packet created:')).length,
      1,
      'only one RNG packet is ever created for the opportunity',
    );

    assert.ok(releaseRng);
    releaseRng('opportunistic reply');
    await flushEngine();
    assert.equal(composeCalls, 1, 'the in-flight reply is composed exactly once');
    assert.ok(logs.some(line => line.includes('Cooldown started')), 'the RNG reply starts a cooldown');

    await pollsTo(1_500);
    assert.equal(generateCalls, 1, 'the cooldown blocks the next opportunity');
    assert.equal(countRngRolls(logs), 1, 'blocked polls consume no roll');
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
    (nvidiaModule as unknown as {
      generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
    }).generateNvidiaReply = originalGenerateNvidiaReply;
    (composerModule as unknown as {
      composeMessengerReply: typeof composerModule.composeMessengerReply;
    }).composeMessengerReply = originalCompose;
  }
});

test('a destination change accepts a reused message id with different text', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const firstConversation = [{
    messageId: 'shared-1',
    sender: 'Alex',
    message: 'hello from the first conversation',
  }];
  const secondConversation = [{
    messageId: 'shared-1',
    sender: 'Alex',
    message: 'a different message in the second conversation',
  }];
  const { page, replace } = createInjectedMessengerPage();
  replace(firstConversation);
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    navigateDestination: async () => undefined,
  });

  try {
    assert.deepEqual(contextStore.getState().messageIds, ['shared-1']);
    replace(secondConversation);

    const result = await controller.changeDestination(destination, { resume: true });
    assert.deepEqual(result, { status: 'changed', resumed: true });
    assert.deepEqual(contextStore.getState().messageIds, ['shared-1']);
    assert.equal(
      contextStore.getRecent(1)[0]?.message,
      secondConversation[0].message,
      'content tracking was reset with the conversation',
    );

    // The next poll sees the new baseline content without tripping the guard.
    context.mock.timers.tick(3_000);
    await flushEngine();
    assert.equal(contextStore.getRecent(1)[0]?.message, secondConversation[0].message);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

function installAntiEchoPipelineMocks(replies: Array<string | Error>) {
  const generateRequests: Array<{
    systemInstruction?: string;
    messages: readonly { messageId?: string; message: string }[];
  }> = [];
  const composedReplies: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;

  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
    options: { systemInstruction?: string } = {},
  ): Promise<string> => {
    generateRequests.push({
      systemInstruction: options.systemInstruction,
      messages: messages as readonly { messageId?: string; message: string }[],
    });
    const next = replies.shift();
    if (next === undefined) {
      throw new Error('unexpected generation call');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, reply) => {
    composedReplies.push(reply);
    return { status: 'sent' };
  };

  return {
    generateRequests,
    composedReplies,
    restore() {
      (nvidiaModule as unknown as {
        generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
      }).generateNvidiaReply = originalGenerateNvidiaReply;
      (composerModule as unknown as {
        composeMessengerReply: typeof composerModule.composeMessengerReply;
      }).composeMessengerReply = originalCompose;
    },
  };
}

test('an RNG reply that echoes the incoming message is retried once and suppressed', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const harness = installAntiEchoPipelineMocks([
    'dude who are you',
    'Anselmo: dude who are you 😳',
  ]);
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'rng-echo-1', sender: 'Alex', message: 'dude who are you' }]);
    for (let poll = 0; poll < 5; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }

    assert.equal(harness.generateRequests.length, 2, 'the echo is retried exactly once');
    assert.equal(
      harness.generateRequests[0].systemInstruction,
      getDefaultPersonalityInstruction(),
      'the first attempt uses the unmodified system instruction',
    );
    assert.equal(
      harness.generateRequests[1].systemInstruction,
      composeSystemInstruction(getDefaultPersonalityInstruction(), ANTI_ECHO_RETRY_INSTRUCTION),
      'the retry adds only the explicit anti-echo instruction',
    );
    assert.deepEqual(harness.composedReplies, [], 'no echo reaches the composer');
    assert.deepEqual(
      contextStore.getState().messageIds,
      ['rng-echo-1'],
      'nothing is appended by detection or retry',
    );
    const suppressionLog = logs.find(line => line.includes('anti-echo suppression'));
    assert.ok(suppressionLog, 'the suppression is reported at runtime');
    assert.match(
      suppressionLog,
      /packet=rng-packet-\d+ type=rng messageId=rng-echo-1 retry=echoed attempts=2 action=suppressed/,
    );
  } finally {
    await controller.stop();
    harness.restore();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
  }
});

test('a mention-triggered echo is suppressed without entering outgoing history', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0.99;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const harness = installAntiEchoPipelineMocks([
    'Anselmo: @Bot can you hear me? 😳',
    '@Bot can you hear me? 😳',
  ]);
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const aliases = ['@Bot'];
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: { ...configuration, puppetName: 'Anselmo' },
    aliases,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'mention-echo-1', sender: 'Alex', message: '@Bot can you hear me?' }]);
    context.mock.timers.tick(3_000);
    await flushEngine();
    const snapshotAfterTrigger = contextStore.getRecent(10);

    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }

    assert.equal(harness.generateRequests.length, 2);
    const baseInstruction = composeSystemInstruction(
      getBotIdentityInstruction({ name: 'Anselmo', aliases }),
      getDefaultPersonalityInstruction(),
    );
    assert.equal(harness.generateRequests[0].systemInstruction, baseInstruction);
    assert.equal(
      harness.generateRequests[1].systemInstruction,
      composeSystemInstruction(baseInstruction, ANTI_ECHO_RETRY_INSTRUCTION),
      'the retry keeps the identity and personality layers intact',
    );
    assert.match(
      String(harness.generateRequests[1].systemInstruction),
      /Do not begin an ordinary reply with your own name or alias/,
    );
    assert.match(
      String(harness.generateRequests[1].systemInstruction),
      /playful, warm, spontaneous/,
      'the configured personality survives the retry',
    );

    assert.deepEqual(harness.composedReplies, [], 'neither echo is sent');
    const suppressionLog = logs.find(line => line.includes('anti-echo suppression'));
    assert.ok(suppressionLog, 'the suppression is reported at runtime');
    assert.match(
      suppressionLog,
      /packet=packet-\d+ type=mention messageId=mention-echo-1 retry=echoed attempts=2 action=suppressed/,
    );
    assert.deepEqual(
      contextStore.getRecent(10),
      snapshotAfterTrigger,
      'detection and retry never mutate the Context Store',
    );
    assert.deepEqual(contextStore.getState().messageIds, ['mention-echo-1']);
  } finally {
    await controller.stop();
    harness.restore();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
  }
});

test('legitimate short replies from both trigger paths are still sent', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const harness = installAntiEchoPipelineMocks(['Nothing much.', "Yeah, I'm here."]);
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'reply-1', sender: 'Alex', message: '@Bot what?' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(harness.composedReplies, ['Nothing much.']);
    assert.equal(harness.generateRequests.length, 1, 'a valid mention reply is not retried');

    Math.random = () => 0;
    inject([{ messageId: 'reply-2', sender: 'Alex', message: 'Are you there?' }]);
    for (let poll = 0; poll < 5; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(harness.composedReplies, ['Nothing much.', "Yeah, I'm here."]);
    assert.equal(harness.generateRequests.length, 2, 'a valid RNG reply is not retried');
  } finally {
    await controller.stop();
    harness.restore();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('a failing anti-echo retry does not crash Combustion or send the echo', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  const originalError = console.error;
  const originalLog = console.log;
  Math.random = () => 0.99;
  console.error = () => undefined;
  console.log = () => undefined;
  const harness = installAntiEchoPipelineMocks([
    'can you hear me?',
    new Error('retry generation failed'),
    'Loud and clear.',
  ]);
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'failure-1', sender: 'Alex', message: '@Bot can you hear me?' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.equal(harness.generateRequests.length, 2, 'one retry was attempted');
    assert.deepEqual(harness.composedReplies, [], 'the rejected echo was not sent');

    inject([{ messageId: 'failure-2', sender: 'Alex', message: '@Bot are you still there?' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(
      harness.composedReplies,
      ['Loud and clear.'],
      'the engine keeps processing later messages after a failed retry',
    );
  } finally {
    await controller.stop();
    harness.restore();
    console.error = originalError;
    console.log = originalLog;
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});
