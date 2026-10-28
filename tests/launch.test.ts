import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import {
  assertConfiguredBrowserCanStart,
  closeConfiguredBrowser,
  launchConfiguredBrowser,
  navigateConfiguredBrowserToMessageDestination,
  prepareConfiguredBrowser,
  type BrowserCloseOptions,
  type BrowserLaunchFileSystem,
  type BrowserProcessHandle,
} from '../src/browser/launch.js';
import type { Browser } from 'playwright';
import type { Configuration } from '../src/config/configuration.js';

const baseConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Browsers\\Brave\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\brave-profile',
  skipPinRestoration: false,
  pin: '001234',
  cdpPort: 49271,
  startupUrl: 'https://www.facebook.com',
  messageDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type StartupScenario = 'no-pin' | 'notification-and-skip-pin' | 'skip-pin-multiple-close' |
  'pin-entry' | 'pin-rejected' | 'pin-unresolved' |
  'wrong-conversation' | 'no-composer' | 'notification-dismiss-failure' | 'pin-skip-failure' |
  'late-blockers';

class StartupLocator {
  constructor(
    private readonly page: StartupPage,
    private readonly key: string,
    private readonly index = 0,
  ) {}

  filter(): this { return this; }
  first(): this { return this; }
  nth(index: number): StartupLocator { return new StartupLocator(this.page, this.key, index); }

  async count(): Promise<number> {
    return this.page.count(this.key);
  }

  async isVisible(): Promise<boolean> {
    return this.page.isVisible(this.key);
  }

  async isEnabled(): Promise<boolean> {
    return this.page.isEnabled(this.key);
  }

  async waitFor(options: { state: string; timeout?: number }): Promise<void> {
    await this.page.waitFor(this.key, options.state, options.timeout);
  }

  async fill(value: string): Promise<void> {
    this.page.enteredPin = value;
    this.page.events.push('pin-filled');
    if (this.page.scenario === 'pin-rejected') {
      this.page.pinRejected = true;
    }
  }

  async press(): Promise<void> {
    this.page.events.push('pin-enter-pressed');
    if (this.page.scenario === 'pin-entry') {
      this.page.pinVisible = false;
      this.page.composerReady = true;
    }
  }

  async click(): Promise<void> {
    if (this.key === 'notification-close-button') {
      this.page.events.push('notification-dismissed');
      if (this.page.scenario !== 'notification-dismiss-failure') {
        this.page.notificationVisible = false;
      }
    } else if (this.key === 'close-button') {
      this.page.events.push('pin-close-clicked');
      this.page.clickedCloseIndex = this.index;
      this.page.pinVisible = false;
      this.page.confirmationVisible = true;
    } else if (this.key === 'skip-button') {
      this.page.events.push('skip-clicked');
      if (this.page.scenario !== 'pin-skip-failure') {
        this.page.confirmationVisible = false;
        this.page.composerReady = true;
      }
      this.page.skipClicked = true;
    }
  }

  async evaluate(): Promise<void> {
    await this.click();
  }

  getByRole(role: string, options: { name: string }): StartupLocator {
    if (this.key === 'notification-dialog' && role === 'button' && options.name === 'Close') {
      return new StartupLocator(this.page, 'notification-close-button');
    }
    return new StartupLocator(this.page, `role:${role}:${options.name}`);
  }

  locator(selector: string): StartupLocator {
    const selectors: Record<string, string> = {
      '[role="dialog"][aria-modal="true"]': 'modal-list',
      '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]': 'confirmation',
      '[aria-label="Close"][role="button"]': 'close-button',
      '[aria-label="Don\'t restore messages"][role="button"]': 'skip-button',
      'input[aria-label="PIN"], input[autocomplete="one-time-code"], input[maxlength="6"]': 'pin-input',
      '[role="textbox"][contenteditable="true"]:visible': 'composer',
    };
    return new StartupLocator(this.page, selectors[selector] ?? selector);
  }
}

