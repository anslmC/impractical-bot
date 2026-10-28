import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { startCombustion, shouldRngRespond } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';
import type { Configuration } from '../src/config/configuration.js';

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

test('Combustion passes the established eight-message limit into the isolated page callback', async () => {
  const mockPage = createMockPage({ messageCount: 9 });
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: mockPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  assert.deepEqual(contextStore.getState().messageIds, [
    'baseline-1',
    'baseline-2',
    'baseline-3',
    'baseline-4',
    'baseline-5',
    'baseline-6',
    'baseline-7',
    'baseline-8',
  ]);
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
    assert.ok(logs.some(message => message.includes('Roll: YES (85% chance)')));

    controller.setTemperament('quiet');
    context.mock.timers.tick(15_000);
    await flush();
    assert.ok(logs.some(message => message.includes('Roll: NO (90% chance)')));

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

test('RNG decision boundaries follow each temperament without sampling randomness', () => {
  assert.equal(shouldRngRespond('quiet', 0.0999), true);
  assert.equal(shouldRngRespond('quiet', 0.1), false);
  assert.equal(shouldRngRespond('balanced', 0.4999), true);
  assert.equal(shouldRngRespond('balanced', 0.5), false);
  assert.equal(shouldRngRespond('talkative', 0.8499), true);
  assert.equal(shouldRngRespond('talkative', 0.85), false);
});
