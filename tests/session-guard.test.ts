import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Browser, Frame, Page } from 'playwright';
import {
  BROWSER_SESSION_INTERRUPTED_MESSAGE,
  createBrowserSessionGuard,
  describeBrowserSessionIntervention,
  formatBrowserSessionIntervention,
  installBrowserSessionGuardInPage,
  type BrowserSessionGuard,
  type BrowserSessionIntervention,
  type SessionGuardCdpSession,
} from '../src/browser/session-guard.js';

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  protected readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeCdpSession implements SessionGuardCdpSession {
  readonly sent: string[] = [];
  readonly events = new FakeEmitter();
  bounds: Record<string, unknown> = {
    windowState: 'normal',
    left: 10,
    top: 10,
    width: 900,
    height: 600,
  };
  targets: unknown[] = [];
  detached = false;

  async send(method: string): Promise<Record<string, unknown>> {
    this.sent.push(method);
    if (method === 'Browser.getWindowForTarget') {
      return { bounds: { ...this.bounds } };
    }
    if (method === 'Target.getTargets') {
      return { targetInfos: this.targets };
    }
    return {};
  }

  on(event: string, listener: (params: Record<string, unknown>) => void): void {
    this.events.on(event, listener as Listener);
  }

  off(event: string, listener: (params: Record<string, unknown>) => void): void {
    this.events.off(event, listener as Listener);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

class FakeBrowser extends FakeEmitter {
  readonly browserSession = new FakeCdpSession();

  async newBrowserCDPSession(): Promise<FakeCdpSession> {
    return this.browserSession;
  }
}

class FakeContext {
  readonly windowSession = new FakeCdpSession();

  constructor(private readonly fakeBrowser: FakeBrowser) {}

  browser(): FakeBrowser {
    return this.fakeBrowser;
  }

  async newCDPSession(): Promise<FakeCdpSession> {
    return this.windowSession;
  }
}

class FakePage extends FakeEmitter {
  readonly contextValue: FakeContext;
  readonly mainFrameValue = { name: 'main' } as unknown as Frame;
  binding: ((source: unknown, signal: unknown) => unknown) | undefined;
  urlValue = 'https://www.facebook.com/messages/t/123456789';
  readonly evaluateCalls: string[] = [];
  readonly initScriptCalls: unknown[] = [];

  constructor(fakeBrowser: FakeBrowser) {
    super();
    this.contextValue = new FakeContext(fakeBrowser);
  }

  context(): FakeContext {
    return this.contextValue;
  }

  mainFrame(): Frame {
    return this.mainFrameValue;
  }

  url(): string {
    return this.urlValue;
  }

  isClosed(): boolean {
    return false;
  }

  async exposeBinding(
    _name: string,
    callback: (source: unknown, signal: unknown) => unknown,
  ): Promise<void> {
    this.binding = callback;
  }

  async addInitScript(_script: unknown, argument: unknown): Promise<void> {
    this.initScriptCalls.push(argument);
  }

  async evaluate(script: unknown): Promise<unknown> {
    this.evaluateCalls.push(String(script));
    return undefined;
  }

  report(signal: string): void {
    this.binding?.({}, signal);
  }
}

interface GuardHarness {
  page: FakePage;
  browser: FakeBrowser;
  guard: BrowserSessionGuard;
  interventions: BrowserSessionIntervention[];
  tick: () => Promise<void>;
  flush: () => Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function createHarness(
  windowBounds: Record<string, unknown> = {
    windowState: 'normal',
    left: 10,
    top: 10,
    width: 900,
    height: 600,
  },
): Promise<GuardHarness> {
  const browser = new FakeBrowser();
  const page = new FakePage(browser);
  page.contextValue.windowSession.bounds = windowBounds;
  const interventions: BrowserSessionIntervention[] = [];
  let intervalCallback: (() => void) | undefined;

  const guard = await createBrowserSessionGuard({
    page: page as unknown as Page,
    browser: browser as unknown as Browser,
    suppressionGraceMs: 0,
    onIntervention: intervention => {
      interventions.push(intervention);
    },
    setInterval: callback => {
      intervalCallback = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => undefined,
  });

  return {
    page,
    browser,
    guard,
    interventions,
    flush: flushMicrotasks,
    tick: async () => {
      intervalCallback?.();
      await flushMicrotasks();
    },
  };
}

function installPageGuard(): {
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  signals: string[];
  handle: {
    begin(): void;
    end(): void;
    disable(): void;
    dispose(): void;
  };
  hasGuard: () => boolean;
} {
  const signals: string[] = [];
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const fakeWindow: Record<string, unknown> = {
    addEventListener(
      type: string,
      handler: (event: Record<string, unknown>) => void,
    ): void {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(
      type: string,
      handler: (event: Record<string, unknown>) => void,
    ): void {
      listeners.get(type)?.delete(handler);
    },
    __impracticalBotSessionGuardReport: (signal: string): void => {
      signals.push(signal);
    },
  };
  const context = {
    window: fakeWindow,
    document: { visibilityState: 'visible' },
  };
  runInNewContext(
    `(${installBrowserSessionGuardInPage.toString()})(` +
    `${JSON.stringify({
      bindingName: '__impracticalBotSessionGuardReport',
      suppressionGraceMs: 0,
    })});`,
    context,
  );
  const handle = fakeWindow.__impracticalBotSessionGuard as {
    begin(): void;
    end(): void;
    disable(): void;
    dispose(): void;
  };
  return {
    dispatch(type, event = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) {
        handler({ type, ...event });
      }
    },
    signals,
    handle,
    hasGuard: () => fakeWindow.__impracticalBotSessionGuard !== undefined,
  };
}

test('passive mouse movement over the browser does not report interaction', () => {
  const guard = installPageGuard();
  guard.dispatch('mousemove');
  guard.dispatch('mouseover');
  guard.dispatch('mouseenter');
  guard.dispatch('mouseleave');
  guard.dispatch('pointermove', { pointerType: 'mouse' });
  assert.deepEqual(guard.signals, []);
});

test('manual mouse click, scrolling, and keyboard input are reported', () => {
  const guard = installPageGuard();
  guard.dispatch('mousedown', { button: 0 });
  guard.dispatch('wheel');
  guard.dispatch('keydown', { key: 'a' });
  guard.dispatch('beforeinput', { inputType: 'insertText' });
  assert.deepEqual(guard.signals, ['mouse', 'scroll', 'keyboard', 'keyboard']);
});

test('page guard suppresses automation input without ignoring later manual input', () => {
  const guard = installPageGuard();
  guard.handle.begin();
  guard.dispatch('mousedown', { button: 0 });
  guard.dispatch('keydown', { key: 'a' });
  guard.handle.end();
  assert.deepEqual(guard.signals, []);

  guard.dispatch('mousedown', { button: 0 });
  assert.deepEqual(guard.signals, ['mouse']);
});

test('page guard dispose removes listeners and the guard object', () => {
  const guard = installPageGuard();
  guard.handle.dispose();
  guard.dispatch('mousedown', { button: 0 });
  assert.deepEqual(guard.signals, []);
  assert.equal(guard.hasGuard(), false);
});

test('manual click and scroll trigger one controlled shutdown', async () => {
  const harness = await createHarness();
  harness.page.report('mouse');
  harness.page.report('scroll');
  assert.deepEqual(harness.interventions, [{ reason: 'manual-mouse' }]);
  assert.equal(
    describeBrowserSessionIntervention(harness.interventions[0].reason),
    'Manual mouse interaction detected.',
  );
  assert.equal(
    formatBrowserSessionIntervention(harness.interventions[0].reason),
    [
      '[ERROR] Browser session interrupted.',
      '[REASON] Manual mouse interaction detected.',
      '[ACTION] Automation stopped and browser session closed.',
    ].join('\n'),
  );
  assert.equal(BROWSER_SESSION_INTERRUPTED_MESSAGE, 'Browser session interrupted.');
  await harness.guard.dispose();
});

test('intervention reasons produce the required dynamic messages', () => {
  const expected = {
    'manual-mouse': 'Manual mouse interaction detected.',
    'manual-keyboard': 'Manual keyboard interaction detected.',
    'manual-scroll': 'Manual scrolling detected.',
    'manual-navigation': 'Manual navigation detected.',
    'manual-tab': 'Manual tab switching detected.',
    'session-closed': 'Browser session closed unexpectedly.',
  } as const;
  for (const [reason, message] of Object.entries(expected)) {
    assert.equal(
      describeBrowserSessionIntervention(reason as keyof typeof expected),
      message,
    );
    assert.match(
      formatBrowserSessionIntervention(reason as keyof typeof expected),
      new RegExp(`\\[REASON\\] ${message.replace(/[.]/g, '\\.')}`),
    );
  }
});

test('manual keyboard input triggers shutdown', async () => {
  const harness = await createHarness();
  harness.page.report('keyboard');
  assert.deepEqual(harness.interventions, [{ reason: 'manual-keyboard' }]);
  await harness.guard.dispose();
});

test('bot-generated input does not trigger shutdown', async () => {
  const harness = await createHarness();
  await harness.guard.runAutomated(async () => {
    harness.page.report('mouse');
    harness.page.report('keyboard');
    harness.page.report('scroll');
  });
  assert.deepEqual(harness.interventions, []);
  await harness.guard.dispose();
});

test('bot-generated navigation is ignored but manual navigation triggers shutdown', async () => {
  const harness = await createHarness();
  await harness.guard.runAutomated(async () => {
    harness.page.urlValue = 'https://www.facebook.com/messages/t/987654321';
    harness.page.emit('framenavigated', harness.page.mainFrame());
  }, { navigation: true });
  assert.deepEqual(harness.interventions, []);

  harness.page.urlValue = 'https://www.facebook.com/messages/t/555';
  harness.page.emit('framenavigated', harness.page.mainFrame());
  assert.deepEqual(harness.interventions, [{ reason: 'manual-navigation' }]);
  await harness.guard.dispose();
});

test('window move, resize, minimize, maximize, restore, and monitor changes are tolerated', async () => {
  const harness = await createHarness();
  const windowStates: Array<Record<string, unknown>> = [
    { windowState: 'normal', left: 60, top: 40, width: 800, height: 500 },
    { windowState: 'normal', left: 60, top: 40, width: 1200, height: 800 },
    { windowState: 'minimized' },
    { windowState: 'maximized' },
    { windowState: 'normal', left: 60, top: 40, width: 900, height: 600 },
    { windowState: 'normal', left: -1920, top: 0, width: 900, height: 600 },
  ];
  for (const bounds of windowStates) {
    harness.page.contextValue.windowSession.bounds = bounds;
    await harness.tick();
  }
  assert.deepEqual(harness.interventions, []);
  await harness.guard.dispose();
});

test('page hiding while the window is minimized is tolerated', async () => {
  const harness = await createHarness({ windowState: 'minimized' });
  harness.page.report('hidden');
  await harness.flush();
  assert.deepEqual(harness.interventions, []);
  await harness.guard.dispose();
});

test('unexpected browser closure triggers shutdown', async () => {
  const harness = await createHarness();
  harness.browser.emit('disconnected');
  assert.deepEqual(harness.interventions, [{ reason: 'session-closed' }]);
  await harness.guard.dispose();
});

test('closing the controlled tab triggers shutdown', async () => {
  const harness = await createHarness();
  harness.page.emit('close');
  assert.deepEqual(harness.interventions, [{ reason: 'session-closed' }]);
  await harness.guard.dispose();
});

test('tab creation is treated as a manual tab change', async () => {
  const harness = await createHarness();
  harness.browser.browserSession.events.emit('Target.targetCreated', {
    targetInfo: { type: 'page', targetId: 'new-tab' },
  });
  assert.deepEqual(harness.interventions, [{ reason: 'manual-tab' }]);
  await harness.guard.dispose();
});

test('switching tabs (page hidden while window is normal) triggers shutdown', async () => {
  const harness = await createHarness();
  harness.page.report('hidden');
  await harness.flush();
  assert.deepEqual(harness.interventions, [{ reason: 'manual-tab' }]);
  await harness.guard.dispose();
  assert.equal(harness.page.contextValue.windowSession.detached, true);
});

test('guard cleanup removes listeners and monitoring resources', async () => {
  const harness = await createHarness();
  await harness.guard.dispose();
  assert.equal(harness.page.listenerCount('framenavigated'), 0);
  assert.equal(harness.page.listenerCount('close'), 0);
  assert.equal(harness.browser.listenerCount('disconnected'), 0);
  assert.equal(harness.browser.browserSession.detached, true);
  assert.deepEqual(
    harness.page.contextValue.windowSession.sent,
    [],
    'window state is only read when page visibility changes',
  );
  harness.page.report('mouse');
  harness.page.emit('close');
  harness.browser.emit('disconnected');
  assert.deepEqual(harness.interventions, []);
});