class StartupPage {
  currentUrl: string;
  readonly gotoUrls: string[] = [];
  loginDetected = false;
  loginIndicatorsAvailable = true;
  loginIndicatorError: Error | undefined;
  navigationCount = 0;
  pinVisible = false;
  notificationVisible = false;
  pinRejected = false;
  confirmationVisible = false;
  composerReady = false;
  enteredPin: string | undefined;
  skipClicked = false;
  clickedCloseIndex: number | undefined;
  readonly events: string[] = [];
  readonly loginTimeouts: number[] = [];
  readonly loginGate = deferred<void>();
  readonly scenario: StartupScenario;

  constructor(destination: string, scenario: StartupScenario) {
    this.currentUrl = 'https://www.facebook.com/';
    this.scenario = scenario;
    this.destination = destination;
    void this.loginGate.promise.then(() => {
      this.loginDetected = true;
    });
  }

  private readonly destination: string;

  isClosed(): boolean { return false; }
  url(): string { return this.currentUrl; }

  getByRole(role: string, options: { name: string }): StartupLocator {
    if (role === 'alertdialog' && options.name === 'Push notifications request') {
      return new StartupLocator(this, 'notification-dialog');
    }
    if (role === 'heading' && options.name === 'Enter your PIN to restore your chats') {
      return new StartupLocator(this, 'pin-heading');
    }
    return new StartupLocator(this, `role:${role}:${options.name}`);
  }

  getByText(text: string): StartupLocator {
    return new StartupLocator(this, text === 'Incorrect PIN. Try again.' ? 'pin-rejection' : text);
  }

  locator(selector: string): StartupLocator {
    const selectors: Record<string, string> = {
      '[role="dialog"][aria-modal="true"]': 'modal-list',
      '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]': 'confirmation',
      '[role="textbox"][contenteditable="true"]:visible': 'composer',
    };
    return new StartupLocator(this, selectors[selector] ?? selector);
  }

  async goto(url: string): Promise<void> {
    this.gotoUrls.push(url);
    if (url === baseConfiguration.startupUrl) {
      this.currentUrl = url;
      return;
    }
    const alreadyAtDestination = this.currentUrl === url;
    assert.equal(
      this.loginDetected || alreadyAtDestination,
      true,
      'destination navigation must follow login detection unless already at the destination',
    );
    this.navigationCount += 1;
    this.currentUrl = this.scenario === 'wrong-conversation'
      ? 'https://www.facebook.com/messages/t/999999999'
      : url;
    this.events.push('navigated');
    this.notificationVisible = this.scenario === 'notification-and-skip-pin' ||
      this.scenario === 'notification-dismiss-failure';
    this.composerReady = this.scenario !== 'no-composer';
    if (this.scenario !== 'no-pin') {
      this.pinVisible = true;
    }
  }

