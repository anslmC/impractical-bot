import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { generateAliases } from '../src/components/alias-engine.js';
import { startCombustion, shouldRngRespond } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';
import {
  appendRetryInstruction,
  composeProductionSystemInstruction,
  ENGLISH_ONLY_INSTRUCTION,
} from '../src/components/personality.js';
import { DEFAULT_COMPOSER_SLICER, type Configuration } from '../src/config/configuration.js';
import type { GroupRoster } from '../src/browser/group-roster.js';
import * as nvidiaModule from '../src/ai/nvidia.js';
import * as composerModule from '../src/components/composer.js';
import { ANTI_ECHO_RETRY_INSTRUCTION, SELF_REPETITION_RETRY_INSTRUCTION } from '../src/components/anti-echo.js';

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
  const loadListeners = new Set<(...args: unknown[]) => void>();
  let observerSetupCalls = 0;
  let observerCleanupCalls = 0;
  let baselineReadCalls = 0;
  const page = {
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'console') {
        listeners.add(listener);
        return this;
      }
      assert.equal(event, 'load');
      loadListeners.add(listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'console') {
        listeners.delete(listener);
        return this;
      }
      assert.equal(event, 'load');
      loadListeners.delete(listener);
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
    get loadListenerCount() {
      return loadListeners.size;
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
  const injectedMessages: Array<{
    messageId: string;
    sender: string;
    message: string;
    ariaLabel?: string | null;
    textWithoutSenderHeading?: string;
  }> = [];
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
            if (name === 'aria-label') {
              return message.ariaLabel === undefined
                ? `At October 18, 2026, 1:15 PM, ${message.sender}: ${message.message}`
                : message.ariaLabel;
            }
            return null;
          },
          cloneNode() {
            return {
              innerText: message.textWithoutSenderHeading ?? message.message,
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
    inject(messages: Array<{
      messageId: string;
      sender: string;
      message: string;
      ariaLabel?: string | null;
      textWithoutSenderHeading?: string;
    }>) {
      injectedMessages.push(...messages);
    },
    replace(messages: Array<{
      messageId: string;
      sender: string;
      message: string;
      ariaLabel?: string | null;
      textWithoutSenderHeading?: string;
    }>) {
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
  assert.equal(mockPage.loadListenerCount, 1);
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
  assert.equal(mockPage.loadListenerCount, 0);
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

test('Combustion changes destinations, resets conversation state, and reattaches its observer', async context => {
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
    assert.equal(mockPage.observerSetupCalls, 3);
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
      assert.equal(result.resumed, true);
      assert.match(result.reason, /could not be opened or verified/);
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

test('Combustion stays paused when rollback to the previous destination fails', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage({ messageCount: 2 });
  const contextStore = createContextStore();
  contextStore.add([{ messageId: 'old-conversation', message: 'stale context' }]);
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
        throw new Error('requested destination failed');
      }
      if (selectedDestination === originalDestination) {
        throw new Error('previous destination failed');
      }
    },
  });

  try {
    const result = await controller.changeDestination(destination, {
      resume: true,
      persist: () => {
        persisted = true;
      },
    });
    assert.deepEqual(result, {
      status: 'failed',
      resumed: false,
      reason:
        'The requested destination could not be opened or verified. requested destination failed ' +
        'The previous destination could not be restored, so the engine remains paused. ' +
        'Rollback failure: previous destination failed',
    });
    assert.equal(persisted, false);
    assert.equal(configuration.messageDestination, originalDestination);
    assert.deepEqual(navigation, [destination, originalDestination]);
    assert.deepEqual(
      contextStore.getState().messageIds,
      ['old-conversation', 'historical-1', 'baseline-1'],
    );
    await assert.rejects(
      controller.resume(),
      /cannot resume until a verified destination is restored/,
    );
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion rolls back when destination configuration persistence fails', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage({ messageCount: 2 });
  const contextStore = createContextStore();
  contextStore.add([{ messageId: 'old-conversation', message: 'stale context' }]);
  const originalDestination = configuration.messageDestination!;
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const navigation: string[] = [];
  const persisted: string[] = [];
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    navigateDestination: async selectedDestination => {
      navigation.push(selectedDestination);
    },
  });

  try {
    const result = await controller.changeDestination(destination, {
      resume: true,
      persist: selectedDestination => {
        persisted.push(selectedDestination);
        throw new Error('configuration write failed');
      },
    });
    assert.deepEqual(result, {
      status: 'failed',
      resumed: true,
      reason:
        'The requested destination was opened but its configuration could not be initialized. ' +
        'configuration write failed',
    });
    assert.deepEqual(persisted, [destination]);
    assert.equal(configuration.messageDestination, originalDestination);
    assert.deepEqual(navigation, [destination, originalDestination]);
    assert.deepEqual(
      contextStore.getState().messageIds,
      ['old-conversation', 'historical-1', 'baseline-1'],
    );
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion rolls back when destination conversation state reset fails', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage({ messageCount: 2 });
  const contextStore = createContextStore();
  contextStore.add([{ messageId: 'old-conversation', message: 'stale context' }]);
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
    },
  });
  const originalClear = contextStore.clear.bind(contextStore);
  let clearCalls = 0;
  contextStore.clear = () => {
    clearCalls += 1;
    if (clearCalls === 1) {
      throw new Error('state reset failed');
    }
    originalClear();
  };

  try {
    const result = await controller.changeDestination(destination, {
      resume: true,
      persist: () => {
        persisted = true;
      },
    });
    assert.deepEqual(result, {
      status: 'failed',
      resumed: true,
      reason:
        'The requested destination was opened but its conversation state could not be initialized. ' +
        'state reset failed',
    });
    assert.equal(persisted, false);
    assert.equal(configuration.messageDestination, originalDestination);
    assert.deepEqual(navigation, [destination, originalDestination]);
    assert.deepEqual(
      contextStore.getState().messageIds,
      ['old-conversation', 'historical-1', 'baseline-1'],
    );
  } finally {
    contextStore.clear = originalClear;
    await controller.stop();
    context.mock.timers.reset();
  }
});

