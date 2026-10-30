import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { startCombustion } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';
import type { Configuration } from '../src/config/configuration.js';

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const LOG_SELECTOR = '[role="log"][aria-live="polite"]';
const WAKER_MESSAGE_SELECTOR = '[data-message-id]';

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

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector === LOG_SELECTOR) {
    return element.getAttribute('role') === 'log' &&
      element.getAttribute('aria-live') === 'polite';
  }
  if (selector === WAKER_MESSAGE_SELECTOR) {
    return element.hasAttribute('data-message-id');
  }
  if (selector === MESSAGE_SELECTOR) {
    return element.getAttribute('data-scope') === 'messages_table' &&
      element.getAttribute('aria-roledescription') === 'message' &&
      element.hasAttribute('data-message-id');
  }
  if (selector === 'h4') {
    return element.tagName === 'h4';
  }
  return false;
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  innerText = '';

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
    attributes: Record<string, string> = {},
  ) {
    this.attributes = new Map(Object.entries(attributes));
  }

  private readonly attributes: Map<string, string>;

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    this.ownerDocument.notifyMutation(child);
    return child;
  }

  replaceWith(replacement: FakeElement): void {
    const parent = this.parent;
    if (!parent) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      parent.children[index] = replacement;
    }
    replacement.parent = parent;
    this.parent = null;
    this.ownerDocument.notifyMutation(replacement);
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  contains(node: FakeElement): boolean {
    let current: FakeElement | null = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  cloneNode(): FakeElement {
    const clone = new FakeElement(this.tagName, this.ownerDocument);
    clone.innerText = this.innerText;
    for (const child of this.children) {
      clone.appendChild(child.cloneNode());
    }
    return clone;
  }
}

class FakeDocument {
  readonly body: FakeElement;
  readonly observers: FakeMutationObserver[] = [];

  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName: string, attributes: Record<string, string> = {}): FakeElement {
    return new FakeElement(tagName, this, attributes);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.body.matches(selector)) {
      matches.push(this.body);
    }
    matches.push(...this.body.querySelectorAll(selector));
    return matches;
  }

  notifyMutation(addedNode: FakeElement): void {
    for (const observer of [...this.observers]) {
      observer.notify(addedNode);
    }
  }
}

class FakeMutationObserver {
  active = false;
  private target: FakeElement | null = null;

  constructor(
    private readonly document: FakeDocument,
    private readonly callback: (
      mutations: { type: string; addedNodes: FakeElement[] }[],
    ) => void,
  ) {
    document.observers.push(this);
  }

  observe(target: FakeElement): void {
    this.target = target;
  }

  disconnect(): void {
    this.target = null;
  }

  notify(addedNode: FakeElement): void {
    if (this.target && this.target.contains(addedNode)) {
      this.callback([{ type: 'childList', addedNodes: [addedNode] }]);
    }
  }
}

interface PageConsoleMessage {
  text(): string;
}