  async waitForFunction(
    _callback: (expectedId: string) => boolean,
    expectedId: string,
  ): Promise<void> {
    const currentId = new URL(this.currentUrl).pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1];
    if (currentId !== expectedId) {
      throw new Error('wrong conversation');
    }
    this.events.push('conversation-verified');
  }

  count(key: string): number {
    if (key === 'notification-dialog' || key === 'notification-close-button') {
      return this.notificationVisible ? 1 : 0;
    }
    if (key === '[role="dialog"][aria-modal="true"]' || key === 'modal-list') {
      return this.pinVisible || this.confirmationVisible ? 1 : 0;
    }
    if (key === 'role:heading:Enter your PIN to restore your chats' || key === 'pin-heading') {
      return this.pinVisible ? 1 : 0;
    }
    if (key === 'close-button') {
      return this.pinVisible
        ? this.scenario === 'skip-pin-multiple-close' ? 2 : 1
        : 0;
    }
    if (key === 'skip-button') return this.confirmationVisible ? 1 : 0;
    if (key === 'pin-input') return this.pinVisible ? 1 : 0;
    if (key === 'confirmation') return this.confirmationVisible ? 1 : 0;
    if (key === 'composer') return this.composerReady ? 1 : 0;
    if (key === 'pin-rejection') return this.pinRejected ? 1 : 0;
    if (key === 'role:heading:Create a post' ||
      key === '[role="region"][aria-label="Create a post"]' ||
      key === 'role:button:Messenger') {
      return this.loginDetected && this.loginIndicatorsAvailable ? 1 : 0;
    }
    return 0;
  }

  isVisible(key: string): boolean {
    if (this.loginIndicatorError && (
      key === 'role:heading:Create a post' ||
      key === '[role="region"][aria-label="Create a post"]' ||
      key === 'role:button:Messenger'
    )) {
      throw this.loginIndicatorError;
    }
    if (key === 'notification-dialog') {
      if (this.scenario === 'late-blockers' && this.events.includes('notification-checked')) {
        this.notificationVisible = true;
        this.pinVisible = true;
        this.confirmationVisible = true;
      }
      if (!this.events.includes('notification-checked')) {
        this.events.push('notification-checked');
      }
      return this.notificationVisible;
    }
    if (key === 'confirmation') return this.confirmationVisible;
    if (key === 'dialog' || key === 'modal-list') return this.pinVisible || this.confirmationVisible;
    return this.count(key) > 0;
  }

  isEnabled(key: string): boolean {
    return ['notification-close-button', 'close-button', 'skip-button', 'pin-input', 'composer']
      .includes(key) && this.count(key) > 0;
  }

  async waitFor(key: string, state: string, timeout?: number): Promise<void> {
    const visible = state === 'visible';
    if (key === 'role:heading:Create a post' ||
      key === '[role="region"][aria-label="Create a post"]' ||
      key === 'role:button:Messenger') {
      if (timeout !== undefined) {
        this.loginTimeouts.push(timeout);
      }
      if (this.loginIndicatorError) {
        throw this.loginIndicatorError;
      }
      if (!this.loginIndicatorsAvailable) {
        const timeoutError = new Error('Timed out waiting for the Facebook login indicator.');
        timeoutError.name = 'TimeoutError';
        await new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(timeoutError), timeout ?? 0);
        });
      }
      await this.loginGate.promise;
      return;
    }
    if (key === 'pin-heading' || key === 'role:heading:Enter your PIN to restore your chats') {
      this.events.push('pin-prompt-checked');
      if (this.pinVisible !== visible) throw new Error('PIN heading state did not match');
      return;
    }
    if (key === 'notification-dialog') {
      if (this.notificationVisible !== visible) throw new Error('notification dialog state did not match');
      return;
    }
    if (key === 'confirmation') {
      if (visible) this.events.push('confirmation-visible');
      if (!visible && this.scenario === 'pin-skip-failure') {
        throw new Error('confirmation did not disappear');
      }
      if (this.confirmationVisible !== visible) throw new Error('confirmation state did not match');
      return;
    }
    if (key === 'modal-list') {
      if (this.pinVisible !== visible) throw new Error('PIN dialog state did not match');
      return;
    }
    if (key === 'composer') {
      this.events.push('composer-readiness-checked');
      if (this.composerReady !== visible) throw new Error('composer state did not match');
      return;
    }
    if (key === 'pin-rejection') {
      if (this.pinRejected !== visible) throw new Error('PIN rejection state did not match');
      return;
    }
    throw new Error(`No startup mock behavior for ${key}`);
  }
}

function browserForStartupPage(pages: StartupPage | StartupPage[]): Browser {
  const startupPages = Array.isArray(pages) ? pages : [pages];
  return {
    isConnected: () => true,
    contexts: () => [{ pages: () => startupPages }],
  } as unknown as Browser;
}

