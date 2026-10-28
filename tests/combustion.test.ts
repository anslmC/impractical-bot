import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { startCombustion } from '../src/components/combustion.js';
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