function createWakerPage() {
  const document = new FakeDocument();
  const listeners = new Set<(message: PageConsoleMessage) => void>();
  const windowObject: Record<string, unknown> = {};
  let observerSetupCalls = 0;
  let messageReadCalls = 0;

  class PageMutationObserver extends FakeMutationObserver {
    constructor(callback: (mutations: { type: string; addedNodes: FakeElement[] }[]) => void) {
      super(document, callback);
    }
  }

  const pageConsole = {
    log(value: unknown) {
      const text = String(value);
      for (const listener of listeners) {
        listener({ text: () => text });
      }
    },
  };

  const context = {
    window: windowObject,
    document,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: PageMutationObserver,
    console: pageConsole,
  };

  const log = document.createElement('div', {
    role: 'log',
    'aria-live': 'polite',
  });
  document.body.appendChild(log);

  const createMessage = (
    messageId: string,
    text: string,
    sender = 'Alex',
  ): FakeElement => {
    const message = document.createElement('div', {
      'data-scope': 'messages_table',
      'aria-roledescription': 'message',
      'data-message-id': messageId,
      'aria-label': `At October 18, 2026, 1:15 PM, ${sender}: ${text}`,
    });
    message.innerText = text;
    return message;
  };

  log.appendChild(createMessage('baseline-1', 'hello'));

  const page = {
    on(event: string, listener: (message: PageConsoleMessage) => void) {
      assert.equal(event, 'console');
      listeners.add(listener);
      return this;
    },
    off(event: string, listener: (message: PageConsoleMessage) => void) {
      assert.equal(event, 'console');
      listeners.delete(listener);
      return this;
    },
    locator(selector: string) {
      if (selector === LOG_SELECTOR) {
        return {
          evaluate: async (
            callback: (log: FakeElement, options: unknown) => void,
            options: unknown,
          ) => {
            observerSetupCalls += 1;
            const currentLog = document.querySelectorAll(LOG_SELECTOR)[0];
            return runInNewContext(
              `(${callback.toString()})(log, options)`,
              { log: currentLog, options, ...context },
            );
          },
        };
      }
      assert.equal(selector, MESSAGE_SELECTOR);
      return {
        evaluateAll: async (
          callback: (items: FakeElement[], limit: number) => unknown[],
          limit: number,
        ) => {
          messageReadCalls += 1;
          const items = document.querySelectorAll(MESSAGE_SELECTOR);
          return runInNewContext(
            `(${callback.toString()})(items, limit)`,
            { items, limit },
          );
        },
      };
    },
    evaluate: async (callback: (argument?: unknown) => void, argument?: unknown) =>
      runInNewContext(
        `(${callback.toString()})(argument)`,
        { argument, ...context },
      ),
  } as unknown as Page;

  return {
    page,
    appendMessage(messageId: string, text: string, sender = 'Alex') {
      const message = createMessage(messageId, text, sender);
      const currentLog = document.querySelectorAll(LOG_SELECTOR)[0];
      assert.ok(currentLog, 'expected a rendered message log');
      currentLog.appendChild(message);
      return message;
    },
    updateMessage(messageId: string, text: string, sender = 'Alex') {
      const message = document.querySelectorAll(MESSAGE_SELECTOR)
        .find(candidate => candidate.getAttribute('data-message-id') === messageId);
      assert.ok(message, `expected message ${messageId} to be rendered`);
      message.innerText = text;
      message.setAttribute('aria-label', `At October 18, 2026, 1:15 PM, ${sender}: ${text}`);
      return message;
    },
    setMessagePresentation(
      messageId: string,
      ariaLabel: string | null,
      innerText: string,
    ) {
      const message = document.querySelectorAll(MESSAGE_SELECTOR)
        .find(candidate => candidate.getAttribute('data-message-id') === messageId);
      assert.ok(message, `expected message ${messageId} to be rendered`);
      message.innerText = innerText;
      if (ariaLabel === null) {
        message.removeAttribute('aria-label');
      } else {
        message.setAttribute('aria-label', ariaLabel);
      }
      return message;
    },
    replaceLog() {
      const previousLog = document.querySelectorAll(LOG_SELECTOR)[0];
      assert.ok(previousLog, 'expected a rendered message log');
      const replacement = document.createElement('div', {
        role: 'log',
        'aria-live': 'polite',
      });
      previousLog.replaceWith(replacement);
    },
    get observer() {
      return windowObject.__impracticalBotWakerObserver as
        | (FakeMutationObserver & { active: boolean })
        | undefined;
    },
    get observerSetupCalls() {
      return observerSetupCalls;
    },
    get messageReadCalls() {
      return messageReadCalls;
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const flush = async (turns = 8): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};

async function advanceToIdle(
  context: TestContext,
  wakerPage: ReturnType<typeof createWakerPage>,
): Promise<void> {
  for (let step = 0; step < 41; step += 1) {
    context.mock.timers.tick(3_000);
    await flush();
    if (wakerPage.observer?.active) {
      return;
    }
  }
  assert.fail('Combustion did not enter idle mode.');
}

test('Combustion wakes from idle, detects a new message, and resumes polling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    assert.equal(wakerPage.observer?.active, true);
    const readsBeforeWake = wakerPage.messageReadCalls;

    wakerPage.appendMessage('wake-1', 'new activity');
    await flush();

    assert.ok(wakerPage.messageReadCalls > readsBeforeWake);
    assert.ok(contextStore.getState().messageIds.includes('wake-1'));
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('A Sent status suffix does not stop polling or duplicate the message', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  let stoppedError: unknown;
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });
  void controller.stopped.catch(error => {
    stoppedError = error;
  });

  try {
    assert.deepEqual(contextStore.getState().messageIds, ['baseline-1']);

    wakerPage.updateMessage('baseline-1', 'helloSent');
    await advanceToIdle(context, wakerPage);

    assert.equal(stoppedError, undefined);
    assert.deepEqual(contextStore.getState().messageIds, ['baseline-1']);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');

    const readsBeforeNewMessage = wakerPage.messageReadCalls;
    wakerPage.appendMessage('after-status-1', 'next message');
    await flush();

    assert.equal(stoppedError, undefined);
    assert.ok(wakerPage.messageReadCalls > readsBeforeNewMessage);
    assert.deepEqual(contextStore.getState().messageIds, ['baseline-1', 'after-status-1']);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('delivery status and accessibility-label changes do not stop Combustion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  wakerPage.setMessagePresentation(
    'baseline-1',
    'At October 18, 2026, 1:15 PM, You: hello',
    'You sent hello',
  );
  const contextStore = createContextStore();
  let stoppedError: unknown;
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });
  void controller.stopped.catch(error => {
    stoppedError = error;
  });

  const advance = async (): Promise<void> => {
    context.mock.timers.tick(3_000);
    await flush();
  };

  try {
    assert.deepEqual(contextStore.getState().messageIds, ['baseline-1']);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');

    wakerPage.setMessagePresentation(
      'baseline-1',
      'At October 18, 2026, 1:15 PM, You: hello Sent',
      'You sent hello Sent',
    );
    await advance();
    assert.equal(stoppedError, undefined);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');

    wakerPage.setMessagePresentation(
      'baseline-1',
      'At October 18, 2026, 1:15 PM, You: hello Delivered',
      'You sent hello Delivered',
    );
    await advance();
    assert.equal(stoppedError, undefined);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');

    wakerPage.setMessagePresentation(
      'baseline-1',
      'At October 18, 2026, 1:15 PM, You: hello Seen',
      'You sent hello Seen',
    );
    await advance();
    assert.equal(stoppedError, undefined);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');

    wakerPage.setMessagePresentation('baseline-1', null, 'You sent hello Seen');
    await advance();
    assert.equal(stoppedError, undefined);
    assert.equal(contextStore.getRecent(1)[0].message, 'hello');
    assert.deepEqual(contextStore.getState().messageIds, ['baseline-1']);

    wakerPage.setMessagePresentation(
      'baseline-1',
      'At October 18, 2026, 1:15 PM, You: genuinely different',
      'You sent genuinely different',
    );
    await advance();

    assert.match(
      String((stoppedError as Error | undefined)?.message),
      /Message ID baseline-1 was observed with different content\./,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('A seeded context message outside the baseline is not treated as new', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  const originalLog = console.log;
  const logs: string[] = [];
  Math.random = () => 0.99;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  contextStore.add([{ messageId: 'seeded-historical', message: 'hello' }]);
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    wakerPage.appendMessage('seeded-historical', 'hello');
    context.mock.timers.tick(3_000);
    await flush();

    assert.ok(logs.some(message =>
      message.includes('[poll] Poll: 0 new messages checked; 0 mention detected.'),
    ), logs.join('\n'));
    assert.equal(
      logs.some(message =>
        message.includes('New message:') && message.includes('id=seeded-historical'),
      ),
      false,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    console.log = originalLog;
    context.mock.timers.reset();
  }
});

test('A genuine same-ID content conflict still stops Combustion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  let stoppedError: unknown;
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });
  void controller.stopped.catch(error => {
    stoppedError = error;
  });

  try {
    wakerPage.updateMessage('baseline-1', 'genuinely different');
    context.mock.timers.tick(3_000);
    await flush();

    assert.match(
      String((stoppedError as Error | undefined)?.message),
      /Message ID baseline-1 was observed with different content\./,
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Combustion keeps waking after the message log element is replaced', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    wakerPage.replaceLog();
    await flush();

    const readsBeforeWake = wakerPage.messageReadCalls;
    wakerPage.appendMessage('replacement-1', 'activity after replacement');
    await flush();

    assert.ok(wakerPage.messageReadCalls > readsBeforeWake);
    assert.ok(contextStore.getState().messageIds.includes('replacement-1'));
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Combustion retains wake-up capability across repeated idle and active cycles', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    for (const messageId of ['cycle-1', 'cycle-2', 'cycle-3']) {
      await advanceToIdle(context, wakerPage);
      const readsBeforeWake = wakerPage.messageReadCalls;
      wakerPage.appendMessage(messageId, `activity ${messageId}`);
      await flush();
      assert.ok(wakerPage.messageReadCalls > readsBeforeWake);
      assert.ok(contextStore.getState().messageIds.includes(messageId));
    }

    assert.equal(wakerPage.observerSetupCalls, 1);
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Repeated mutations do not create duplicate polls or observer setup', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    const readsBeforeWake = wakerPage.messageReadCalls;

    wakerPage.appendMessage('burst-1', 'first');
    wakerPage.appendMessage('burst-2', 'second');
    wakerPage.appendMessage('burst-3', 'third');
    await flush();

    assert.equal(wakerPage.messageReadCalls, readsBeforeWake + 1);
    assert.equal(wakerPage.observerSetupCalls, 1);
    assert.deepEqual(
      contextStore.getState().messageIds.filter(id => id.startsWith('burst-')),
      ['burst-1', 'burst-2', 'burst-3'],
    );
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Explicit pause still suppresses DOM-triggered wake-ups and resume works', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    await controller.pause();
    const readsWhilePaused = wakerPage.messageReadCalls;

    wakerPage.appendMessage('paused-1', 'must wait for resume');
    await flush();
    assert.equal(wakerPage.messageReadCalls, readsWhilePaused);
    assert.equal(contextStore.getState().messageIds.includes('paused-1'), false);

    await controller.resume();
    await flush();

    assert.ok(wakerPage.messageReadCalls > readsWhilePaused);
    assert.ok(contextStore.getState().messageIds.includes('paused-1'));
  } finally {
    await controller.stop();
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Stop while idle removes the observer and console listener cleanly', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    assert.equal(wakerPage.observer?.active, true);

    await controller.stop();
    await controller.stopped;

    assert.equal(wakerPage.listenerCount, 0);
    assert.equal(wakerPage.observer, undefined);
  } finally {
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});

test('Stop during wake-up completes cleanly', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  const wakerPage = createWakerPage();
  const contextStore = createContextStore();
  const controller = await startCombustion({
    page: wakerPage.page,
    contextStore,
    configuration,
    aliases: ['@Bot'],
    apiKey: 'offline-test-key',
    debugMode: true,
  });

  try {
    await advanceToIdle(context, wakerPage);
    wakerPage.appendMessage('stop-wakeup-1', 'wake then stop');

    await controller.stop();
    await controller.stopped;

    assert.equal(wakerPage.listenerCount, 0);
    assert.equal(wakerPage.observer, undefined);
  } finally {
    Math.random = originalRandom;
    context.mock.timers.reset();
  }
});