class FakeProcess implements BrowserProcessHandle {
  readonly pid = 12345;
  exited = false;
  unrefCalls = 0;
  private readonly listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  once(event: 'error' | 'exit', listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): this {
    if (event === 'exit') {
      this.listeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    return this;
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exited = true;
    for (const listener of this.listeners) {
      listener(code, signal);
    }
  }
}

class FakeFileSystem implements BrowserLaunchFileSystem {
  readonly directories: string[] = [];

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function createCdpServer(): { server: Server; start(port: number): Promise<void> } {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/test-session`,
    }));
  });
  return {
    server,
    start: port => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }),
  };
}

function browserMock() {
  const calls = { close: 0, version: 0 };
  let connected = true;
  let disconnectedListener: (() => void) | undefined;
  return {
    calls,
    browser: {
      isConnected: () => connected,
      async version() {
        calls.version += 1;
        return 'Brave Chromium test';
      },
      once(event: string, listener: () => void) {
        if (event === 'disconnected') {
          disconnectedListener = listener;
        }
        return this;
      },
      async close() {
        calls.close += 1;
        connected = false;
        disconnectedListener?.();
      },
    },
  };
}

test('startup handles notification before skipping PIN restoration when configured', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'notification-and-skip-pin');
  const browser = browserForStartupPage(page);
  const configuration = { ...baseConfiguration, skipPinRestoration: true, pin: null };
  const preparation = prepareConfiguredBrowser(browser, configuration, {
    pinPromptTimeoutMs: 1_000,
    readinessTimeoutMs: 1_000,
  });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(page.navigationCount, 0);
  page.loginGate.resolve();
  await preparation;

  assert.equal(page.navigationCount, 1);
  assert.equal(page.currentUrl, baseConfiguration.messageDestination);
  assert.equal(page.enteredPin, undefined);
  assert.equal(page.skipClicked, true);
  assert.equal(page.composerReady, true);
  assert.deepEqual(page.loginTimeouts, []);
  assert.deepEqual(page.events, [
    'navigated',
    'conversation-verified',
    'composer-readiness-checked',
    'notification-checked',
    'notification-dismissed',
    'pin-prompt-checked',
    'pin-close-clicked',
    'confirmation-visible',
    'skip-clicked',
  ]);
});

test('startup detects login on the feed tab and navigates the configured Messenger tab', async () => {
  const destination = baseConfiguration.messageDestination!;
  const feedPage = new StartupPage(destination, 'no-pin');
  feedPage.loginGate.resolve();
  const messengerPage = new StartupPage(destination, 'no-pin');
  messengerPage.currentUrl = destination;
  messengerPage.loginDetected = true;
  messengerPage.loginIndicatorsAvailable = false;

  await prepareConfiguredBrowser(
    browserForStartupPage([feedPage, messengerPage]),
    baseConfiguration,
    { readinessTimeoutMs: 1_000 },
  );

  assert.equal(feedPage.navigationCount, 0);
  assert.equal(messengerPage.navigationCount, 1);
  assert.deepEqual(feedPage.gotoUrls, []);
  assert.deepEqual(messengerPage.gotoUrls, [destination]);
  assert.equal(messengerPage.currentUrl, destination);
});

test('startup opens Facebook in the existing blank tab when no Facebook tab is restored', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  page.currentUrl = 'about:blank';
  page.loginGate.resolve();

  await prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration);

  assert.deepEqual(page.gotoUrls, [
    baseConfiguration.startupUrl,
    baseConfiguration.messageDestination,
  ]);
});

test('startup detects login on a single Facebook tab', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  page.loginGate.resolve();

  await prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration);

  assert.equal(page.navigationCount, 1);
  assert.equal(page.loginDetected, true);
  assert.deepEqual(page.gotoUrls, [baseConfiguration.messageDestination]);
});

test('startup skips feed login indicators when already at the configured conversation', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  page.currentUrl = baseConfiguration.messageDestination!;
  page.loginIndicatorsAvailable = false;

  await prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration, {
    loginTimeoutMs: 10,
    readinessTimeoutMs: 1_000,
  });

  assert.equal(page.loginDetected, false);
  assert.equal(page.navigationCount, 1);
  assert.deepEqual(page.gotoUrls, [baseConfiguration.messageDestination]);
});

test('startup still requires login detection on another conversation or checkpoint redirect', async () => {
  const pageUrls = [
    'https://www.facebook.com/messages/t/999999999',
    'https://www.facebook.com/checkpoint/',
  ];

  for (const pageUrl of pageUrls) {
    const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
    page.currentUrl = pageUrl;
    page.loginIndicatorsAvailable = false;

    await assert.rejects(
      prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration, {
        loginTimeoutMs: 10,
      }),
      /Login detection timed out before all three visible Facebook indicators appeared/,
    );
    assert.deepEqual(page.gotoUrls, []);
  }
});

test('startup keeps waiting for manual login before navigating', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  const preparation = prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration, {
    loginTimeoutMs: 1_000,
  });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(page.navigationCount, 0);
  page.loginGate.resolve();
  await preparation;

  assert.equal(page.navigationCount, 1);
  assert.equal(page.loginDetected, true);
});

test('startup times out when multiple Facebook tabs have no sufficient login evidence', async () => {
  const destination = baseConfiguration.messageDestination!;
  const messengerPage = new StartupPage(destination, 'no-pin');
  messengerPage.currentUrl = 'https://www.facebook.com/messages/t/999999999';
  messengerPage.loginIndicatorsAvailable = false;
  const feedPage = new StartupPage(destination, 'no-pin');
  feedPage.loginIndicatorsAvailable = false;

  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage([messengerPage, feedPage]), baseConfiguration, {
      loginTimeoutMs: 10,
    }),
    /Login detection timed out before all three visible Facebook indicators appeared/,
  );

  assert.equal(messengerPage.navigationCount, 0);
  assert.equal(feedPage.navigationCount, 0);
});

test('startup reports login indicator page errors instead of relabeling them as timeouts', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  page.loginIndicatorError = new Error('Facebook tab target closed');

  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration, {
      loginTimeoutMs: 10,
    }),
    /Login detection could not confirm authentication across Facebook tabs: Facebook tab target closed/,
  );

  assert.equal(page.navigationCount, 0);
});

test('startup reports each blocker that appears after the initial checks', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'late-blockers');
  page.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), {
      ...baseConfiguration,
      skipPinRestoration: true,
      pin: null,
    }),
    /notification dialog: yes, PIN restoration dialog: yes, PIN skip-confirmation dialog: yes/,
  );
  assert.ok(
    page.events.indexOf('composer-readiness-checked') < page.events.indexOf('notification-checked'),
  );
});

test('startup aborts when the notification dialog cannot be dismissed', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'notification-dismiss-failure');
  page.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration),
    /push-notification dialog could not be dismissed/,
  );
  assert.equal(page.events.includes('pin-prompt-checked'), false);
});

test('startup rejects missing or invalid PINs before navigation when restoration is enabled', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'no-pin');
  page.loginGate.resolve();
  const missingPin = { ...baseConfiguration } as Partial<Configuration>;
  delete missingPin.pin;
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), missingPin as Configuration),
    /pin is required/,
  );
  assert.equal(page.navigationCount, 0);

  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), {
      ...baseConfiguration,
      pin: '12a456',
    }),
    /pin must contain exactly six digits/,
  );
  assert.equal(page.navigationCount, 0);
});

test('startup follows the configured skip-restoration flow without entering a PIN', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'skip-pin-multiple-close');
  page.loginGate.resolve();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(' '));
  try {
    await prepareConfiguredBrowser(browserForStartupPage(page), {
      ...baseConfiguration,
      skipPinRestoration: true,
      pin: null,
    }, { pinPromptTimeoutMs: 1_000 });
  } finally {
    console.log = originalLog;
  }

  assert.equal(page.enteredPin, undefined);
  assert.equal(page.clickedCloseIndex, 0);
  assert.equal(page.skipClicked, true);
  assert.equal(page.composerReady, true);
  assert.ok(logs.includes('Challenge 1: PIN restoration is disabled; skipping restoration.'));
});

test('startup restores chats with the configured PIN when skipping is disabled', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'pin-entry');
  page.loginGate.resolve();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(' '));
  try {
    await prepareConfiguredBrowser(browserForStartupPage(page), baseConfiguration, {
      pinPromptTimeoutMs: 1_000,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(page.enteredPin, baseConfiguration.pin);
  assert.ok(page.events.includes('pin-enter-pressed'));
  assert.equal(page.skipClicked, false);
  assert.equal(page.events.includes('pin-close-clicked'), false);
  assert.ok(logs.includes('Challenge 1: entering the configured PIN to restore chats.'));
});

test('startup fails when the configured PIN is rejected or restoration remains unresolved', async () => {
  const rejectedPage = new StartupPage(baseConfiguration.messageDestination!, 'pin-rejected');
  rejectedPage.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(rejectedPage), baseConfiguration, {
      pinPromptTimeoutMs: 1_000,
    }),
    /configured Messenger PIN was rejected/,
  );
  assert.equal(rejectedPage.enteredPin, baseConfiguration.pin);
  assert.equal(rejectedPage.skipClicked, false);

  const unresolvedPage = new StartupPage(baseConfiguration.messageDestination!, 'pin-unresolved');
  unresolvedPage.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(unresolvedPage), baseConfiguration, {
      pinPromptTimeoutMs: 1,
      readinessTimeoutMs: 1,
    }),
    /PIN restoration dialog did not disappear/,
  );
  assert.equal(unresolvedPage.enteredPin, baseConfiguration.pin);
  assert.equal(unresolvedPage.skipClicked, false);
});

test('startup aborts when the PIN skip confirmation does not disappear', async () => {
  const page = new StartupPage(baseConfiguration.messageDestination!, 'pin-skip-failure');
  page.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(page), {
      ...baseConfiguration,
      skipPinRestoration: true,
      pin: null,
    }, { pinPromptTimeoutMs: 1_000 }),
    /PIN skip confirmation dialog did not disappear/,
  );
});

test('startup does not report readiness for the wrong conversation or a missing composer', async () => {
  const wrongConversation = new StartupPage(baseConfiguration.messageDestination!, 'wrong-conversation');
  wrongConversation.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(wrongConversation), {
      ...baseConfiguration,
      skipPinRestoration: true,
      pin: null,
    }),
    /did not settle on conversation/,
  );

  const missingComposer = new StartupPage(baseConfiguration.messageDestination!, 'no-composer');
  missingComposer.loginGate.resolve();
  await assert.rejects(
    prepareConfiguredBrowser(browserForStartupPage(missingComposer), {
      ...baseConfiguration,
      skipPinRestoration: true,
      pin: null,
    }),
    /composer/,
  );
});

test('launches configured browser, connects to its configured port, then disconnects Playwright only', async t => {
  const port = await getAvailablePort();
  const config = { ...baseConfiguration, cdpPort: port };
  const { server, start } = createCdpServer();
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const child = new FakeProcess();
  const fileSystem = new FakeFileSystem();
  const browser = browserMock();
  let args: string[] = [];
  let connectEndpoint = '';
  let connectOptions: { noDefaults?: boolean } | undefined;
  let launchedEnvironment: NodeJS.ProcessEnv | undefined;
  let processScans = 0;
  const originalNvidiaApiKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'shell-key-must-not-reach-browser';
  t.after(() => {
    if (originalNvidiaApiKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = originalNvidiaApiKey;
    }
  });
  const session = await launchConfiguredBrowser(config, {
    platform: 'win32',
    fileSystem,
    findProfileProcesses: async () => {
      processScans += 1;
      return processScans === 1 ? [] : [child.pid];
    },
    spawnProcess: (executablePath, launchArgs, options) => {
      assert.equal(executablePath, config.executablePath);
      assert.equal(options.detached, true);
      launchedEnvironment = options.env;
      args = launchArgs;
      void start(port);
      return child;
    },
    connectOverCDP: async (endpoint, options) => {
      connectEndpoint = endpoint;
      connectOptions = options;
      return browser.browser as never;
    },
  });

  assert.deepEqual(fileSystem.directories, [config.profilePath]);
  assert.deepEqual(args, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profilePath}`,
  ]);
  assert.equal(connectEndpoint, `ws://127.0.0.1:${port}/devtools/browser/test-session`);
  assert.notEqual(connectOptions?.noDefaults, true);
  assert.equal(child.unrefCalls, 1);
  assert.equal(browser.calls.version, 1);
  assert.equal(launchedEnvironment?.NVIDIA_API_KEY, undefined);
  assert.equal(process.env.NVIDIA_API_KEY, 'shell-key-must-not-reach-browser');