test('Combustion leaves a previously paused engine paused after a rejected destination change', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const mockPage = createMockPage({ messageCount: 2 });
  const originalDestination = configuration.messageDestination!;
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const navigation: string[] = [];
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore: createContextStore(),
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
    await controller.pause();
    const result = await controller.changeDestination(destination, { resume: false });
    assert.deepEqual(result, {
      status: 'rejected',
      resumed: false,
      reason: 'The requested destination could not be opened or verified. destination could not be verified',
    });
    assert.equal(configuration.messageDestination, originalDestination);
    assert.deepEqual(navigation, [destination, originalDestination]);
    await controller.resume();
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
test('Context Store debug logs include sender names for new and retained messages', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 1;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
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
    inject([{
      messageId: 'mid.$sender-1',
      sender: 'Katsuyo',
      message: 'Yukinon do you hear anselmo?',
    }]);
    context.mock.timers.tick(1_500);
    await flushEngine();
    context.mock.timers.tick(6_000);
    await flushEngine();

    const storeUpdate = logs.find(line =>
      line.includes('CONTEXT STORE UPDATE') &&
      line.includes('mid.$sender-1') &&
      line.includes('Full retained store, in observation order:')
    );
    assert.ok(storeUpdate, 'the Context Store block is logged');
    const retainedIndex = storeUpdate.indexOf('Full retained store, in observation order:');
    const newSection = storeUpdate.slice(0, retainedIndex);
    const retainedSection = storeUpdate.slice(retainedIndex);
    assert.match(newSection, /id=mid\.\$sender-1/);
    assert.match(newSection, /sender=/);
    assert.match(newSection, /"Katsuyo"/);
    assert.match(newSection, /"Yukinon do you hear anselmo\?"/);
    assert.match(retainedSection, /id=mid\.\$sender-1/);
    assert.match(retainedSection, /sender=/);
    assert.match(retainedSection, /"Katsuyo"/);
    assert.match(retainedSection, /"Yukinon do you hear anselmo\?"/);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
  }
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
  const identity = { name: 'PleaseGetout Daily', aliases };
  const contextStore = createContextStore();
  contextStore.add([
    {
      messageId: 'backread-only-1',
      message: 'older planning message from Backread',
      sender: 'Alex',
      direction: 'INCOMING',
    },
    {
      messageId: 'backread-only-out-1',
      message: 'older assistant reply from Backread',
      sender: 'You',
      direction: 'OUTGOING',
    },
  ]);
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
      composeProductionSystemInstruction({
        identity,
        personalityMode: 'default',
      }),
    );
    assert.match(String(capturedRequests[0].systemInstruction), /You are PleaseGetout Daily/);
    assert.match(String(capturedRequests[0].systemInstruction), /Strict English-only output rule/);
    assert.equal(
      String(capturedRequests[0].systemInstruction)
        .split(ENGLISH_ONLY_INSTRUCTION).length - 1,
      1,
    );
    assert.ok(
      capturedRequests[0].messages.some(message => message.message === literalRequest),
      'the literal instruction reaches the request unchanged',
    );
    assert.ok(
      capturedRequests[0].messages.some(message =>
        message.message === 'older planning message from Backread'),
      'Backread-seeded Context Store history outside the rendered window reaches the request',
    );
    const backreadAssistantIndex = capturedRequests[0].messages.findIndex(message =>
      message.message === 'older assistant reply from Backread');
    const currentTriggerIndex = capturedRequests[0].messages.findIndex(message =>
      message.message === literalRequest);
    assert.ok(backreadAssistantIndex >= 0, 'Backread-seeded assistant reply reaches the request');
    assert.ok(
      backreadAssistantIndex < currentTriggerIndex,
      'Backread-seeded assistant history keeps chronological order',
    );

    const customPersonality = 'Always reply in rhyming couplets.';
    controller.setPersonality('custom', customPersonality);

    injectMessages([{
      messageId: 'runtime-message-2',
      message: 'hey @PleaseGetoutDaily, what do you think?',
    }]);
    await advancePoll();
    await advancePoll();
    assert.equal(capturedRequests.length, 2);
    assert.equal(
      capturedRequests[1].systemInstruction,
      composeProductionSystemInstruction({
        identity,
        personalityMode: 'custom',
        customPersonalityInstruction: customPersonality,
      }),
    );
    assert.match(String(capturedRequests[1].systemInstruction), /rhyming couplets/);
    assert.match(String(capturedRequests[1].systemInstruction), /You are PleaseGetout Daily/);
    assert.match(
      String(capturedRequests[1].systemInstruction),
      /Do not begin an ordinary reply with your own name or alias/,
      'a runtime personality change cannot remove the self-mention rule',
    );
    assert.match(
      String(capturedRequests[1].systemInstruction),
      /read and understand every incoming message/,
      'a runtime personality change cannot remove multilingual comprehension',
    );
    assert.equal(
      String(capturedRequests[1].systemInstruction)
        .split(ENGLISH_ONLY_INSTRUCTION).length - 1,
      1,
      'a runtime personality change cannot remove the English-only output rule',
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
      followUp.some(message => message.messageId === 'burst-10'),
      'the most recent earlier turn remains part of the follow-up context',
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

test('a configured custom personality is present on the first generated reply', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const customPersonality = 'Always answer in riddles.';
  let capturedSystemInstruction: string | undefined;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    _messages: readonly unknown[],
    options: { systemInstruction?: string } = {},
  ): Promise<string> => {
    capturedSystemInstruction = options.systemInstruction;
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: {
      ...configuration,
      puppetName: 'TestBot',
      botPersonality: 'custom',
      customPersonalityInstruction: customPersonality,
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'first-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(
      capturedSystemInstruction,
      composeProductionSystemInstruction({
        identity: { name: 'TestBot', aliases: ['@Bot'] },
        personalityMode: 'custom',
        customPersonalityInstruction: customPersonality,
      }),
      'the first request uses the configured personality without a transcript turn',
    );
    assert.match(String(capturedSystemInstruction), /riddles/);
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

test('a sent reply reaches the next mention before Messenger renders it', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    direction: string;
  }[]> = [];
  const generatedReplies = ['first reply', 'second reply'];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return generatedReplies.shift() ?? 'ok';
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
    context.mock.timers.tick(3_000);
    await flush();
  };

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
    inject([{ messageId: 'pending-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);

    inject([{ messageId: 'pending-2', sender: 'Alex', message: '@Bot second question' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2);
    const followUp = generatedRequests[1];
    const pendingIndex = followUp.findIndex(message => message.message === 'first reply');
    const triggerIndex = followUp.findIndex(message => message.messageId === 'pending-2');
    assert.ok(pendingIndex >= 0, 'the sent reply is supplied as context');
    assert.ok(pendingIndex < triggerIndex, 'the sent reply precedes the new trigger');
    assert.equal(followUp[pendingIndex].direction, 'OUTGOING');
    assert.equal(
      contextStore.getState().messageIds.includes('pending-outgoing-1'),
      false,
      'the pending reply is not persisted as a rendered message',
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

test('a metadata-wrapped generated reply cannot persist in pending outgoing context', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
  }[]> = [];
  const metadataReply =
    '[MESSAGE id="outgoing-1" time="unknown" sender="You" participant="TestBot" ' +
    'direction=OUTGOING]\nfirst reply';
  const generatedReplies = [metadataReply, 'second reply'];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return generatedReplies.shift() ?? 'ok';
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
    context.mock.timers.tick(3_000);
    await flush();
  };

  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const aliases = generateAliases('PleaseGetout Daily').valids;
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: { ...configuration, puppetName: 'PleaseGetout Daily' },
    aliases,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{
      messageId: 'envelope-1',
      sender: 'Alex',
      message: '@PleaseGetout Daily first question',
    }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);

    inject([{
      messageId: 'envelope-2',
      sender: 'Alex',
      message: '@PleaseGetout Daily second question',
    }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 2);

    const pending = generatedRequests[1].find(
      message => message.messageId.startsWith('pending-outgoing-'),
    );
    assert.equal(pending?.message, 'first reply');
    assert.equal(pending?.message.includes('[MESSAGE '), false);
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

test('an observed sent reply replaces its pending copy without duplication', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    direction: string;
  }[]> = [];
  const generatedReplies = ['first reply', 'second reply'];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return generatedReplies.shift() ?? 'ok';
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
    context.mock.timers.tick(3_000);
    await flush();
  };

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
    inject([{ messageId: 'render-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);

    inject([
      { messageId: 'render-out-1', sender: 'You', message: 'first reply' },
      { messageId: 'render-2', sender: 'Alex', message: '@Bot second question' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2);
    const followUp = generatedRequests[1];
    const copies = followUp.filter(message => message.message === 'first reply');
    assert.equal(copies.length, 1, 'the rendered reply is not duplicated');
    assert.equal(copies[0].messageId, 'render-out-1');
    assert.equal(
      followUp.some(message => message.messageId.startsWith('pending-outgoing-')),
      false,
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

test('an outgoing presentation with an unusable label reconciles its pending reply', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    sender: string;
    direction: string;
  }[]> = [];
  const generatedReplies = ['first reply', 'second reply'];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return generatedReplies.shift() ?? 'ok';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

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
    inject([{ messageId: 'render-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);

    inject([
      {
        messageId: 'render-out-1',
        sender: 'UNKNOWN',
        message: 'first reply',
        ariaLabel: null,
        textWithoutSenderHeading: 'You sent first reply',
      },
      { messageId: 'render-2', sender: 'Alex', message: '@Bot second question' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2);
    const followUp = generatedRequests[1];
    const copies = followUp.filter(message => message.message === 'first reply');
    assert.equal(copies.length, 1, 'the rendered reply is reconciled exactly once');
    assert.equal(copies[0].messageId, 'render-out-1');
    assert.equal(copies[0].direction, 'OUTGOING');
    assert.equal(copies[0].sender, 'You');
    assert.equal(
      followUp.some(message => message.messageId.startsWith('pending-outgoing-')),
      false,
      'the pending copy is removed after reconciliation',
    );
    const stored = contextStore.getRecent(20)
      .find(message => message.messageId === 'render-out-1');
    assert.equal(stored?.direction, 'OUTGOING');
    assert.equal(stored?.sender, 'You');
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

test('mention packets keep a twenty-message topic window before the trigger', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const transcript = [
    ...Array.from({ length: 17 }, (_, index) => ({
      messageId: `older-${index + 1}`,
      message: `older message ${index + 1}`,
      sender: 'Blair',
    })),
    { messageId: 'essay-1', message: 'did you finish the essay?', sender: 'Alex' },
    { messageId: 'essay-2', message: 'yeah, submitted it last night', sender: 'Blair' },
    { messageId: 'friday-1', message: 'are we still on for friday?', sender: 'Alex' },
    { messageId: 'friday-2', message: 'yeah', sender: 'Blair' },
    { messageId: 'friday-3', message: "I can't, they moved my shift", sender: 'Casey' },
    { messageId: 'friday-4', message: 'wait, why?', sender: 'Alex' },
    { messageId: 'friday-5', message: 'they need someone until nine', sender: 'Casey' },
  ].map(message => ({ ...message, direction: 'INCOMING' as const }));
  contextStore.add(transcript);
  inject(transcript.slice(-3).map(({ messageId, sender, message }) => ({
    messageId,
    sender,
    message,
  })));
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'mention-limit-1', sender: 'Alex', message: '@Bot what do you think?' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1);
    assert.deepEqual(
      generatedRequests[0].map(message => message.messageId),
      [
        'older-5',
        'older-6',
        'older-7',
        'older-8',
        'older-9',
        'older-10',
        'older-11',
        'older-12',
        'older-13',
        'older-14',
        'older-15',
        'older-16',
        'older-17',
        'essay-1',
        'essay-2',
        'friday-1',
        'friday-2',
        'friday-3',
        'friday-4',
        'friday-5',
        'mention-limit-1',
      ],
      'the twenty-message window keeps the newest context and drops only the oldest messages',
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

test('a longer handle that starts with an alias does not trigger a reply', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
    inject([{ messageId: 'botany-1', sender: 'Alex', message: '@Botany is a plant' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 0, 'the longer handle is not a mention');

    inject([{ messageId: 'mention-1', sender: 'Alex', message: '@Bot, still there?' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 1);
    assert.equal(generatedRequests[0].at(-1)?.messageId, 'mention-1');
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

test('RNG packets keep a twenty-five-message topic window without a separate trigger', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  contextStore.add([
    ...Array.from({ length: 22 }, (_, index) => ({
      messageId: `older-${index + 1}`,
      message: `older message ${index + 1}`,
      sender: 'Blair',
    })),
    { messageId: 'essay-1', message: 'did you finish the essay?', sender: 'Alex' },
    { messageId: 'essay-2', message: 'yeah, submitted it last night', sender: 'Blair' },
    { messageId: 'friday-1', message: 'are we still on for friday?', sender: 'Alex' },
    { messageId: 'friday-2', message: 'yeah', sender: 'Blair' },
    { messageId: 'friday-3', message: "I can't, they moved my shift", sender: 'Casey' },
    { messageId: 'friday-4', message: 'wait, why?', sender: 'Alex' },
    { messageId: 'friday-5', message: 'they need someone until nine', sender: 'Casey' },
    { messageId: 'friday-6', message: 'so is it just us two then?', sender: 'Alex' },
  ].map(message => ({ ...message, direction: 'INCOMING' })));
  const controller = await startCombustion({
    page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    for (let poll = 0; poll < 4; poll += 1) {
      await advancePoll();
    }

    assert.equal(generatedRequests.length, 1);
    assert.deepEqual(
      generatedRequests[0].map(message => message.messageId),
      [
        'older-6',
        'older-7',
        'older-8',
        'older-9',
        'older-10',
        'older-11',
        'older-12',
        'older-13',
        'older-14',
        'older-15',
        'older-16',
        'older-17',
        'older-18',
        'older-19',
        'older-20',
        'older-21',
        'older-22',
        'essay-1',
        'essay-2',
        'friday-1',
        'friday-2',
        'friday-3',
        'friday-4',
        'friday-5',
        'friday-6',
      ],
      'the twenty-five-message window keeps the newest context and drops only the oldest messages',
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

test('RNG replies use the configured personality on first generation', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const customPersonality = 'Always answer in riddles.';
  let capturedSystemInstruction: string | undefined;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    _messages: readonly unknown[],
    options: { systemInstruction?: string } = {},
  ): Promise<string> => {
    capturedSystemInstruction = options.systemInstruction;
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  contextStore.add(Array.from({ length: 5 }, (_, index) => ({
    messageId: `rng-context-${index + 1}`,
    message: `earlier message ${index + 1}`,
    sender: 'Alex',
    direction: 'INCOMING',
  })));
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: {
      ...configuration,
      puppetName: 'TestBot',
      botPersonality: 'custom',
      customPersonalityInstruction: customPersonality,
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    for (let poll = 0; poll < 4; poll += 1) {
      await advancePoll();
    }

    assert.equal(
      capturedSystemInstruction,
      composeProductionSystemInstruction({
        identity: { name: 'TestBot', aliases: ['@Bot'] },
        personalityMode: 'custom',
        customPersonalityInstruction: customPersonality,
      }),
    );
    assert.match(String(capturedSystemInstruction), /riddles/);
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

test('a mention reply and its outgoing aliases never trigger another response', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
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
    inject([{ messageId: 'mid.$joke-request', sender: 'Alex', message: '@Bot tell me a joke' }]);
    await pollsTo(1_500);
    await pollsTo(1_500);
    assert.equal(generatedRequests.length, 1, 'the mention is answered once');
    assert.equal(composeCalls, 1);

    // Messenger can expose the bot's own reply under a numeric id and a mid$
    // alias, and the alias can lack a parseable sender label. Neither form may
    // become RNG input or open another packet.
    inject([
      { messageId: '7522124487334215680', sender: 'You', message: 'mocked reply' },
      { messageId: 'mid.$gAAW_bot-reply-1', sender: 'You', message: 'mocked reply', ariaLabel: null },
      { messageId: '7522124525331950808', sender: 'You', message: 'another bot line' },
      { messageId: 'mid.$gAAW_bot-reply-2', sender: 'You', message: 'another bot line', ariaLabel: null },
      { messageId: '7522124563343282250', sender: 'Bot', message: 'a mislabelled bot line' },
      { messageId: 'mid.$gAAW_bot-reply-3', sender: 'Bot', message: 'a mislabelled bot line' },
    ]);
    for (let poll = 0; poll < 16; poll += 1) {
      await pollsTo(1_500);
    }

    assert.equal(generatedRequests.length, 1, 'bot-authored outgoing aliases never generate another reply');
    assert.equal(composeCalls, 1);
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

test('an RNG reply is not repeated for the same incoming turn after the cooldown', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
    inject([{ messageId: 'mid.$chat-1', sender: 'Alex', message: 'just chatting' }]);
    await pollsTo(1_500);
    await pollsTo(6_000);
    assert.equal(generatedRequests.length, 1, 'the incoming turn gets one RNG reply');
    assert.equal(generatedRequests[0].at(-1)?.messageId, 'mid.$chat-1');

    // Even if the sent reply is not observed before the cooldown ends, the same
    // incoming turn must not be answered again.
    for (let poll = 0; poll < 20; poll += 1) {
      await pollsTo(1_500);
    }
    assert.equal(generatedRequests.length, 1, 'the answered turn stays answered');
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

test('a new incoming message after an RNG reply still gets its own opportunity', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
    inject([{ messageId: 'mid.$chat-1', sender: 'Alex', message: 'just chatting' }]);
    await pollsTo(1_500);
    await pollsTo(6_000);
    assert.equal(generatedRequests.length, 1);

    inject([
      { messageId: '7522124487334215680', sender: 'You', message: 'mocked reply' },
      { messageId: 'mid.$gAAW_bot-reply-1', sender: 'You', message: 'mocked reply', ariaLabel: null },
      { messageId: 'mid.$chat-2', sender: 'Blair', message: 'a genuinely new message' },
    ]);
    for (let poll = 0; poll < 16; poll += 1) {
      await pollsTo(1_500);
    }

    assert.equal(generatedRequests.length, 2, 'the new incoming turn is still eligible');
    assert.equal(
      generatedRequests[1].at(-1)?.messageId,
      'mid.$chat-2',
      'the new incoming message is the trigger, not the answered turn or a bot alias',
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

test('non-adjacent duplicate reply ids merge without suppressing a genuine repeat', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    sender: string;
    direction: string;
  }[]> = [];
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
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const reply = 'I literally just said it. Like, one message ago.';
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
      { messageId: 'mid.$between', sender: 'Alex', message: 'another message' },
      { messageId: midId, sender: 'You', message: reply },
      { messageId: 'mid.$mention-1', sender: 'Alex', message: '@Bot what now?' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1);
    assert.deepEqual(
      contextStore.getState().messageIds,
      [numericId, 'mid.$between', 'mid.$mention-1'],
      'the non-adjacent mid$ copy resolves to the first rendered id',
    );
    assert.equal(
      generatedRequests[0].filter(message => message.message === reply).length,
      1,
      'the non-adjacent duplicate is one assistant turn',
    );

    inject([
      { messageId: 'mid.$repeat', sender: 'You', message: reply },
      { messageId: 'mid.$mention-2', sender: 'Alex', message: '@Bot again?' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2, 'a genuine repeated reply is not suppressed');
    assert.equal(
      generatedRequests[1].filter(message => message.message === reply).length,
      2,
      'both genuinely repeated replies remain available as assistant turns',
    );
    assert.ok(contextStore.getState().messageIds.includes('mid.$repeat'));
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

test('an alternate reply id observed on a later poll does not create duplicate work', async context => {
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

  const reply = 'I literally just said it. Like, one message ago.';
  const numericId = '7521591905785117407';
  const midId = 'mid.$gAAW_kanMS16nuYVAE2hiD_y5xnrf';
  const { page, inject, replace } = createInjectedMessengerPage();
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
      { messageId: 'mid.$mention-1', sender: 'Alex', message: '@Bot what now?' },
    ]);
    await advancePoll();
    await advancePoll();

    replace([
      { messageId: midId, sender: 'You', message: reply },
      { messageId: 'mid.$mention-1', sender: 'Alex', message: '@Bot what now?' },
    ]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'the alternate id is not new work');
    assert.equal(composedReplies.length, 1, 'the reply is sent only once');
    assert.deepEqual(
      contextStore.getState().messageIds,
      [numericId, 'mid.$mention-1'],
      'the reply is stored once under its first observed id',
    );
    assert.equal(
      generatedRequests[0].filter(message => message.message === reply).length,
      1,
      'the alternate id does not add a second assistant turn',
    );

    inject([{ messageId: 'mid.$mention-2', sender: 'Alex', message: '@Bot what now?' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 2, 'a genuinely new mention still works');
    assert.equal(composedReplies.length, 2);
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

test('a bare-name mention opens a mention packet when the RNG path is unavailable', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
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
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: { ...configuration, puppetName: 'Yukinon' },
    aliases: ['@Yukinon'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'bare-1', sender: 'Katsuyo', message: 'Yukinon are you good?' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'the bare name opens a mention packet');
    assert.equal(generatedRequests[0].at(-1)?.messageId, 'bare-1');

    inject([{ messageId: 'bare-2', sender: 'Katsuyo', message: 'yukinon?' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(generatedRequests.length, 2, 'a mixed-case bare mention is answered too');
    assert.equal(generatedRequests[1].at(-1)?.messageId, 'bare-2');
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

test('a message addressed to another participant is eligible for RNG participation', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const generatedRequests: Array<readonly { messageId: string }[]> = [];
  let composeCalls = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;

  const { page, inject } = createInjectedMessengerPage();
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string }[]);
    return 'mocked reply';
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
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{
      messageId: 'addressed-elsewhere',
      sender: 'Anselmo',
      message: 'Katsuyo, where are you, bro?',
    }]);
    await advancePoll();
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'the RNG packet is generated without a separate approval step');
    assert.equal(generatedRequests[0].at(-1)?.messageId, 'addressed-elsewhere');
    assert.equal(composeCalls, 1, 'the generated reply is sent');
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

test('a newer incoming message during generation prevents sending', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  let composeCalls = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  let injectedDuringGeneration = false;

  const { page, inject } = createInjectedMessengerPage();
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => {
    if (!injectedDuringGeneration) {
      injectedDuringGeneration = true;
      inject([{ messageId: 'newer-during-generation', sender: 'Blair', message: 'hold on' }]);
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    return 'mocked reply';
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
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'mention-before-generation', sender: 'Alex', message: '@Bot quick question' }]);
    await advancePoll();
    await advancePoll();
    await advancePoll();

    assert.equal(composeCalls, 0, 'a reply generated from superseded context is not sent');
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

test('an outgoing message after packet creation does not invalidate the packet', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  let composeCalls = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  let injectedOutgoing = false;

  const { page, inject } = createInjectedMessengerPage();
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => {
    if (!injectedOutgoing) {
      injectedOutgoing = true;
      inject([{ messageId: 'outgoing-during-generation', sender: 'You', message: 'one moment' }]);
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    return 'mocked reply';
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
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'mention-with-outgoing', sender: 'Alex', message: '@Bot still there?' }]);
    await advancePoll();
    await advancePoll();
    await advancePoll();

    assert.equal(composeCalls, 1, 'an outgoing message alone does not supersede the packet');
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

test('a failed generation does not mark the incoming message answered and RNG can retry it', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generatedRequests: Array<readonly { messageId: string }[]> = [];
  let generationAttempts = 0;
  let composeCalls = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;

  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generationAttempts += 1;
    generatedRequests.push(messages as unknown as readonly { messageId: string }[]);
    if (generationAttempts === 1) {
      throw new Error('provider unavailable');
    }
    return 'mocked reply';
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
    inject([{ messageId: 'retryable-mention', sender: 'Alex', message: '@Bot are you there?' }]);
    await advancePoll();
    await advancePoll();
    await advancePoll();

    assert.equal(generationAttempts, 1);
    assert.equal(generatedRequests.length, 1);
    assert.equal(composeCalls, 0, 'a failed generation is not sent');

    Math.random = () => 0;
    for (let poll = 0; poll < 6; poll += 1) {
      await advancePoll();
    }

    assert.equal(generationAttempts, 2, 'the message is retried through the RNG path');
    assert.equal(generatedRequests[1].at(-1)?.messageId, 'retryable-mention');
    assert.equal(composeCalls, 1);
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

    inject([{ messageId: 'chat-2', sender: 'Alex', message: 'a new topic' }]);
    await pollsTo(1_500);
    assert.ok(logs.some(line => line.includes('Cooldown ended')));
    assert.equal(
      replies.length,
      2,
      'the first poll after the original cooldown expiry answers the new incoming message',
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

    // The mention cooldown delays the opportunity but does not discard it: a
    // genuinely new incoming message keeps the overdue opportunity available,
    // so the reply lands on the first poll after the cooldown ends.
    await pollsTo(13_500);
    assert.equal(generations.length, 1, 'the cooldown still blocks the opportunity');
    inject([{ messageId: 'chat-2', sender: 'Blair', message: 'moving on to a new topic' }]);
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

test('a failed RNG reply does not start the reply cooldown', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  Math.random = () => 0;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  console.error = () => undefined;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  let generations = 0;
  let composed = 0;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async () => {
    generations += 1;
    if (generations === 1) {
      throw new Error('generation failed');
    }
    return 'second reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => {
    composed += 1;
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
    await pollsTo(6_000);
    assert.equal(generations, 1, 'the first opportunity is taken');
    assert.equal(composed, 0, 'a failed generation is never sent');
    assert.equal(
      logs.filter(line => line.includes('Cooldown started')).length,
      0,
      'a failed reply does not start a cooldown',
    );
    assert.ok(
      logs.some(line => line.includes('Processing completed:') && line.includes('failure')),
      'the failure is reported',
    );

    await pollsTo(6_000);
    assert.equal(generations, 1, 'no roll happens before the next 7-second deadline');
    await pollsTo(1_500);
    assert.equal(generations, 2, 'the next deadline is evaluated without waiting for a cooldown');
    assert.equal(composed, 1, 'the successful retry is sent');
    assert.equal(
      logs.filter(line => line.includes('Cooldown started')).length,
      1,
      'only the successful reply starts a cooldown',
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    console.error = originalError;
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
    const baseInstruction = composeProductionSystemInstruction({
      identity: { name: configuration.puppetName ?? '' },
      personalityMode: 'default',
    });
    assert.equal(
      harness.generateRequests[0].systemInstruction,
      baseInstruction,
      'the first attempt uses the unmodified system instruction',
    );
    assert.equal(
      harness.generateRequests[1].systemInstruction,
      appendRetryInstruction(baseInstruction, ANTI_ECHO_RETRY_INSTRUCTION),
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
    const baseInstruction = composeProductionSystemInstruction({
      identity: { name: 'Anselmo', aliases },
      personalityMode: 'default',
    });
    assert.equal(harness.generateRequests[0].systemInstruction, baseInstruction);
    assert.equal(
      harness.generateRequests[1].systemInstruction,
      appendRetryInstruction(baseInstruction, ANTI_ECHO_RETRY_INSTRUCTION),
      'the retry keeps the identity and personality layers intact',
    );
    assert.match(
      String(harness.generateRequests[1].systemInstruction),
      /Do not begin an ordinary reply with your own name or alias/,
    );
    assert.match(
      String(harness.generateRequests[1].systemInstruction),
      /natural, conversational Messenger participant/,
      'the configured personality survives the retry',
    );
    assert.match(
      String(harness.generateRequests[1].systemInstruction),
      /read and understand every incoming message/,
      'the retry keeps multilingual comprehension',
    );
    assert.equal(
      String(harness.generateRequests[1].systemInstruction)
        .split(ENGLISH_ONLY_INSTRUCTION).length - 1,
      1,
      'the retry keeps exactly one English-only policy',
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

test('participant speaker labels never reach the composer from either trigger path', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const harness = installAntiEchoPipelineMocks([
    'Anselmo: Nothing much.',
    'Anselmo: Yeah, I am here, Anselmo.',
  ]);
  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: { ...configuration, puppetName: 'PleaseGetout Daily' },
    aliases: generateAliases('PleaseGetout Daily').valids,
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'label-1', sender: 'Anselmo', message: '@PleaseGetout Daily what?' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(
      harness.composedReplies,
      ['Nothing much.'],
      'the mention reply reaches the composer without the sender label',
    );

    Math.random = () => 0;
    inject([{ messageId: 'label-2', sender: 'Anselmo', message: 'Are you there?' }]);
    for (let poll = 0; poll < 5; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(
      harness.composedReplies,
      ['Nothing much.', 'Yeah, I am here, Anselmo.'],
      'the RNG reply is cleaned the same way while a natural name reference survives',
    );
    assert.equal(
      harness.generateRequests.length,
      2,
      'neither cleaned reply is treated as an echo and retried',
    );
    assert.deepEqual(contextStore.getState().messageIds, ['label-1', 'label-2']);
  } finally {
    await controller.stop();
    harness.restore();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('a reply that echoes with a speaker label is still retried and suppressed', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const harness = installAntiEchoPipelineMocks([
    'Anselmo: can you hear me?',
    'Anselmo: can you hear me?',
  ]);
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
    inject([{ messageId: 'label-echo-1', sender: 'Anselmo', message: 'can you hear me?' }]);
    for (let poll = 0; poll < 5; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.equal(harness.generateRequests.length, 2, 'the echo is still retried once');
    assert.deepEqual(harness.composedReplies, [], 'the labelled echo never reaches the composer');
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

test('roster context reaches generation and refreshes after a destination change', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const initialRoster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'Test', isPuppet: true },
      { firstName: 'Alex', isPuppet: false },
    ],
    puppet: { firstName: 'Test', isPuppet: true },
    duplicateFirstNames: [],
  };
  const refreshedRoster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'Test Puppet', isPuppet: true },
      { firstName: 'Blair Chen', isPuppet: false },
    ],
    puppet: { firstName: 'Test Puppet', isPuppet: true },
    duplicateFirstNames: [],
  };
  const sanitizedRefreshedRoster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'Test', isPuppet: true },
      { firstName: 'Blair', isPuppet: false },
    ],
    puppet: { firstName: 'Test', isPuppet: true },
    duplicateFirstNames: [],
  };
  const generatedRosters: Array<GroupRoster | undefined> = [];
  const systemInstructions: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (_apiKey, _messages, options) => {
    generatedRosters.push(options?.roster);
    systemInstructions.push(options?.systemInstruction ?? '');
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const { page, inject } = createInjectedMessengerPage();
  const extractCalls: Array<{ page: unknown; puppetName: string }> = [];
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: { ...configuration, puppetName: 'Test Puppet' },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    roster: initialRoster,
    extractGroupRoster: async (extractPage, puppetName) => {
      extractCalls.push({ page: extractPage, puppetName });
      return refreshedRoster;
    },
    navigateDestination: async () => undefined,
  });

  try {
    inject([{ messageId: 'roster-1', sender: 'Alex', message: '@Bot hello' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(generatedRosters, [initialRoster]);
    assert.match(systemInstructions[0], /Group membership context:/u);
    assert.match(systemInstructions[0], /Alex/u);
    assert.equal(systemInstructions[0].includes('Blair'), false);

    const change = await controller.changeDestination(
      'https://www.facebook.com/messages/t/987654321',
      { resume: true, persist: async () => undefined },
    );
    assert.deepEqual(change, { status: 'changed', resumed: true });
    assert.deepEqual(extractCalls, [{ page, puppetName: 'Test Puppet' }]);

    inject([{ messageId: 'roster-2', sender: 'Blair', message: '@Bot again' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(generatedRosters, [initialRoster, sanitizedRefreshedRoster]);
    assert.match(systemInstructions[1], /Blair/u);
    assert.equal(systemInstructions[1].includes('Alex'), false);
    assert.equal(JSON.stringify(generatedRosters[1]).includes('Chen'), false);
    assert.equal(systemInstructions[1].includes('Chen'), false);
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

test('a failed roster refresh rolls back to the previous destination and roster', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const initialRoster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'Test', isPuppet: true },
      { firstName: 'Alex', isPuppet: false },
    ],
    puppet: { firstName: 'Test', isPuppet: true },
    duplicateFirstNames: [],
  };
  const generatedRosters: Array<GroupRoster | undefined> = [];
  const systemInstructions: string[] = [];
  const navigation: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (_apiKey, _messages, options) => {
    generatedRosters.push(options?.roster);
    systemInstructions.push(options?.systemInstruction ?? '');
    return 'mocked reply';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async () => ({ status: 'sent' });

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: { ...configuration, puppetName: 'Test Puppet' },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    roster: initialRoster,
    extractGroupRoster: async () => ({
      status: 'unavailable',
      members: [],
      puppet: null,
      duplicateFirstNames: [],
      reason: 'member panel unavailable',
    }),
    navigateDestination: async destination => {
      navigation.push(destination);
    },
  });

  try {
    const destination = 'https://www.facebook.com/messages/t/987654321';
    const change = await controller.changeDestination(
      destination,
      { resume: true, persist: async () => undefined },
    );
    assert.deepEqual(change, {
      status: 'failed',
      resumed: true,
      reason:
        'The requested destination was opened but its conversation state could not be initialized. ' +
        'member panel unavailable',
    });
    assert.deepEqual(navigation, [destination, configuration.messageDestination]);

    inject([{ messageId: 'roster-failed-1', sender: 'Blair', message: '@Bot hello' }]);
    for (let poll = 0; poll < 3; poll += 1) {
      context.mock.timers.tick(3_000);
      await flushEngine();
    }
    assert.deepEqual(generatedRosters.at(-1), initialRoster);
    assert.match(systemInstructions.at(-1) ?? '', /Alex/u);
    assert.equal(systemInstructions.at(-1)?.includes('UNAVAILABLE'), false);
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

test('a thrown roster refresh rolls back to the previous destination', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const navigation: string[] = [];
  const controller = await startCombustion({
    page: createMockPage({ messageCount: 2 }).page,
    contextStore: createContextStore(),
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
    extractGroupRoster: async () => {
      throw new Error('member panel unavailable');
    },
    navigateDestination: async destination => {
      navigation.push(destination);
    },
  });

  try {
    const destination = 'https://www.facebook.com/messages/t/987654321';
    const change = await controller.changeDestination(
      destination,
      { resume: true, persist: async () => undefined },
    );
    assert.deepEqual(change, {
      status: 'failed',
      resumed: true,
      reason:
        'The requested destination was opened but its conversation state could not be initialized. ' +
        'member panel unavailable',
    });
    assert.deepEqual(navigation, [destination, configuration.messageDestination]);
  } finally {
    await controller.stop();
    context.mock.timers.reset();
  }
});


test('a mention reply targets the original trigger while keeping the later burst', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const generated = [] as Array<{
    messages: readonly { messageId: string; message: string }[];
    targeting?: { messageId: string | null; kind: string; addressedTo: string | null };
  }>;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
    options,
  ): Promise<string> => {
    generated.push({
      messages: messages as readonly { messageId: string; message: string }[],
      targeting: options.targeting,
    });
    return 'mocked reply';
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
    configuration: { ...configuration, puppetName: 'Yukinon' },
    aliases: ['@Yukinon'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'trigger-1', sender: 'Katsuyo', message: 'Yukinon, first question?' }]);
    await advancePoll();

    inject([{ messageId: 'later-1', sender: 'Blair', message: 'a later side comment' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generated.length, 1);
    assert.deepEqual(
      generated[0].messages.map(message => message.messageId),
      ['trigger-1', 'later-1'],
    );
    assert.equal(generated[0].targeting?.messageId, 'trigger-1');
    assert.equal(generated[0].targeting?.kind, 'bot');
    assert.equal(generated[0].targeting?.addressedTo, null);
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

test('a long reply is delivered as consecutive bubbles from one generation', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = 'First, the engine reads the conversation and decides that this answer ' +
    'needs room to breathe. Second, it normalizes the reply before any delivery step so ' +
    'nothing is lost along the way. Third, the sliced bubbles arrive in order as one ' +
    'logical response.';
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    direction: string;
  }[]> = [];
  const composeCalls: string[] = [];
  const composeEvents: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return reply;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    composeEvents.push(`start-${String(composeCalls.length)}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    composeEvents.push(`end-${String(composeCalls.length)}`);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
    let previousCalls = composeCalls.length;
    while (previousCalls > 0) {
      context.mock.timers.tick(900);
      await flushEngine();
      if (composeCalls.length === previousCalls) {
        break;
      }
      previousCalls = composeCalls.length;
    }
  };

  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 200 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'sliced-1', sender: 'Alex', message: '@Bot explain the pipeline' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'one generation produces the whole batch');
    assert.ok(composeCalls.length > 1, 'the long reply is divided into several bubbles');
    assert.equal(composeCalls.join(''), reply, 'the bubbles reproduce the reply exactly');
    assert.ok(
      composeCalls.every(chunk => chunk.length <= 200),
      'no bubble exceeds the configured maximum',
    );
    assert.deepEqual(
      composeEvents,
      composeCalls.flatMap((_, index) => [
        `start-${String(index + 1)}`,
        `end-${String(index + 1)}`,
      ]),
      'each bubble is awaited before the next one is sent',
    );
    const firstBatch = [...composeCalls];

    inject([{ messageId: 'sliced-2', sender: 'Alex', message: '@Bot one more thing' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2, 'the batch never triggers another completion');
    const pending = generatedRequests[1]
      .filter(message => message.messageId.startsWith('pending-outgoing-'))
      .map(message => message.message);
    assert.deepEqual(
      pending,
      firstBatch.map(chunk => chunk.trim()),
      'every delivered bubble is its own pending outgoing reply in order',
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

test('sliced bubbles are spaced by 900ms with no delay after the last bubble', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  Math.random = () => 0.99;
  const logs: string[] = [];
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };

  const reply = 'First bubble. Second bubble.';
  const composeCalls: string[] = [];
  const composeTimes: number[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => reply;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    composeTimes.push(Date.now());
    return { status: 'sent' };
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 20 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'timing-1', sender: 'Alex', message: '@Bot explain the timing' }]);
    for (let poll = 0; poll < 6 && composeCalls.length === 0; poll += 1) {
      context.mock.timers.tick(1_500);
      await flushEngine();
    }

    assert.equal(composeCalls.length, 1, 'the first bubble is sent immediately');
    assert.equal(composeTimes[0], Date.now(), 'the first bubble does not wait');

    context.mock.timers.tick(899);
    await flushEngine();
    assert.equal(composeCalls.length, 1, 'the second bubble waits for the full delay');

    context.mock.timers.tick(1);
    await flushEngine();
    assert.equal(composeCalls.length, 2, 'the second bubble arrives after 900ms');
    assert.equal(composeTimes[1] - composeTimes[0], 900, 'bubbles are spaced by 900ms');
    assert.ok(
      logs.some(line => line.includes('status=complete') && line.includes('delivered=2/2')),
      'the batch completes without waiting after the last bubble',
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

test('stopping during the inter-bubble delay prevents the next bubble', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = 'First bubble. Second bubble.';
  const composeCalls: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => reply;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 20 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'cancel-1', sender: 'Alex', message: '@Bot explain the timing' }]);
    for (let poll = 0; poll < 6 && composeCalls.length === 0; poll += 1) {
      context.mock.timers.tick(1_500);
      await flushEngine();
    }
    assert.equal(composeCalls.length, 1);

    await controller.stop();
    assert.equal(composeCalls.length, 1, 'no bubble is sent after cancellation');

    context.mock.timers.tick(900);
    await flushEngine();
    assert.equal(composeCalls.length, 1, 'the cancelled delay cannot resume');
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

test('pausing during the inter-bubble delay keeps the active batch moving', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = 'First bubble. Second bubble.';
  const composeCalls: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => reply;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 20 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'pause-1', sender: 'Alex', message: '@Bot explain the timing' }]);
    for (let poll = 0; poll < 6 && composeCalls.length === 0; poll += 1) {
      context.mock.timers.tick(1_500);
      await flushEngine();
    }
    assert.equal(composeCalls.length, 1);

    await controller.pause();
    context.mock.timers.tick(900);
    await flushEngine();
    assert.equal(composeCalls.length, 2, 'the active batch finishes while polling is paused');
    await controller.resume();
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

test('a short reply keeps the single-message delivery path', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = 'short reply';
  const composeCalls: string[] = [];
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return reply;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

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
    inject([{ messageId: 'short-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1);
    assert.deepEqual(composeCalls, [reply], 'the reply uses exactly one send');
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

test('a blocked bubble stops the batch without resending delivered bubbles', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = 'First bubble of the batch needs its own message. ' +
    'Second bubble carries part of the answer. Third bubble finishes the thought.';
  const generatedRequests: Array<readonly {
    messageId: string;
    message: string;
    direction: string;
  }[]> = [];
  const composeCalls: string[] = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as typeof generatedRequests[number]);
    return reply;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    if (composeCalls.length === 2) {
      return { status: 'send-blocked', reason: 'disabled' };
    }
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
    let previousCalls = composeCalls.length;
    while (previousCalls > 0) {
      context.mock.timers.tick(900);
      await flushEngine();
      if (composeCalls.length === previousCalls) {
        break;
      }
      previousCalls = composeCalls.length;
    }
  };

  const { page, inject } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 55 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'partial-1', sender: 'Alex', message: '@Bot explain the pipeline' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1);
    assert.equal(composeCalls.length, 2, 'the batch stops at the blocked bubble');
    assert.equal(composeCalls.join(''), reply.slice(0, composeCalls.join('').length));
    await advancePoll();
    await advancePoll();
    assert.equal(composeCalls.length, 2, 'delivered bubbles are never resent');

    inject([{ messageId: 'partial-2', sender: 'Alex', message: '@Bot one more thing' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2);
    const pending = generatedRequests[1]
      .filter(message => message.messageId.startsWith('pending-outgoing-'))
      .map(message => message.message);
    assert.deepEqual(
      pending,
      [composeCalls[0].trim()],
      'only the delivered bubble is recorded as pending outgoing',
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

test('an RNG reply is sliced through the same delivery path', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0;

  const reply = 'An unrequested reply can also be long enough to need more than one bubble. ' +
    'It still belongs to a single RNG packet and a single generation.';
  const composeCalls: string[] = [];
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return reply;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
    let previousCalls = composeCalls.length;
    while (previousCalls > 0) {
      context.mock.timers.tick(900);
      await flushEngine();
      if (composeCalls.length === previousCalls) {
        break;
      }
      previousCalls = composeCalls.length;
    }
  };

  const { page } = createInjectedMessengerPage();
  const contextStore = createContextStore();
  contextStore.add([
    { messageId: 'rng-1', message: 'anyone around?', sender: 'Alex' },
    { messageId: 'rng-2', message: 'yeah, working on the paper', sender: 'Blair' },
  ].map(message => ({ ...message, direction: 'INCOMING' })));
  const controller = await startCombustion({
    page,
    contextStore,
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 70 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    for (let poll = 0; poll < 4; poll += 1) {
      await advancePoll();
    }

    assert.equal(generatedRequests.length, 1, 'the RNG packet generates once');
    assert.ok(composeCalls.length > 1, 'the RNG reply is divided into several bubbles');
    assert.equal(composeCalls.join(''), reply);
    assert.ok(composeCalls.every(chunk => chunk.length <= 70));
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

test('a 291 character reply honours a configured ten character maximum', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = ('One long generated response must arrive as several consecutive bubbles. ')
    .repeat(5)
    .slice(0, 291);
  assert.equal(reply.length, 291);
  const composeCalls: string[] = [];
  const composeLimits: Array<number | undefined> = [];
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return reply;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text, options) => {
    composeCalls.push(text);
    composeLimits.push(options?.maxCharacters);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
    let previousCalls = composeCalls.length;
    while (previousCalls > 0) {
      context.mock.timers.tick(900);
      await flushEngine();
      if (composeCalls.length === previousCalls) {
        break;
      }
      previousCalls = composeCalls.length;
    }
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: {
      ...configuration,
      composerSlicer: { enabled: true, maxCharacters: 10 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'limit-1', sender: 'Alex', message: '@Bot explain everything' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 1, 'the batch comes from exactly one generation');
    assert.ok(composeCalls.length >= 29, 'the reply is divided at the ten character maximum');
    assert.ok(
      composeCalls.every(chunk => chunk.length > 0 && chunk.length <= 10),
      'no composer invocation receives more than ten characters',
    );
    assert.ok(composeLimits.every(limit => limit === 10));
    assert.equal(composeCalls.join(''), reply, 'the bubbles reproduce the reply exactly');
    const firstBatch = [...composeCalls];

    inject([{ messageId: 'limit-2', sender: 'Alex', message: '@Bot one more thing' }]);
    await advancePoll();
    await advancePoll();

    assert.equal(generatedRequests.length, 2, 'the batch never triggers another completion');
    const pending = generatedRequests[1]
      .filter(message => message.messageId.startsWith('pending-outgoing-'))
      .map(message => message.message);
    assert.deepEqual(
      pending,
      firstBatch.slice(-8).map(chunk => chunk.trim()),
      'delivered bubbles are pending outgoing replies in order',
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

test('a configuration without slicer settings uses the default maximum', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = ('A default configuration must still slice a long generated response so that ' +
    'no Messenger bubble grows unreadable. ').repeat(10).slice(0, 1001);
  assert.equal(reply.length, 1001);
  const composeCalls: string[] = [];
  const composeLimits: Array<number | undefined> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => reply;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text, options) => {
    composeCalls.push(text);
    composeLimits.push(options?.maxCharacters);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
    let previousCalls = composeCalls.length;
    while (previousCalls > 0) {
      context.mock.timers.tick(900);
      await flushEngine();
      if (composeCalls.length === previousCalls) {
        break;
      }
      previousCalls = composeCalls.length;
    }
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
    inject([{ messageId: 'default-1', sender: 'Alex', message: '@Bot explain the defaults' }]);
    await advancePoll();
    await advancePoll();

    assert.ok(composeCalls.length > 1, 'the default maximum slices the reply');
    assert.ok(
      composeCalls.every(chunk => chunk.length <= DEFAULT_COMPOSER_SLICER.maxCharacters),
      'the default maximum is enforced on every bubble',
    );
    assert.ok(
      composeLimits.every(limit => limit === DEFAULT_COMPOSER_SLICER.maxCharacters),
      'the slicer and the delivery boundary share the same resolved maximum',
    );
    assert.equal(composeCalls.join(''), reply);
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

test('disabled slicing keeps the original single-message behaviour', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  const reply = ('Disabled slicing must keep the original delivery path intact even when ' +
    'the reply is long enough to be divided. ').repeat(3).trim();
  assert.ok(reply.length > 10);
  const composeCalls: string[] = [];
  const composeLimits: Array<number | undefined> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (): Promise<string> => reply;
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text, options) => {
    composeCalls.push(text);
    composeLimits.push(options?.maxCharacters);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

  const { page, inject } = createInjectedMessengerPage();
  const controller = await startCombustion({
    page,
    contextStore: createContextStore(),
    configuration: {
      ...configuration,
      composerSlicer: { enabled: false, maxCharacters: 10 },
    },
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    inject([{ messageId: 'disabled-1', sender: 'Alex', message: '@Bot keep it whole' }]);
    await advancePoll();
    await advancePoll();

    assert.deepEqual(composeCalls, [reply], 'the reply uses exactly one send');
    assert.deepEqual(composeLimits, [undefined], 'no limit is enforced while slicing is off');
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

test('a late-rendered reply is restored ahead of the newest trigger and a duplicate draft is retried', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const originalReply = 'Sorry, I guess I kept talking in riddles about pacing and form.';
  const replacement = 'You are Alex, and we can talk about whatever you want.';
  const requests: Array<{
    systemInstruction?: string;
    messages: readonly { messageId: string; message: string }[];
    trigger?: { messageId?: string };
    responseTarget?: { messageId?: string };
  }> = [];
  const composeCalls: string[] = [];
  let generateCall = 0;
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
    options,
  ): Promise<string> => {
    requests.push({
      systemInstruction: options.systemInstruction,
      messages: messages as readonly { messageId: string; message: string }[],
      trigger: options.trigger ?? undefined,
      responseTarget: options.responseTarget ?? undefined,
    });
    generateCall += 1;
    if (generateCall === 1) {
      return originalReply;
    }
    if (generateCall === 2) {
      return originalReply;
    }
    return replacement;
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

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
    inject([{ messageId: 'first-1', sender: 'Alex', message: '@Bot first question' }]);
    await advancePoll();
    await advancePoll();
    assert.equal(composeCalls.length, 1);

    inject([{ messageId: 'second-1', sender: 'Alex', message: '@Bot second question' }]);
    await advancePoll();

    inject([
      { messageId: 'second-2', sender: 'Alex', message: 'its too stale, who am i' },
      { messageId: 'rendered-1', sender: 'You', message: originalReply },
    ]);
    await advancePoll();
    await advancePoll();

    assert.ok(requests.length >= 3, 'the duplicate draft is retried once');
    const followUp = requests[1];
    const followUpIds = followUp.messages.map(message => message.messageId);
    const restoredIndex = followUpIds.indexOf('rendered-1');
    const triggerIndex = followUpIds.indexOf('second-2');
    assert.ok(restoredIndex >= 0, 'the late-rendered reply reaches generation');
    assert.ok(triggerIndex >= 0, 'the latest relevant incoming message reaches generation');
    assert.ok(
      restoredIndex < triggerIndex,
      'the late-rendered reply is restored before the message it contextualizes',
    );
    assert.equal(
      followUp.messages.filter(message => message.messageId === 'rendered-1').length,
      1,
      'the restored reply is not duplicated',
    );
    assert.equal(followUp.trigger?.messageId, 'second-1');
    assert.equal(followUp.responseTarget?.messageId, 'second-2');

    const retry = requests[2];
    const retryIds = retry.messages.map(message => message.messageId);
    assert.ok(retryIds.includes('rendered-1'), 'the retry keeps recent assistant history');
    assert.ok(retryIds.includes('second-2'), 'the retry keeps the latest user message');
    assert.match(String(retry.systemInstruction), /already said in this conversation/);
    assert.ok(String(retry.systemInstruction).includes(SELF_REPETITION_RETRY_INSTRUCTION));
    assert.deepEqual(composeCalls, [originalReply, replacement]);
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

test('a violating reply is suppressed before composition and never becomes pending outgoing', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const composeCalls: string[] = [];
  const generatedRequests: Array<readonly { messageId: string; message: string }[]> = [];
  const originalGenerateNvidiaReply = nvidiaModule.generateNvidiaReply;
  const originalCompose = composerModule.composeMessengerReply;
  (nvidiaModule as unknown as {
    generateNvidiaReply: typeof nvidiaModule.generateNvidiaReply;
  }).generateNvidiaReply = async (
    _apiKey: string,
    messages: readonly unknown[],
  ): Promise<string> => {
    generatedRequests.push(messages as readonly { messageId: string; message: string }[]);
    return 'gotta warm up first.';
  };
  (composerModule as unknown as {
    composeMessengerReply: typeof composerModule.composeMessengerReply;
  }).composeMessengerReply = async (_page, text) => {
    composeCalls.push(text);
    return { status: 'sent' };
  };

  const advancePoll = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flushEngine();
  };

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
    inject([{ messageId: 'outside-1', sender: 'Alex', message: '@Bot let us go outside' }]);
    await advancePoll();
    await advancePoll();

    assert.ok(generatedRequests.length >= 1, 'the packet reaches generation');
    assert.deepEqual(composeCalls, [], 'the violating reply never reaches the composer');
    assert.equal(
      contextStore.getRecent(10).some(message => message.message.includes('warm up')),
      false,
      'the violating reply is not recorded as pending outgoing',
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