  await session.disconnect();
  await session.disconnect();
  assert.equal(browser.calls.close, 1);
  assert.equal(server.listening, true);
  assert.equal(child.exited, false);
});

test('navigates a unique existing Facebook tab through CDP and disconnects Playwright only', async () => {
  const destination = 'https://www.facebook.com/messages/t/1618007223454558';
  let currentUrl = 'https://www.facebook.com/messages/';
  let navigationCount = 0;
  let disconnectCount = 0;
  let connectedEndpoint = '';
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    async goto(url: string) {
      navigationCount += 1;
      currentUrl = url;
    },
    async waitForLoadState() {},
    getByRole() {
      return { filter: () => ({ count: async () => 1 }) };
    },
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [{ pages: () => [page] }],
    async close() {
      disconnectCount += 1;
    },
  };

  await navigateConfiguredBrowserToMessageDestination(baseConfiguration, destination, {
    platform: 'win32',
    findProfileProcesses: async (executablePath, profilePath) => {
      assert.equal(executablePath, baseConfiguration.executablePath);
      assert.equal(profilePath, baseConfiguration.profilePath);
      return [12345];
    },
    connectOverCDP: async endpoint => {
      connectedEndpoint = endpoint;
      return browser as unknown as Browser;
    },
  });

  assert.equal(connectedEndpoint, `http://127.0.0.1:${baseConfiguration.cdpPort}`);
  assert.equal(navigationCount, 1);
  assert.equal(currentUrl, destination);
  assert.equal(disconnectCount, 1);
});

test('navigation verification failure disconnects Playwright and rejects the destination change', async () => {
  const destination = 'https://www.facebook.com/messages/t/1618007223454558';
  let disconnectCount = 0;
  const page = {
    isClosed: () => false,
    url: () => 'https://www.facebook.com/messages/t/999999999',
    async goto() {},
    async waitForLoadState() {},
    getByRole() {
      return { filter: () => ({ count: async () => 1 }) };
    },
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [{ pages: () => [page] }],
    async close() {
      disconnectCount += 1;
    },
  };

  await assert.rejects(navigateConfiguredBrowserToMessageDestination(
    baseConfiguration,
    destination,
    {
      platform: 'win32',
      findProfileProcesses: async () => [12345],
      connectOverCDP: async () => browser as unknown as Browser,
    },
  ), /Navigation verification failed/);
  assert.equal(disconnectCount, 1);
});

test('navigation failure disconnects Playwright without closing the browser', async () => {
  let disconnectCount = 0;
  const page = {
    isClosed: () => false,
    url: () => 'https://www.facebook.com/messages/',
    async goto() {
      throw new Error('navigation failed');
    },
    async waitForLoadState() {},
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [{ pages: () => [page] }],
    async close() {
      disconnectCount += 1;
    },
  };

  await assert.rejects(navigateConfiguredBrowserToMessageDestination(
    baseConfiguration,
    'https://www.facebook.com/messages/t/1618007223454558',
    {
      platform: 'win32',
      findProfileProcesses: async () => [12345],
      connectOverCDP: async () => browser as unknown as Browser,
    },
  ), /navigation failed/);
  assert.equal(disconnectCount, 1);
});

test('startup check accepts an existing profile browser with a usable CDP endpoint', async t => {
  const port = await getAvailablePort();
  const config = { ...baseConfiguration, cdpPort: port };
  const { server, start } = createCdpServer();
  await start(port);
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  await assertConfiguredBrowserCanStart(config, {
    platform: 'win32',
    findProfileProcesses: async (_executablePath, _profilePath, debuggingPort) => {
      assert.ok(debuggingPort === undefined || debuggingPort === port);
      return [9876];
    },
  });
});

test('refuses to launch when the configured profile is in use without a usable CDP endpoint', async () => {
  const child = new FakeProcess();
  let spawned = false;
  let connectAttempted = false;
  await assert.rejects(launchConfiguredBrowser(baseConfiguration, {
    platform: 'win32',
    findProfileProcesses: async (_executablePath, _profilePath, debuggingPort) =>
      debuggingPort === undefined ? [9876] : [],
    spawnProcess: () => {
      spawned = true;
      return child;
    },
    connectOverCDP: async () => {
      connectAttempted = true;
      throw new Error('must not attach');
    },
  }), /already in use by process\(es\) 9876.*close the configured browser completely/s);
  assert.equal(spawned, false);
  assert.equal(connectAttempted, false);
});

test('refuses to launch when an existing profile browser does not expose a usable CDP endpoint', async () => {
  const port = await getAvailablePort();
  let spawned = false;
  let connectAttempted = false;
  await assert.rejects(launchConfiguredBrowser({ ...baseConfiguration, cdpPort: port }, {
    platform: 'win32',
    connectionTimeoutMs: 50,
    pollIntervalMs: 10,
    findProfileProcesses: async () => [9876],
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
    connectOverCDP: async () => {
      connectAttempted = true;
      throw new Error('must not attach');
    },
  }), /already in use by process\(es\) 9876.*close the configured browser completely/s);
  assert.equal(spawned, false);
  assert.equal(connectAttempted, false);
});

test('attaches to an existing profile browser with a usable CDP endpoint', async t => {
  const port = await getAvailablePort();
  const config = { ...baseConfiguration, cdpPort: port };
  const { server, start } = createCdpServer();
  await start(port);
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const browser = browserMock();
  let spawned = false;
  let connectedEndpoint = '';
  const session = await launchConfiguredBrowser(config, {
    platform: 'win32',
    findProfileProcesses: async (_executablePath, _profilePath, debuggingPort) => {
      assert.ok(debuggingPort === undefined || debuggingPort === port);
      return [9876];
    },
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
    connectOverCDP: async endpoint => {
      connectedEndpoint = endpoint;
      return browser.browser as never;
    },
  });

  assert.equal(spawned, false);
  assert.equal(connectedEndpoint, `ws://127.0.0.1:${port}/devtools/browser/test-session`);
  assert.equal(browser.calls.version, 1);
  assert.equal(session.reusedExistingBrowser, true);

  await session.disconnect();
  await session.disconnect();
  assert.equal(browser.calls.close, 1);
  assert.equal(server.listening, true);
});

test('graceful close targets only the configured executable and profile, then verifies process exit', async () => {
  let processScans = 0;
  let closeTargets: number[] = [];
  let now = 0;
  const options: BrowserCloseOptions = {
    platform: 'win32',
    findProfileProcesses: async (executablePath, profilePath) => {
      assert.equal(executablePath, baseConfiguration.executablePath);
      assert.equal(profilePath, baseConfiguration.profilePath);
      processScans += 1;
      return processScans === 1 ? [12345] : [];
    },
    requestProcessClose: async processIds => {
      closeTargets = processIds;
    },
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds;
    },
  };

  await closeConfiguredBrowser(baseConfiguration, options);

  assert.deepEqual(closeTargets, [12345]);
  assert.equal(processScans, 2);
});

test('graceful close does not request closure when no dedicated-profile process exists', async () => {
  let closeRequested = false;
  await closeConfiguredBrowser(baseConfiguration, {
    platform: 'win32',
    findProfileProcesses: async () => [],
    requestProcessClose: async () => {
      closeRequested = true;
    },
  });

  assert.equal(closeRequested, false);
});

test('graceful close reports a timeout instead of forcing process termination', async () => {
  let now = 0;
  let closeRequests = 0;
  await assert.rejects(closeConfiguredBrowser(baseConfiguration, {
    platform: 'win32',
    shutdownTimeoutMs: 10,
    pollIntervalMs: 5,
    findProfileProcesses: async () => [12345],
    requestProcessClose: async () => {
      closeRequests += 1;
    },
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds;
    },
  }), /Timed out waiting/);

  assert.equal(closeRequests, 1);
});

test('refuses an occupied CDP port rather than connecting to its listener', async t => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  let spawned = false;
  await assert.rejects(launchConfiguredBrowser({ ...baseConfiguration, cdpPort: address.port }, {
    platform: 'win32',
    findProfileProcesses: async () => [],
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
  }), /already in use; refusing to attach/);
  assert.equal(spawned, false);
});

test('reports an early browser process exit without terminating its process tree', async () => {
  const port = await getAvailablePort();
  const child = new FakeProcess();
  await assert.rejects(launchConfiguredBrowser({ ...baseConfiguration, cdpPort: port }, {
    platform: 'win32',
    startupTimeoutMs: 50,
    pollIntervalMs: 5,
    fileSystem: new FakeFileSystem(),
    findProfileProcesses: async () => [],
    spawnProcess: () => {
      queueMicrotask(() => child.exit(2));
      return child;
    },
  }), /exited before its CDP endpoint became ready/);
});

test('unsupported platform fails before creating the profile or spawning a process', async () => {
  const fileSystem = new FakeFileSystem();
  let spawned = false;
  await assert.rejects(launchConfiguredBrowser(baseConfiguration, {
    platform: 'linux',
    fileSystem,
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
  }), /not supported/);
  assert.deepEqual(fileSystem.directories, []);
  assert.equal(spawned, false);
});
