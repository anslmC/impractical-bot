import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { InitializationOptions, InitializationStatus, TerminalPrompt } from '../src/browser/initialization.js';
import { runCli, type CliRuntimeOptions } from '../src/cli.js';
import { NvidiaApiKeyError } from '../src/ai/nvidia.js';
import type { BrowserLaunchSession } from '../src/browser/launch.js';
import {
  MAX_PERSONALITY_INSTRUCTION_CHARS,
  loadConfiguration,
  saveConfiguration,
  type Configuration,
} from '../src/config/configuration.js';
import { generateAliases } from '../src/components/alias-engine.js';
import type { BackreadResult } from '../src/components/backread.js';
import type { CombustionController } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';
import {
  getRuntimeControlEndpoint,
  requestRuntimeChangeDestination,
  requestRuntimePause,
  requestRuntimeResume,
  requestRuntimeSetPersonality,
  requestRuntimeSetTemperament,
  requestRuntimeStatusSnapshot,
  RuntimeControlEndpointError,
  RuntimeControlTimeoutError,
} from '../src/runtime-control.js';

async function captureCli(
  args: string[],
  configurationFilePath?: string,
  prompt?: TerminalPrompt,
  initialize?: (options: InitializationOptions) => Promise<InitializationStatus>,
  runtime?: CliRuntimeOptions,
  observeOutput?: (message: string) => void,
) {
  const output: string[] = [];
  const errors: string[] = [];
  const testRuntime: CliRuntimeOptions = {
    ...runtime,
    checkBrowserStartup: runtime?.checkBrowserStartup ?? (async () => undefined),
    closeBrowser: runtime?.closeBrowser ?? (async () => undefined),
    startCombustion: runtime?.startCombustion ?? (async () => createTestCombustionController()),
  };
  const exitCode = await runCli(
    args,
    message => {
      output.push(message);
      observeOutput?.(message);
    },
    message => errors.push(message),
    configurationFilePath,
    prompt,
    initialize,
    testRuntime,
  );
  return { exitCode, output, errors };
}

function createTestCombustionController(
  onStop?: () => void,
  onPause?: () => void,
  onResume?: () => void,
  onChangeDestination?: CombustionController['changeDestination'],
  onSetTemperament?: CombustionController['setTemperament'],
  onSetPersonality?: CombustionController['setPersonality'],
): CombustionController {
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => {
    resolveStopped = resolve;
  });
  return {
    stopped,
    async pause() {
      onPause?.();
    },
    async resume() {
      onResume?.();
    },
    setTemperament(temperament) {
      onSetTemperament?.(temperament);
    },
    setPersonality(mode, customInstruction) {
      onSetPersonality?.(mode, customInstruction);
    },
    async changeDestination(destination, options) {
      if (onChangeDestination) {
        return onChangeDestination(destination, options);
      }
      await options.persist?.(destination);
      if (options.resume) {
        onResume?.();
      }
      return { status: 'changed', resumed: options.resume };
    },
    async stop() {
      onStop?.();
      resolveStopped();
    },
  };
}

async function startTestEngine(
  configurationFilePath: string,
  createController: () => CombustionController = () => createTestCombustionController(),
) {
  const ready = deferred<void>();
  const shutdown = deferred<void>();
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createController(),
    waitForShutdown: () => shutdown.promise,
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  return {
    async stop() {
      const stopped = await captureCli(['stop'], configurationFilePath);
      assert.equal(stopped.exitCode, 0);
      shutdown.resolve();
      return start;
    },
  };
}

function createTemporaryConfigPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-cli-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
}

function saveApplicationApiKey(configurationFilePath: string, apiKey = 'nvapi-test-key'): string {
  const environmentFilePath = join(dirname(configurationFilePath), '.env');
  writeFileSync(environmentFilePath, `NVIDIA_API_KEY=${apiKey}\n`);
  return environmentFilePath;
}

const validConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\brave-profile',
  skipPinRestoration: false,
  pin: '001234',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
  messageDestination: 'https://www.facebook.com/messages/t/1618007223454558',
  botTemperament: 'balanced',
  botPersonality: 'default',
};
const profileButton = {
  count: async () => 1,
  isVisible: async () => true,
  isEnabled: async () => true,
  click: async () => undefined,
};
const profileLink = {
  count: async () => 1,
  isVisible: async () => true,
  getAttribute: async () => '/me/',
  innerText: async () => 'Test Puppet',
};
const profileDialog = {
  waitFor: async () => undefined,
  locator: (selector: string) => {
    assert.equal(selector, 'a[href="/me/"]');
    return profileLink;
  },
};
const stubPage = {
  getByRole: (role: string, options: { name: string }) => {
    if (role === 'button' && options.name === 'Account, your profile') return profileButton;
    if (role === 'dialog' && options.name === 'Your profile') return profileDialog;
    throw new Error(`Unexpected role lookup: ${role} ${options.name}`);
  },
  keyboard: { press: async () => undefined },
} as unknown as Page;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('start prepares the destination, remains alive after readiness, and closes the launched browser on shutdown', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  let receivedConfiguration: Configuration | undefined;
  let disconnects = 0;
  const events: string[] = [];
  let validationCalls = 0;
  const backreadResult: BackreadResult = {
    diagnostics: [],
    messages: [{
      id: 'message-1',
      timestamp: {
        original: 'October 18, 2026, 1:15 PM',
        normalized: '2026-10-18T13:15:00',
        resolved: true,
      },
      ariaLabel: 'At October 18, 2026, 1:15 PM, You: hello',
      message: 'hello',
      sender: 'You',
      direction: 'OUTGOING',
    }, {
      id: 'message-2',
      timestamp: { original: 'Friday 19:35', normalized: null, resolved: false },
      ariaLabel: null,
      message: '',
      sender: 'UNKNOWN',
      direction: 'UNKNOWN',
    }],
  };
  const prepareStarted = deferred<void>();
  const preparation = deferred<void>();
  const shutdown = deferred<void>();
  const seededStore = createContextStore();
  const addSeededMessages = seededStore.add.bind(seededStore);
  seededStore.add = messages => {
    events.push('store-seeded');
    addSeededMessages(messages);
  };
  const session: BrowserLaunchSession = {
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    browserVersion: 'Brave Chromium test',
    disconnected: new Promise<void>(() => undefined),
    async prepare() {
      prepareStarted.resolve();
      await preparation.promise;
      events.push('prepared');
      return stubPage;
    },
    async isWindowMinimized() {
      events.push('window-state-checked');
      return true;
    },
    async disconnect() {
      disconnects += 1;
      events.push('disconnected');
    },
  };
  const runtime: CliRuntimeOptions = {
    launchBrowser: async configuration => {
      receivedConfiguration = configuration;
      events.push('launched');
      return session;
    },
    closeBrowser: async () => {
      events.push('browser-closed');
    },
    validateNvidiaApiKey: async apiKey => {
      assert.equal(apiKey, 'nvapi-test-key');
      validationCalls += 1;
      events.push(`validated-${validationCalls}`);
    },
    readMessengerMessages: async page => {
      assert.equal(page, stubPage);
      events.push('read-messages');
      return backreadResult;
    },
    createContextStore: () => {
      events.push('store-created');
      return seededStore;
    },
    generateNvidiaReply: async (apiKey, messages) => {
      assert.equal(apiKey, 'nvapi-test-key');
      assert.deepEqual(messages, backreadResult.messages);
      events.push('generate-reply');
      return 'Generated reply';
    },
    composeMessengerReply: async (page, reply) => {
      assert.equal(page, stubPage);
      assert.equal(reply, 'Generated reply');
      events.push('compose-reply');
      return { status: 'sent' };
    },
    startCombustion: async options => {
      assert.equal(options.page, stubPage);
      assert.equal(options.contextStore, seededStore);
      assert.deepEqual(options.contextStore.getRecent(2), [
        {
          messageId: 'message-1',
          message: 'hello',
          sender: 'You',
          direction: 'OUTGOING',
          timestamp: {
            original: 'October 18, 2026, 1:15 PM',
            normalized: '2026-10-18T13:15:00',
            resolved: true,
          },
          ariaLabel: 'At October 18, 2026, 1:15 PM, You: hello',
        },
        {
          messageId: 'message-2',
          message: '',
          sender: 'UNKNOWN',
          direction: 'UNKNOWN',
          timestamp: { original: 'Friday 19:35', normalized: null, resolved: false },
          ariaLabel: null,
        },
      ]);
      events.push('combustion-started');
      events.push('context-store-verified');
      return createTestCombustionController(() => events.push('combustion-stopped'));
    },
    waitForShutdown: () => shutdown.promise,
  };

  const start = captureCli(
    ['start'],
    configurationFilePath,
    async () => null,
    undefined,
    runtime,
    message => {
      if (message.startsWith('Puppet account name updated')) events.push('puppet-name-saved');
      if (message.includes('Alias engine initialized')) events.push('aliases-initialized');
      if (message.includes('Engine ready')) events.push('engine-ready-logged');
    },
  );
  let settled = false;
  void start.then(() => {
    settled = true;
  });
  await prepareStarted.promise;
  preparation.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(disconnects, 0);
  shutdown.resolve();
  const result = await start;

  assert.equal(result.exitCode, 130);
  assert.deepEqual(receivedConfiguration, { ...validConfiguration, puppetName: 'Test Puppet' });
  assert.equal(disconnects, 1);
  assert.equal(validationCalls, 1);
  assert.deepEqual(events, [
    'validated-1',
    'launched',
    'prepared',
    'puppet-name-saved',
    'aliases-initialized',
    'window-state-checked',
    'read-messages',
    'store-created',
    'store-seeded',
    'combustion-started',
    'context-store-verified',
    'engine-ready-logged',
    'combustion-stopped',
    'disconnected',
    'browser-closed',
  ]);
  assert.deepEqual(result.output, [
    '\n[STARTUP] Verifying browser configuration.',
    '\n[BROWSER] Browser configuration verified.',
    '\n[STARTUP] NVIDIA API key validated successfully.',
    '\n[BROWSER] Launching browser session.',
    '\n[BROWSER] Browser launched and connected (Brave Chromium test).',
    '\n[CRANKING] Preparing Messenger context.',
    'Puppet account name updated: "Test Puppet".',
    `\n[ALIASES] DEBUG: Alias engine initialized for puppet name "Test Puppet" (${generateAliases('Test Puppet').valids.length} aliases).`,
    'WARNING: Browser is minimized. Backread may collect fewer messages than expected.',
    '\n[BACKREAD] Reading historical Messenger messages.',
    '\n[BACKREAD] Retrieved 2 messages; expected 30.',
    '\n[CONTEXT] Historical context seeded: 2 messages.',
    `\n[READY] Engine ready at ${validConfiguration.messageDestination}.`,
    'Shutdown requested; disconnecting Playwright.',
  ]);
  assert.deepEqual(result.errors, []);
  const savedConfiguration = loadConfiguration(configurationFilePath);
  assert.equal(savedConfiguration.status, 'valid');
  if (savedConfiguration.status === 'valid') {
    assert.equal(savedConfiguration.configuration.puppetName, 'Test Puppet');
  }
});

test('start rejects a conflicting browser profile before NVIDIA validation', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  let checkCalls = 0;
  let validationCalls = 0;
  let launchCalls = 0;
  const conflictMessage =
    'The configured browser profile is already in use by process(es) 23884, 24716. ' +
    'The existing browser cannot be safely attached through CDP port 9222; ' +
    'close the configured browser completely before starting impractical-bot.';

  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    checkBrowserStartup: async configuration => {
      checkCalls += 1;
      assert.deepEqual(configuration, validConfiguration);
      throw new Error(conflictMessage);
    },
    validateNvidiaApiKey: async () => {
      validationCalls += 1;
    },
    launchBrowser: async () => {
      launchCalls += 1;
      throw new Error('must not launch');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(checkCalls, 1);
  assert.equal(validationCalls, 0);
  assert.equal(launchCalls, 0);
  assert.deepEqual(result.errors, [`Unable to start browser: ${conflictMessage}`]);
  assert.deepEqual(result.output, ['\n[STARTUP] Verifying browser configuration.']);
});

test('start preserves the saved puppet name and continues when profile retrieval fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration({ ...validConfiguration, puppetName: 'Existing Puppet' }, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const shutdown = deferred<void>();
  const failingPage = {
    getByRole: () => {
      throw new Error('profile control unavailable');
    },
  } as unknown as Page;
  let disconnects = 0;
  const result = await captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    {
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => ({
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return failingPage;
        },
        async disconnect() {
          disconnects += 1;
        },
      }),
      readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
      waitForShutdown: () => shutdown.promise,
    },
    message => {
      if (message.includes('Engine ready')) shutdown.resolve();
    },
  );

  assert.equal(result.exitCode, 130);
  const retrievalFailureIndex = result.output.findIndex(message =>
    message.startsWith('Puppet account name retrieval failed')
  );
  const readyIndex = result.output.findIndex(message => message.includes('Engine ready'));
  assert.ok(retrievalFailureIndex >= 0);
  assert.ok(readyIndex > retrievalFailureIndex);
  assert.equal(disconnects, 1);
  assert.deepEqual(result.errors, []);
  const savedConfiguration = loadConfiguration(configurationFilePath);
  assert.equal(savedConfiguration.status, 'valid');
  if (savedConfiguration.status === 'valid') {
    assert.equal(savedConfiguration.configuration.puppetName, 'Existing Puppet');
  }
});

test('start preserves configuration persisted while the engine was starting', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const shutdown = deferred<void>();
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => {
      // Another process persists a change during the startup window.
      saveConfiguration(
        { ...validConfiguration, botTemperament: 'talkative' },
        configurationFilePath,
      );
      return {
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          return undefined;
        },
      };
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    waitForShutdown: () => shutdown.promise,
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'talkative');
    assert.equal(saved.configuration.puppetName, 'Test Puppet');
  }
  shutdown.resolve();
  assert.equal((await start).exitCode, 130);
});

test('start debug mode skips NVIDIA validation and keeps backread read-only', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const originalDebugMode = process.env.IMPRACTICAL_BOT_DEBUG;
  process.env.IMPRACTICAL_BOT_DEBUG = '1';
  let validationCalls = 0;
  let generationCalls = 0;
  let compositionCalls = 0;
  let disconnects = 0;
  const backreadStarted = deferred<void>();
  const shutdown = deferred<void>();
  const session: BrowserLaunchSession = {
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    browserVersion: 'Brave Chromium test',
    disconnected: new Promise<void>(() => undefined),
    async prepare() {
      return stubPage;
    },
    async disconnect() {
      disconnects += 1;
    },
  };

  try {
    const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
      launchBrowser: async () => session,
      validateNvidiaApiKey: async () => {
        validationCalls += 1;
      },
      readMessengerMessages: async () => {
        backreadStarted.resolve();
        return { diagnostics: ['debug backread diagnostic'], messages: [] };
      },
      generateNvidiaReply: async () => {
        generationCalls += 1;
        return 'unexpected reply';
      },
      composeMessengerReply: async () => {
        compositionCalls += 1;
        return { status: 'sent' };
      },
      waitForShutdown: () => shutdown.promise,
    });

    await backreadStarted.promise;
    shutdown.resolve();
    const result = await start;

    assert.equal(result.exitCode, 130);
    assert.equal(validationCalls, 0);
    assert.equal(generationCalls, 0);
    assert.equal(compositionCalls, 0);
    assert.equal(disconnects, 1);
    assert.ok(result.output.some(message =>
      message.includes('Debug mode enabled; skipping NVIDIA API key validation.'),
    ));
    assert.ok(result.output.some(message => message.includes('debug backread diagnostic')));
    assert.deepEqual(result.errors, []);
  } finally {
    if (originalDebugMode === undefined) {
      delete process.env.IMPRACTICAL_BOT_DEBUG;
    } else {
      process.env.IMPRACTICAL_BOT_DEBUG = originalDebugMode;
    }
  }
});

test('start aborts and disconnects when backreading fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const backreadStarted = deferred<void>();
  let combustionStarted = false;
  let disconnects = 0;
  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
    readMessengerMessages: async () => {
      backreadStarted.resolve();
      throw new Error('private page details');
    },
    startCombustion: async () => {
      combustionStarted = true;
      return createTestCombustionController();
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(combustionStarted, false);
  assert.equal(disconnects, 1);
  assert.ok(result.errors.some(message => message.includes('Unable to read Messenger messages.')));
  assert.deepEqual(result.errors, [
    'Unable to crank engine: Unable to read Messenger messages.',
  ]);
  await backreadStarted.promise;
  assert.ok(!result.errors.join('\n').includes('private page details'));
});

test('start accepts empty and partial Backread results after seeding', async context => {
  const scenarios: { name: string; messages: BackreadResult['messages'] }[] = [
    { name: 'empty', messages: [] },
    {
      name: 'partial',
      messages: [{
        id: 'partial-1',
        timestamp: { original: '10:15 AM', normalized: null, resolved: false },
        ariaLabel: null,
        message: 'A partial history is still usable.',
        sender: 'Alex',
        direction: 'INCOMING',
      }],
    },
  ];

  for (const scenario of scenarios) {
    const configurationFilePath = createTemporaryConfigPath(context);
    saveConfiguration(validConfiguration, configurationFilePath);
    saveApplicationApiKey(configurationFilePath);
    const shutdown = deferred<void>();
    const combustionStarted = deferred<void>();
    const contextStore = createContextStore();
    let disconnects = 0;
    const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => ({
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          disconnects += 1;
        },
      }),
      readMessengerMessages: async () => ({ diagnostics: [], messages: scenario.messages }),
      createContextStore: () => contextStore,
      startCombustion: async options => {
        assert.equal(options.contextStore, contextStore);
        assert.equal(options.contextStore.getState().size, scenario.messages.length);
        assert.deepEqual(
          options.contextStore.getRecent(30).map(message => message.messageId),
          scenario.messages.map(message => message.id),
        );
        combustionStarted.resolve();
        return createTestCombustionController();
      },
      waitForShutdown: () => shutdown.promise,
    });

    await combustionStarted.promise;
    shutdown.resolve();
    const result = await start;

    assert.equal(result.exitCode, 130, scenario.name);
    assert.equal(disconnects, 1, scenario.name);
    assert.deepEqual(result.errors, [], scenario.name);
  }
});

test('start does not pass a partially seeded store to Combustion', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const contextStore = createContextStore();
  let combustionStarted = false;
  let disconnects = 0;
  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
    readMessengerMessages: async () => ({
      diagnostics: [],
      messages: [
        {
          id: 'valid-first',
          timestamp: { original: null, normalized: null, resolved: false },
          ariaLabel: null,
          message: 'Seeded before the invalid record.',
          sender: 'Alex',
          direction: 'INCOMING',
        },
        {
          id: '',
          timestamp: { original: null, normalized: null, resolved: false },
          ariaLabel: null,
          message: 'Invalid message ID.',
          sender: 'Alex',
          direction: 'INCOMING',
        },
      ],
    }),
    createContextStore: () => contextStore,
    startCombustion: async () => {
      combustionStarted = true;
      return createTestCombustionController();
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(combustionStarted, false);
  assert.equal(disconnects, 1);
  assert.equal(contextStore.getState().size, 1);
  assert.deepEqual(result.errors, [
    'Unable to crank engine: Unable to seed historical message context.',
  ]);
});

test('start disconnects the session when Combustion initialization fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  let disconnects = 0;
  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => {
      throw new Error('observer could not initialize');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(disconnects, 1);
  assert.deepEqual(result.errors, [
    'Unable to start Combustion: observer could not initialize',
  ]);
});

test('start disconnects the session when shutdown is requested during launch', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const launchStarted = deferred<void>();
  const launchCompletion = deferred<BrowserLaunchSession>();
  const shutdown = deferred<void>();
  let prepareCalls = 0;
  let disconnects = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => {
      launchStarted.resolve();
      return launchCompletion.promise;
    },
    waitForShutdown: () => shutdown.promise,
  });

  await launchStarted.promise;
  shutdown.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  launchCompletion.resolve({
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    browserVersion: 'Brave Chromium test',
    disconnected: new Promise<void>(() => undefined),
    async prepare() {
      prepareCalls += 1;
      return stubPage;
    },
    async disconnect() {
      disconnects += 1;
    },
  });
  const result = await start;

  assert.equal(result.exitCode, 130);
  assert.equal(prepareCalls, 0);
  assert.equal(disconnects, 1);
  assert.ok(!result.output.some(message => message.includes('Engine ready')));
});

test('start disconnects Playwright and does not report readiness when preparation fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  let disconnects = 0;
  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        throw new Error('login detection timed out');
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(disconnects, 1);
  assert.ok(!result.output.some(message => message.includes('Engine ready')));
  assert.match(result.errors[0], /login detection timed out/);
});

test('start exits with an error and disconnects when CDP disconnects unexpectedly', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const disconnected = deferred<void>();
  const preparationStarted = deferred<void>();
  const preparation = deferred<void>();
  let disconnects = 0;
  const resultPromise = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: disconnected.promise,
      async prepare() {
        preparationStarted.resolve();
        await preparation.promise;
        return stubPage;
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
  });

  await preparationStarted.promise;
  disconnected.resolve();
  const result = await resultPromise;

  assert.equal(result.exitCode, 1);
  assert.equal(disconnects, 1);
  assert.ok(!result.output.some(message => message.includes('Engine ready')));
  assert.match(result.errors[0], /disconnected/);
});

test('start reports missing configuration without launching a browser', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  let launchAttempted = false;
  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
    launchBrowser: async () => {
      launchAttempted = true;
      throw new Error('must not launch');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(launchAttempted, false);
  assert.match(result.errors[0], /Run `impbot init` first/);
});

test('start ignores a shell-only key and does not launch without an application key', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const originalKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'shell-key-must-not-be-used';
  let launchAttempted = false;

  try {
    const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error('must not launch');
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(launchAttempted, false);
    assert.match(result.errors[0], /NVIDIA API key is missing/);
  } finally {
    if (originalKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = originalKey;
    }
  }
});

test('start does not launch a browser after NVIDIA authentication, network, or service failures', async context => {
  for (const kind of ['authentication', 'network', 'service'] as const) {
    const configurationFilePath = createTemporaryConfigPath(context);
    saveConfiguration(validConfiguration, configurationFilePath);
    saveApplicationApiKey(configurationFilePath);
    let launchAttempted = false;

    const result = await captureCli(['start'], configurationFilePath, undefined, undefined, {
      validateNvidiaApiKey: async () => {
        throw new NvidiaApiKeyError(kind, `safe ${kind} failure`);
      },
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error('must not launch');
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(launchAttempted, false);
    assert.match(result.errors[0], new RegExp(`safe ${kind} failure`));
  }
});

test('init refuses to run while an engine is running without prompting or initializing', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let initializeCalls = 0;
  let promptCalls = 0;

  const result = await captureCli(
    ['init'],
    configurationFilePath,
    async () => {
      promptCalls += 1;
      return null;
    },
    async () => {
      initializeCalls += 1;
      return 'saved';
    },
    {
      requestRuntimeStatus: async path => {
        assert.equal(path, configurationFilePath);
        return { status: 'running', instanceId: 'engine-instance' };
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(initializeCalls, 0);
  assert.equal(promptCalls, 0);
  assert.match(result.errors[0], /impbot stop/);
  assert.match(result.errors[0], /no configuration was changed/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('init fails closed when runtime status cannot be determined', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let initializeCalls = 0;
  let promptCalls = 0;

  const result = await captureCli(
    ['init'],
    configurationFilePath,
    async () => {
      promptCalls += 1;
      return null;
    },
    async () => {
      initializeCalls += 1;
      return 'saved';
    },
    {
      requestRuntimeStatus: async () => {
        throw new Error('The runtime-control endpoint could not be queried.');
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(initializeCalls, 0);
  assert.equal(promptCalls, 0);
  assert.deepEqual(result.errors, [
    'Unable to check whether impractical-bot is running: ' +
    'The runtime-control endpoint could not be queried.',
  ]);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('init prompts for and saves a missing key after existing setup succeeds', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const submittedKey = 'nvapi-init-test-key';
  const secretPrompts: string[] = [];
  let validatedKey = '';

  const result = await captureCli(
    ['init'],
    configurationFilePath,
    async () => { throw new Error('the API key prompt must be hidden'); },
    async () => 'preserved',
    {
      promptSecret: async question => {
        secretPrompts.push(question);
        return submittedKey;
      },
      validateNvidiaApiKey: async key => {
        validatedKey = key;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(secretPrompts.length, 1);
  assert.match(secretPrompts[0], /NVIDIA API key/);
  assert.equal(validatedKey, submittedKey);
  assert.ok(readFileSync(join(dirname(configurationFilePath), '.env'), 'utf8').includes(submittedKey));
  assert.ok(!result.output.join('\n').includes(submittedKey));
  assert.ok(!result.errors.join('\n').includes(submittedKey));
});

test('repeated init preserves an existing key without prompting or revalidating', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-existing-key');
  const originalContent = readFileSync(environmentFilePath, 'utf8');
  let promptCalls = 0;
  let validationCalls = 0;

  const result = await captureCli(
    ['init'],
    configurationFilePath,
    undefined,
    async () => 'preserved',
    {
      promptSecret: async () => {
        promptCalls += 1;
        return 'nvapi-unexpected-key';
      },
      validateNvidiaApiKey: async () => {
        validationCalls += 1;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(promptCalls, 0);
  assert.equal(validationCalls, 0);
  assert.equal(readFileSync(environmentFilePath, 'utf8'), originalContent);
});

test('init does not save a key when validation fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const submittedKey = 'nvapi-rejected-init-key';

  const result = await captureCli(
    ['init'],
    configurationFilePath,
    undefined,
    async () => 'saved',
    {
      promptSecret: async () => submittedKey,
      validateNvidiaApiKey: async () => {
        throw new NvidiaApiKeyError('authentication', 'NVIDIA rejected the API key.');
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(join(dirname(configurationFilePath), '.env')), false);
  assert.ok(!result.output.join('\n').includes(submittedKey));
  assert.ok(!result.errors.join('\n').includes(submittedKey));
});

test('updatekey validates and saves a replacement key while no engine is running', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-old-key');
  const submittedKey = 'nvapi-new-key';
  let prompted = false;

  const result = await captureCli(['updatekey'], configurationFilePath, undefined, undefined, {
    requestRuntimeStatus: async () => ({ status: 'not-running' }),
    promptSecret: async question => {
      prompted = true;
      assert.match(question, /replacement NVIDIA API key/);
      return submittedKey;
    },
    validateNvidiaApiKey: async key => {
      assert.equal(key, submittedKey);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(prompted, true);
  assert.ok(readFileSync(environmentFilePath, 'utf8').includes(submittedKey));
  assert.ok(!result.output.join('\n').includes(submittedKey));
  assert.ok(!result.errors.join('\n').includes(submittedKey));
});

test('updatekey preserves the existing key when replacement validation fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-working-key');
  const originalContent = readFileSync(environmentFilePath, 'utf8');
  const submittedKey = 'nvapi-rejected-key';

  const result = await captureCli(['updatekey'], configurationFilePath, undefined, undefined, {
    requestRuntimeStatus: async () => ({ status: 'not-running' }),
    promptSecret: async () => submittedKey,
    validateNvidiaApiKey: async () => {
      throw new NvidiaApiKeyError('authentication', 'NVIDIA rejected the API key.');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(readFileSync(environmentFilePath, 'utf8'), originalContent);
  assert.ok(!result.output.join('\n').includes(submittedKey));
  assert.ok(!result.errors.join('\n').includes(submittedKey));
});

test('changebrowser updates configuration after closing the current browser without launching the new one', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  const previousProfilePath = join(dirname(configurationFilePath), 'brave-profile');
  mkdirSync(previousProfilePath);
  const currentConfiguration = {
    ...validConfiguration,
    profilePath: previousProfilePath,
    skipPinRestoration: true,
    pin: null,
  };
  saveConfiguration(currentConfiguration, configurationFilePath);
  const newExecutablePath = 'C:\\Portable\\chrome.exe';
  let closedConfiguration: Configuration | undefined;
  let launchAttempted = false;
  const promptAnswers = ['y', 'n', '000042'];
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => promptAnswers.shift() ?? null,
    undefined,
    {
      discoverBrowsers: async () => [{
        browser: 'chrome',
        displayName: 'Google Chrome',
        executablePath: newExecutablePath,
      }],
      browserExecutableExists: () => true,
      closeBrowser: async configuration => {
        closedConfiguration = configuration;
      },
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error('must not launch');
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(closedConfiguration, currentConfiguration);
  assert.equal(launchAttempted, false);
  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(previousProfilePath), true);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.deepEqual(saved.configuration, {
      ...currentConfiguration,
      browser: 'chrome',
      executablePath: newExecutablePath,
      profilePath: join(dirname(configurationFilePath), 'chrome-profile'),
      skipPinRestoration: false,
      pin: '000042',
    });
  }
});

test('changebrowser cancellation does not ask for or change the PIN preference', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  const configuration = { ...validConfiguration, skipPinRestoration: true, pin: null };
  saveConfiguration(configuration, configurationFilePath);
  const promptCalls: string[] = [];
  let closeAttempted = false;

  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async question => {
      promptCalls.push(question);
      return '0';
    },
    undefined,
    {
      discoverBrowsers: async () => [
        {
          browser: 'brave',
          displayName: 'Brave Browser',
          executablePath: validConfiguration.executablePath,
        },
        {
          browser: 'chrome',
          displayName: 'Google Chrome',
          executablePath: 'C:\\Portable\\chrome.exe',
        },
      ],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closeAttempted = true;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(promptCalls.length, 1);
  assert.match(promptCalls[0], /Select a browser/);
  assert.equal(closeAttempted, false);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration,
  });
});

test('changebrowser retains the same browser profile when its executable path changes', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  const previousProfilePath = join(dirname(configurationFilePath), 'brave-profile');
  mkdirSync(previousProfilePath);
  const configuration = {
    ...validConfiguration,
    profilePath: previousProfilePath,
  };
  saveConfiguration(configuration, configurationFilePath);
  const promptAnswers = ['y', 'yes'];

  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => promptAnswers.shift() ?? null,
    undefined,
    {
      discoverBrowsers: async () => [{
        browser: 'brave',
        displayName: 'Brave Browser',
        executablePath: 'C:\\Portable\\brave.exe',
      }],
      browserExecutableExists: () => true,
      closeBrowser: async () => undefined,
    },
  );

  assert.equal(result.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.deepEqual(saved.configuration, {
      ...configuration,
      executablePath: 'C:\\Portable\\brave.exe',
      skipPinRestoration: true,
      pin: null,
    });
  }
  assert.equal(existsSync(previousProfilePath), true);
});

test('changebrowser leaves configuration untouched when the executable is unavailable', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let closeAttempted = false;
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => 'y',
    undefined,
    {
      discoverBrowsers: async () => [{
        browser: 'edge',
        displayName: 'Microsoft Edge',
        executablePath: 'C:\\Portable\\msedge.exe',
      }],
      browserExecutableExists: () => false,
      closeBrowser: async () => {
        closeAttempted = true;
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(closeAttempted, false);
  assert.match(result.errors[0], /unavailable/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('changebrowser leaves configuration untouched when discovery fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let closeAttempted = false;
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    undefined,
    undefined,
    {
      discoverBrowsers: async () => {
        throw new Error('registry and PATH unavailable');
      },
      closeBrowser: async () => {
        closeAttempted = true;
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(closeAttempted, false);
  assert.match(result.errors[0], /Unable to discover browsers/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('changebrowser rejects an unsupported executable before closing the current browser', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let closeAttempted = false;
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => 'y',
    undefined,
    {
      discoverBrowsers: async () => [{
        browser: 'chrome',
        displayName: 'Google Chrome',
        executablePath: 'C:\\Portable\\firefox.exe',
      }],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closeAttempted = true;
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(closeAttempted, false);
  assert.match(result.errors[0], /invalid/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('changebrowser leaves configuration untouched when graceful browser closure fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => 'y',
    undefined,
    {
      discoverBrowsers: async () => [{
        browser: 'edge',
        displayName: 'Microsoft Edge',
        executablePath: 'C:\\Portable\\msedge.exe',
      }],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        throw new Error('shutdown timed out');
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.errors[0], /shutdown timed out/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('changebrowser gracefully stops a running engine before switching browsers', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  const configuration: Configuration = { ...validConfiguration, puppetName: 'Test Puppet' };
  saveConfiguration(configuration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  context.after(async () => {
    await captureCli(['stop'], configurationFilePath);
  });
  const ready = deferred<void>();
  const events: string[] = [];
  let engineCloses = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        events.push('playwright-disconnected');
      },
    }),
    closeBrowser: async () => {
      engineCloses += 1;
      events.push('engine-closed-browser');
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });
  await ready.promise;

  let changeBrowserCloses = 0;
  const answers = ['y', 'n', '000042'];
  const changed = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      discoverBrowsers: async () => {
        events.push('discovery');
        return [{
          browser: 'chrome',
          displayName: 'Google Chrome',
          executablePath: 'C:\\Portable\\chrome.exe',
        }];
      },
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        changeBrowserCloses += 1;
        events.push('changebrowser-closed-browser');
      },
    },
    message => {
      if (message.startsWith('Engine ')) events.push('stop-confirmed');
    },
  );

  assert.equal(changed.exitCode, 0);
  assert.equal((await start).exitCode, 0);
  assert.match(changed.output[0], /stopped gracefully before the browser change/);
  assert.deepEqual(events, [
    'playwright-disconnected',
    'engine-closed-browser',
    'stop-confirmed',
    'discovery',
  ]);
  // The engine shutdown already closed the browser, so it must not be closed again.
  assert.equal(engineCloses, 1);
  assert.equal(changeBrowserCloses, 0);
  const afterChange = loadConfiguration(configurationFilePath);
  assert.equal(afterChange.status, 'valid');
  if (afterChange.status === 'valid') {
    assert.equal(afterChange.configuration.browser, 'chrome');
    assert.equal(afterChange.configuration.executablePath, 'C:\\Portable\\chrome.exe');
  }
});

test('changebrowser reloads configuration persisted during engine shutdown', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const reloadedProfilePath = join(dirname(configurationFilePath), 'reloaded-brave-profile');
  let stopRequests = 0;
  let closes = 0;
  const answers = ['y', 'n', '000042'];

  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      requestRuntimeStatus: async () => ({ status: 'running', instanceId: 'engine-instance' }),
      requestRuntimeStop: async () => {
        stopRequests += 1;
        // Another process persists newer configuration while the engine shuts down.
        saveConfiguration({
          ...validConfiguration,
          puppetName: 'Persisted During Shutdown',
          profilePath: reloadedProfilePath,
          botTemperament: 'talkative',
        }, configurationFilePath);
        return { status: 'stopped', instanceId: 'engine-instance' };
      },
      waitForRuntimeShutdown: async () => ({ status: 'stopped' }),
      discoverBrowsers: async () => [{
        browser: 'brave',
        displayName: 'Brave Browser',
        executablePath: validConfiguration.executablePath,
      }],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closes += 1;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(stopRequests, 1);
  // The engine shutdown already closed the browser, so it must not be closed again.
  assert.equal(closes, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.puppetName, 'Persisted During Shutdown');
    assert.equal(saved.configuration.botTemperament, 'talkative');
    // The reloaded profile path is the source of truth for the unchanged browser.
    assert.equal(saved.configuration.profilePath, reloadedProfilePath);
    assert.equal(saved.configuration.skipPinRestoration, false);
    assert.equal(saved.configuration.pin, '000042');
  }
});

test('changebrowser aborts when configuration cannot be reloaded after shutdown', async context => {
  const scenarios = ['malformed', 'missing'] as const;

  for (const scenario of scenarios) {
    const configurationFilePath = createTemporaryConfigPath(context);
    saveConfiguration(validConfiguration, configurationFilePath);
    let discoveryCalls = 0;
    let closes = 0;

    const result = await captureCli(
      ['changebrowser'],
      configurationFilePath,
      undefined,
      undefined,
      {
        requestRuntimeStatus: async () => ({ status: 'running', instanceId: 'engine-instance' }),
        requestRuntimeStop: async () => {
          if (scenario === 'malformed') {
            writeFileSync(configurationFilePath, '{not json', 'utf8');
          } else {
            rmSync(configurationFilePath, { force: true });
          }
          return { status: 'stopped', instanceId: 'engine-instance' };
        },
        waitForRuntimeShutdown: async () => ({ status: 'stopped' }),
        discoverBrowsers: async () => {
          discoveryCalls += 1;
          return [];
        },
        browserExecutableExists: () => true,
        closeBrowser: async () => {
          closes += 1;
        },
      },
    );

    assert.equal(result.exitCode, 1, scenario);
    assert.equal(discoveryCalls, 0, scenario);
    assert.equal(closes, 0, scenario);
    assert.match(
      result.errors[result.errors.length - 1],
      /browser was not changed because the configuration could not be reloaded/,
    );
    if (scenario === 'malformed') {
      assert.equal(readFileSync(configurationFilePath, 'utf8'), '{not json');
    } else {
      assert.equal(existsSync(configurationFilePath), false);
    }
  }
});

test('changebrowser reports a runtime-control failure without closing the browser or changing configuration', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const endpoint = getRuntimeControlEndpoint(configurationFilePath);
  const unrelatedServer = createServer(socket => {
    socket.on('error', () => undefined);
    socket.write('UNRELATED/1\n');
  });
  await new Promise<void>((resolve, reject) => {
    unrelatedServer.once('error', reject);
    unrelatedServer.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => unrelatedServer.close(() => resolve()));
  });

  let closes = 0;
  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => {
      throw new Error('changebrowser must not prompt when the runtime check fails');
    },
    undefined,
    {
      discoverBrowsers: async () => [],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closes += 1;
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.errors[0], /Unable to check whether impractical-bot is running/);
  assert.match(result.errors[0], /not owned by an impractical-bot engine/);
  assert.equal(closes, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.deepEqual(saved.configuration, validConfiguration);
  }
});

test('runtime persistence refuses to recreate a configuration removed after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath);
  rmSync(configurationFilePath, { force: true });

  const destinationResult = await requestRuntimeChangeDestination(
    configurationFilePath,
    'https://www.facebook.com/messages/t/987654321',
  );
  assert.equal(destinationResult.status, 'failed');
  if (destinationResult.status === 'failed') {
    assert.match(destinationResult.reason, /Configuration has not been initialized/);
  }

  const temperamentResult = await requestRuntimeSetTemperament(configurationFilePath, 'quiet');
  assert.equal(temperamentResult.status, 'failed');
  if (temperamentResult.status === 'failed') {
    assert.match(temperamentResult.reason, /temperament could not be saved/);
    assert.match(temperamentResult.reason, /Configuration has not been initialized/);
  }

  const personalityResult = await requestRuntimeSetPersonality(
    configurationFilePath,
    'default',
    '',
  );
  assert.equal(personalityResult.status, 'failed');
  if (personalityResult.status === 'failed') {
    assert.match(personalityResult.reason, /personality could not be saved/);
    assert.match(personalityResult.reason, /Configuration has not been initialized/);
  }

  // The stale engine snapshot must not recreate the removed configuration file.
  assert.equal(existsSync(configurationFilePath), false);

  writeFileSync(configurationFilePath, '{ malformed', 'utf8');
  const malformedResult = await requestRuntimeChangeDestination(
    configurationFilePath,
    'https://www.facebook.com/messages/t/987654321',
  );
  assert.equal(malformedResult.status, 'failed');
  if (malformedResult.status === 'failed') {
    assert.match(malformedResult.reason, /Configuration is malformed/);
  }
  // A malformed file must not be replaced by the engine's stale snapshot either.
  assert.equal(readFileSync(configurationFilePath, 'utf8'), '{ malformed');

  assert.equal((await engine.stop()).exitCode, 0);
});

test('updatekey refuses while an engine is running without prompting or changing the stored key', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-active-key');
  const originalContent = readFileSync(environmentFilePath, 'utf8');
  let promptCalls = 0;
  let validationCalls = 0;

  const result = await captureCli(['updatekey'], configurationFilePath, undefined, undefined, {
    requestRuntimeStatus: async path => {
      assert.equal(path, configurationFilePath);
      return { status: 'running', instanceId: 'engine-instance' };
    },
    promptSecret: async () => {
      promptCalls += 1;
      return 'nvapi-replacement-key';
    },
    validateNvidiaApiKey: async () => {
      validationCalls += 1;
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(promptCalls, 0);
  assert.equal(validationCalls, 0);
  assert.equal(readFileSync(environmentFilePath, 'utf8'), originalContent);
  assert.match(result.errors[0], /impbot stop/);
  assert.match(result.errors[0], /impbot updatekey/);
  assert.match(result.errors[0], /restart/);
  assert.deepEqual(result.output, []);
  assert.ok(!result.errors.join('\n').includes('nvapi-active-key'));
});

test('updatekey leaves the stored key untouched when runtime status cannot be established', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-active-key');
  const originalContent = readFileSync(environmentFilePath, 'utf8');
  let promptCalls = 0;

  const result = await captureCli(['updatekey'], configurationFilePath, undefined, undefined, {
    requestRuntimeStatus: async () => {
      throw new Error('The runtime-control endpoint could not be queried.');
    },
    promptSecret: async () => {
      promptCalls += 1;
      return 'nvapi-replacement-key';
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(promptCalls, 0);
  assert.equal(readFileSync(environmentFilePath, 'utf8'), originalContent);
  assert.deepEqual(result.errors, [
    'Unable to check whether impractical-bot is running: ' +
    'The runtime-control endpoint could not be queried.',
  ]);
});

test('changebrowser skips the stop request when no engine is running', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let stopRequests = 0;
  let shutdownWaits = 0;
  let closes = 0;
  const answers = ['y', 'n', '000042'];

  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      requestRuntimeStatus: async path => {
        assert.equal(path, configurationFilePath);
        return { status: 'not-running' };
      },
      requestRuntimeStop: async () => {
        stopRequests += 1;
        return { status: 'not-running' };
      },
      waitForRuntimeShutdown: async () => {
        shutdownWaits += 1;
        return { status: 'stopped' };
      },
      discoverBrowsers: async () => [{
        browser: 'edge',
        displayName: 'Microsoft Edge',
        executablePath: 'C:\\Portable\\msedge.exe',
      }],
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closes += 1;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(stopRequests, 0);
  assert.equal(shutdownWaits, 0);
  assert.equal(closes, 1);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.browser, 'edge');
    assert.equal(saved.configuration.executablePath, 'C:\\Portable\\msedge.exe');
  }
});

test('changebrowser aborts without switching browsers when the engine cannot be stopped', async context => {
  const failures = [
    new RuntimeControlEndpointError(
      'The engine received the stop request but shutdown failed (exit code 1).',
    ),
    new RuntimeControlEndpointError('Timed out waiting for the runtime-control response.'),
    new RuntimeControlTimeoutError(
      'Timed out waiting for the runtime-control stop response; the engine may have ' +
      'stopped, so shutdown is not confirmed.',
    ),
  ];

  for (const failure of failures) {
    const label = failure.message;
    const configurationFilePath = createTemporaryConfigPath(context);
    saveConfiguration(validConfiguration, configurationFilePath);
    let stopRequests = 0;
    let shutdownWaits = 0;
    let discoveryCalls = 0;
    let closes = 0;
    let promptCalls = 0;

    const result = await captureCli(
      ['changebrowser'],
      configurationFilePath,
      async () => {
        promptCalls += 1;
        return null;
      },
      undefined,
      {
        requestRuntimeStatus: async () => ({ status: 'running', instanceId: 'engine-instance' }),
        requestRuntimeStop: async () => {
          stopRequests += 1;
          throw failure;
        },
        waitForRuntimeShutdown: async () => {
          shutdownWaits += 1;
          return { status: 'stopped' };
        },
        discoverBrowsers: async () => {
          discoveryCalls += 1;
          return [];
        },
        browserExecutableExists: () => true,
        closeBrowser: async () => {
          closes += 1;
        },
      },
    );

    assert.equal(result.exitCode, 1, label);
    assert.equal(stopRequests, 1, label);
    assert.equal(shutdownWaits, 0, label);
    assert.equal(discoveryCalls, 0, label);
    assert.equal(closes, 0, label);
    assert.equal(promptCalls, 0, label);
    assert.match(result.errors[0], /Unable to stop the running impractical-bot engine/);
    assert.ok(result.errors[0].includes(label));
    assert.deepEqual(loadConfiguration(configurationFilePath), {
      status: 'valid',
      configuration: validConfiguration,
    });
  }
});

test('changebrowser aborts when engine shutdown cannot be verified without retrying the stop request', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let stopRequests = 0;
  let shutdownWaits = 0;
  let discoveryCalls = 0;
  let closes = 0;
  let promptCalls = 0;

  const result = await captureCli(
    ['changebrowser'],
    configurationFilePath,
    async () => {
      promptCalls += 1;
      return null;
    },
    undefined,
    {
      requestRuntimeStatus: async () => ({ status: 'running', instanceId: 'engine-instance' }),
      requestRuntimeStop: async () => {
        stopRequests += 1;
        return { status: 'stopped', instanceId: 'engine-instance' };
      },
      waitForRuntimeShutdown: async () => {
        shutdownWaits += 1;
        return {
          status: 'unconfirmed',
          reason: 'The runtime endpoint is still owned by a running engine.',
        };
      },
      discoverBrowsers: async () => {
        discoveryCalls += 1;
        return [];
      },
      browserExecutableExists: () => true,
      closeBrowser: async () => {
        closes += 1;
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(stopRequests, 1);
  assert.equal(shutdownWaits, 1);
  assert.equal(discoveryCalls, 0);
  assert.equal(closes, 0);
  assert.equal(promptCalls, 0);
  assert.match(result.errors[0], /did not confirm shutdown/);
  assert.match(result.errors[0], /still owned/);
  assert.deepEqual(loadConfiguration(configurationFilePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('stop reports a bounded stop-response timeout without claiming shutdown', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const timeoutMessage =
    'Timed out waiting for the runtime-control stop response; the engine may have ' +
    'stopped, so shutdown is not confirmed.';

  const result = await captureCli(['stop'], configurationFilePath, undefined, undefined, {
    requestRuntimeStop: async () => {
      throw new RuntimeControlTimeoutError(timeoutMessage);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, [
    'The engine may have stopped even though it did not respond. Check that its window has ' +
    'exited before running `impbot stop` again.',
  ]);
  assert.deepEqual(result.errors, [`Unable to stop impractical-bot: ${timeoutMessage}`]);
});

test('stop reports clearly when no engine is running', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  let launchAttempted = false;
  const result = await captureCli(['stop'], configurationFilePath, undefined, undefined, {
    launchBrowser: async () => {
      launchAttempted = true;
      throw new Error('stop must not launch');
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(launchAttempted, false);
  assert.match(result.output[0], /No impractical-bot engine is running/);
  assert.deepEqual(result.errors, []);
});

test('pause and resume report clearly when no engine is running', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  for (const command of ['pause', 'resume']) {
    const result = await captureCli([command], configurationFilePath);
    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /No impractical-bot engine is running/);
    assert.deepEqual(result.errors, []);
  }
});

test('pause and resume commands control the running Combustion engine', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const events: string[] = [];
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        events.push('disconnected');
      },
    }),
    closeBrowser: async () => {
      events.push('browser-closed');
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      () => events.push('stopped'),
      () => events.push('paused'),
      () => events.push('resumed'),
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const pauseResult = await requestRuntimePause(configurationFilePath);
  assert.equal(pauseResult.status, 'paused');
  const resumeResult = await requestRuntimeResume(configurationFilePath);
  assert.equal(resumeResult.status, 'resumed');
  const stopResult = await captureCli(['stop'], configurationFilePath);
  const startResult = await start;

  assert.equal(stopResult.exitCode, 0);
  assert.equal(startResult.exitCode, 0);
  assert.deepEqual(events, ['paused', 'resumed', 'stopped', 'disconnected', 'browser-closed']);
});

test('runtime status reports lifecycle and in-memory configuration after runtime changes', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath);

  const initial = await requestRuntimeStatusSnapshot(configurationFilePath);
  assert.equal(initial.status, 'running');
  if (initial.status === 'running') {
    assert.equal(initial.state, 'running');
    assert.equal(initial.browser, 'brave');
    assert.equal(initial.temperament, 'balanced');
    assert.equal(initial.personality, 'default');
    assert.equal(initial.messengerDestination, validConfiguration.messageDestination);
  }

  assert.equal((await captureCli(['pause'], configurationFilePath)).exitCode, 0);
  const paused = await requestRuntimeStatusSnapshot(configurationFilePath);
  assert.equal(paused.status === 'running' && paused.state, 'paused');

  assert.equal((await captureCli(['resume'], configurationFilePath)).exitCode, 0);
  const resumed = await requestRuntimeStatusSnapshot(configurationFilePath);
  assert.equal(resumed.status === 'running' && resumed.state, 'running');

  const destination = 'https://www.facebook.com/messages/t/987654321';
  const destinationChange = await captureCli(
    ['changemsgUrl'],
    configurationFilePath,
    async () => destination,
  );
  assert.equal(destinationChange.exitCode, 0);
  const temperamentChange = await captureCli(['setbottemp'], configurationFilePath, async () => '1');
  assert.equal(temperamentChange.exitCode, 0);
  const personalityAnswers = ['2', 'Cold and impersonal.', '.'];
  const personalityChange = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => personalityAnswers.shift() ?? null,
  );
  assert.equal(personalityChange.exitCode, 0);

  // The engine must report its live configuration even if the on-disk file is stale.
  saveConfiguration(
    {
      ...validConfiguration,
      messageDestination: 'https://www.facebook.com/messages/t/555555555',
      botTemperament: 'talkative',
      botPersonality: 'default',
      customPersonalityInstruction: undefined,
    },
    configurationFilePath,
  );

  const changed = await requestRuntimeStatusSnapshot(configurationFilePath);
  assert.equal(changed.status, 'running');
  if (changed.status === 'running') {
    assert.equal(changed.state, 'running');
    assert.equal(changed.browser, 'brave');
    assert.equal(changed.temperament, 'quiet');
    assert.equal(changed.personality, 'custom');
    assert.equal(changed.messengerDestination, destination);
    assert.deepEqual(
      Object.keys(changed).sort(),
      [
        'browser',
        'instanceId',
        'messengerDestination',
        'personality',
        'state',
        'status',
        'temperament',
      ],
    );
  }

  assert.equal((await engine.stop()).exitCode, 0);
});

test('changemsgUrl updates a running engine through runtime control', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const requests: {
    destination: string;
    resume: boolean;
    destinationBeforePersist: string | undefined;
  }[] = [];
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      async (selectedDestination, options) => {
        const saved = loadConfiguration(configurationFilePath);
        requests.push({
          destination: selectedDestination,
          resume: options.resume,
          destinationBeforePersist: saved.status === 'valid'
            ? saved.configuration.messageDestination
            : undefined,
        });
        await options.persist?.(selectedDestination);
        return { status: 'changed', resumed: options.resume };
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['changemsgUrl'],
    configurationFilePath,
    async () => destination,
  );
  assert.equal(change.exitCode, 0);
  assert.deepEqual(requests, [{
    destination,
    resume: true,
    destinationBeforePersist: validConfiguration.messageDestination,
  }]);
  assert.match(change.output[0], /Message destination changed/);
  assert.match(change.output[0], /resumed/);
  const savedAfterChange = loadConfiguration(configurationFilePath);
  assert.equal(savedAfterChange.status, 'valid');
  if (savedAfterChange.status === 'valid') {
    assert.equal(savedAfterChange.configuration.messageDestination, destination);
  }

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('changemsgUrl preserves unrelated configuration persisted after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath);
  // Another process changes an unrelated field after the engine snapshot was read.
  saveConfiguration(
    { ...validConfiguration, puppetName: 'Concurrent Puppet' },
    configurationFilePath,
  );

  const destination = 'https://www.facebook.com/messages/t/987654321';
  const change = await captureCli(['changemsgUrl'], configurationFilePath, async () => destination);

  assert.equal(change.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.messageDestination, destination);
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
  }
  assert.equal((await engine.stop()).exitCode, 0);
});

test('changemsgUrl rejection preserves a running engine destination and requires resume', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const events: string[] = [];
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      () => events.push('stopped'),
      () => events.push('paused'),
      () => events.push('resumed'),
      async () => {
        events.push('destination-rejected');
        return {
          status: 'rejected',
          reason: 'The destination conversation could not be verified.',
        };
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['changemsgUrl'],
    configurationFilePath,
    async () => destination,
  );
  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /not a valid or accessible group conversation/);
  assert.match(change.output[0], /remains paused/);
  const savedAfterRejection = loadConfiguration(configurationFilePath);
  assert.equal(savedAfterRejection.status, 'valid');
  if (savedAfterRejection.status === 'valid') {
    assert.equal(
      savedAfterRejection.configuration.messageDestination,
      validConfiguration.messageDestination,
    );
  }
  assert.deepEqual(events, ['destination-rejected']);

  const resumed = await captureCli(['resume'], configurationFilePath);
  assert.equal(resumed.exitCode, 0);
  assert.match(resumed.output[0], /resumed/);
  assert.deepEqual(events, ['destination-rejected', 'resumed']);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('a second destination change is rejected while the first is in progress', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const changeEntered = deferred<void>();
  const releaseChange = deferred<void>();
  const destination = 'https://www.facebook.com/messages/t/987654321';

  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      async (selectedDestination, options) => {
        changeEntered.resolve();
        await releaseChange.promise;
        await options.persist?.(selectedDestination);
        return { status: 'changed', resumed: options.resume };
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const firstChange = captureCli(
    ['changemsgUrl'],
    configurationFilePath,
    async () => destination,
  );
  await changeEntered.promise;
  const secondChange = await captureCli(
    ['changemsgUrl'],
    configurationFilePath,
    async () => 'https://www.facebook.com/messages/t/111111111',
  );
  assert.equal(secondChange.exitCode, 1);
  assert.match(secondChange.errors[0], /BUSY/);

  releaseChange.resolve();
  const firstResult = await firstChange;
  assert.equal(firstResult.exitCode, 0);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('stop waits for Combustion cleanup before disconnecting Playwright and closing the attached browser', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const stopEntered = deferred<void>();
  const finishCombustionStop = deferred<void>();
  const events: string[] = [];
  let disconnects = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      reusedExistingBrowser: true,
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        events.push('playwright-disconnected');
        disconnects += 1;
      },
    }),
    closeBrowser: async () => {
      events.push('browser-closed');
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => ({
      stopped: new Promise<void>(() => undefined),
      async pause() {
        events.push('combustion-paused');
      },
      async resume() {
        events.push('combustion-resumed');
      },
      setTemperament() {
        return undefined;
      },
      setPersonality() {
        return undefined;
      },
      async changeDestination(destination, options) {
        await options.persist?.(destination);
        return { status: 'changed', resumed: options.resume };
      },
      async stop() {
        events.push('combustion-stop-started');
        stopEntered.resolve();
        await finishCombustionStop.promise;
        events.push('combustion-stopped');
      },
    }),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  let stopSettled = false;
  const stop = captureCli(['stop'], configurationFilePath).then(result => {
    stopSettled = true;
    return result;
  });
  await stopEntered.promise;
  assert.equal(stopSettled, false);
  assert.equal(disconnects, 0);

  finishCombustionStop.resolve();
  const stopResult = await stop;
  const startResult = await start;
  assert.equal(stopResult.exitCode, 0);
  assert.match(stopResult.output[0], /stopped gracefully/);
  assert.equal(startResult.exitCode, 0);
  assert.deepEqual(events, [
    'combustion-stop-started',
    'combustion-stopped',
    'playwright-disconnected',
    'browser-closed',
  ]);
  assert.equal(disconnects, 1);

  const afterShutdown = await captureCli(['stop'], configurationFilePath);
  assert.match(afterShutdown.output[0], /No impractical-bot engine is running/);
});

test('stop reports failure when graceful browser closure fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    closeBrowser: async () => {
      throw new Error('shutdown timed out');
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const stopResult = await captureCli(['stop'], configurationFilePath);
  const startResult = await start;
  assert.equal(stopResult.exitCode, 1);
  assert.match(stopResult.errors[0], /shutdown failed/);
  assert.equal(startResult.exitCode, 1);
  assert.match(startResult.errors[0], /Unable to close the configured browser: shutdown timed out/);
});

test('duplicate start is rejected before a second browser launch', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  let launchAttempts = 0;
  const runtime: CliRuntimeOptions = {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => {
      launchAttempts += 1;
      return {
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          return undefined;
        },
      };
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
  };
  const start = captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    runtime,
    message => {
      if (message.includes('Engine ready')) ready.resolve();
    },
  );
  await ready.promise;

  const duplicate = await captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    runtime,
  );
  assert.equal(duplicate.exitCode, 1);
  assert.match(duplicate.errors[0], /engine is already running/);
  assert.equal(launchAttempts, 1);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('SIGINT still performs owner cleanup and releases runtime ownership', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  let disconnects = 0;
  let browserCloses = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        disconnects += 1;
      },
    }),
    closeBrowser: async () => {
      browserCloses += 1;
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  process.emit('SIGINT');
  const result = await start;
  assert.equal(result.exitCode, 130);
  assert.equal(disconnects, 1);
  assert.equal(browserCloses, 1);
  const afterShutdown = await captureCli(['stop'], configurationFilePath);
  assert.match(afterShutdown.output[0], /No impractical-bot engine is running/);
});

test('init dispatches to its injected initialization workflow', async () => {
  const result = await captureCli(
    ['init'],
    undefined,
    undefined,
    async options => {
      options.writeError?.('browser discovery is unavailable');
      return 'failed';
    },
  );

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors[0], /browser discovery is unavailable/);
});

test('changemsgUrl validates before saving a pre-start destination', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const promptCalls: string[] = [];
  const answers = ['ftp://www.facebook.com/messages/t/987654321', destination];
  const runtimeChecks: string[] = [];

  const result = await captureCli(
    ['changemsgUrl'],
    filePath,
    async question => {
      promptCalls.push(question);
      return answers.shift() ?? null;
    },
    undefined,
    {
      requestRuntimeChangeDestination: async (configurationFilePath, selectedDestination) => {
        runtimeChecks.push(selectedDestination);
        assert.equal(configurationFilePath, filePath);
        assert.deepEqual(loadConfiguration(filePath), {
          status: 'valid',
          configuration: validConfiguration,
        });
        return { status: 'not-running' };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(runtimeChecks, [destination]);
  assert.equal(promptCalls.length, 2);
  assert.match(result.errors[0], /valid HTTP or HTTPS URL/);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: { ...validConfiguration, messageDestination: destination },
  });
});

test('changemsgUrl cancellation and invalid input retain the configured destination', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);
  let runtimeChecks = 0;

  const cancelled = await captureCli(
    ['changemsgUrl'],
    filePath,
    async () => null,
    undefined,
    {
      requestRuntimeChangeDestination: async () => {
        runtimeChecks += 1;
        return { status: 'not-running' };
      },
    },
  );
  assert.equal(cancelled.exitCode, 0);
  assert.equal(runtimeChecks, 0);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: validConfiguration,
  });

  const invalidAnswers = ['not-a-url', null];
  const failed = await captureCli(
    ['changemsgUrl'],
    filePath,
    async () => invalidAnswers.shift() ?? null,
    undefined,
    {
      requestRuntimeChangeDestination: async () => {
        runtimeChecks += 1;
        return { status: 'not-running' };
      },
    },
  );
  assert.equal(failed.exitCode, 0);
  assert.equal(runtimeChecks, 0);
  assert.match(failed.errors[0], /valid HTTP or HTTPS URL/);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
});

test('changemsgUrl preserves configuration persisted while the destination prompt is open', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const concurrent = {
    ...validConfiguration,
    puppetName: 'Concurrent Puppet',
    botTemperament: 'talkative' as const,
  };
  let promptCalls = 0;

  const result = await captureCli(
    ['changemsgUrl'],
    filePath,
    async () => {
      promptCalls += 1;
      saveConfiguration(concurrent, filePath);
      return destination;
    },
    undefined,
    {
      requestRuntimeChangeDestination: async () => ({ status: 'not-running' }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(promptCalls, 1);
  const saved = loadConfiguration(filePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.messageDestination, destination);
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
    assert.equal(saved.configuration.botTemperament, 'talkative');
  }
});

test('setbottemp preserves configuration persisted while the temperament prompt is open', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const concurrentDestination = 'https://www.facebook.com/messages/t/555555555';
  const concurrent = {
    ...validConfiguration,
    puppetName: 'Concurrent Puppet',
    messageDestination: concurrentDestination,
  };
  let promptCalls = 0;

  const result = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => {
      promptCalls += 1;
      saveConfiguration(concurrent, configurationFilePath);
      return '3';
    },
    undefined,
    {
      requestRuntimeSetTemperament: async () => ({ status: 'not-running' }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(promptCalls, 1);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'talkative');
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
    assert.equal(saved.configuration.messageDestination, concurrentDestination);
  }
});

test('setbottemp accepts a numbered choice after rejecting an invalid one', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const answers = ['9', '3'];
  const result = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    { requestRuntimeSetTemperament: async () => ({ status: 'not-running' }) },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.errors[0] ?? '', /Choose 1 \(Quiet\), 2 \(Balanced\), or 3 \(Talkative\)/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'talkative');
  }
});

test('setpersonality accepts a numbered choice after rejecting an invalid one', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const answers = ['9', '1'];
  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    { requestRuntimeSetPersonality: async () => ({ status: 'not-running' }) },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.errors[0] ?? '', /Choose 1 \(Default\) or 2 \(Custom\)/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
  }
});

test('setpersonality preserves configuration persisted while the personality prompts are open', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const concurrent = {
    ...validConfiguration,
    puppetName: 'Concurrent Puppet',
    botTemperament: 'talkative' as const,
  };
  const answers = ['custom', 'Sarcastic.', '.'];
  let promptCalls = 0;

  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async question => {
      promptCalls += 1;
      if (promptCalls === 1) {
        assert.match(question, /personality/i);
        saveConfiguration(concurrent, configurationFilePath);
      }
      return answers.shift() ?? null;
    },
    undefined,
    {
      requestRuntimeSetPersonality: async () => ({ status: 'not-running' }),
    },
  );

  assert.equal(result.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'custom');
    assert.equal(saved.configuration.customPersonalityInstruction, 'Sarcastic.');
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
    assert.equal(saved.configuration.botTemperament, 'talkative');
  }
});

test('stale-write commands abort without writing when the configuration cannot be reloaded', async context => {
  const cases: { command: string; answer: string; runtime: CliRuntimeOptions }[] = [
    {
      command: 'changemsgUrl',
      answer: 'https://www.facebook.com/messages/t/987654321',
      runtime: {
        requestRuntimeChangeDestination: async () => ({ status: 'not-running' }),
      },
    },
    {
      command: 'setbottemp',
      answer: '3',
      runtime: {
        requestRuntimeSetTemperament: async () => ({ status: 'not-running' }),
      },
    },
    {
      command: 'setpersonality',
      answer: 'default',
      runtime: {
        requestRuntimeSetPersonality: async () => ({ status: 'not-running' }),
      },
    },
  ];

  for (const { command, answer, runtime } of cases) {
    const filePath = createTemporaryConfigPath(context);
    saveConfiguration(validConfiguration, filePath);
    let promptCalls = 0;

    const result = await captureCli(
      [command],
      filePath,
      async () => {
        promptCalls += 1;
        writeFileSync(filePath, '{not json', 'utf8');
        return answer;
      },
      undefined,
      runtime,
    );

    assert.equal(result.exitCode, 1, command);
    assert.equal(promptCalls, 1, command);
    assert.match(
      result.errors[0],
      /Unable to save (message destination|bot temperament|personality)/,
      command,
    );
    assert.equal(readFileSync(filePath, 'utf8'), '{not json', command);
  }
});

test('setbottemp while stopped persists the selection without launching a browser or engine', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let launchAttempted = false;
  let runtimeArguments: { configurationFilePath?: string; temperament?: string } = {};

  const result = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => '3',
    undefined,
    {
      requestRuntimeSetTemperament: async (path, temperament) => {
        runtimeArguments = { configurationFilePath: path, temperament };
        return { status: 'not-running' };
      },
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error('must not launch');
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(launchAttempted, false);
  assert.deepEqual(runtimeArguments, {
    configurationFilePath,
    temperament: 'talkative',
  });
  assert.match(result.output.at(-1) ?? '', /Bot temperament saved: talkative/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'talkative');
  }
});

test('setbottemp rejects invalid selections without changing configuration', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration({ ...validConfiguration, botTemperament: 'quiet' }, configurationFilePath);
  const answers = ['loud', null];
  let runtimeCalls = 0;

  const result = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      requestRuntimeSetTemperament: async () => {
        runtimeCalls += 1;
        return { status: 'not-running' };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runtimeCalls, 0);
  assert.match(result.errors[0], /Choose 1 \(Quiet\), 2 \(Balanced\), or 3 \(Talkative\)/);
  assert.match(result.output.at(-1) ?? '', /cancelled/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'quiet');
  }
});

test('setbottemp updates a running engine and persists the selection', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const receivedTemperaments: string[] = [];
  let launchCalls = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => {
      launchCalls += 1;
      return {
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          return undefined;
        },
      };
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      temperament => {
        receivedTemperaments.push(temperament);
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => '1',
  );
  assert.equal(change.exitCode, 0);
  assert.match(change.output.at(-1) ?? '', /Bot temperament changed: quiet/);
  assert.deepEqual(receivedTemperaments, ['quiet']);
  assert.equal(launchCalls, 1);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'quiet');
  }

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('setbottemp rolls back persisted configuration when the runtime update fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('runtime rejected the temperament update');
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => '3',
  );
  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /runtime temperament update failed/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'balanced');
  }

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('setbottemp preserves unrelated configuration persisted after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath);
  saveConfiguration(
    { ...validConfiguration, puppetName: 'Concurrent Puppet' },
    configurationFilePath,
  );

  const change = await captureCli(['setbottemp'], configurationFilePath, async () => '3');

  assert.equal(change.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'talkative');
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
  }
  assert.equal((await engine.stop()).exitCode, 0);
});

test('setbottemp rollback preserves unrelated configuration persisted after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath, () => createTestCombustionController(
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error('runtime rejected the temperament update');
    },
  ));
  saveConfiguration(
    { ...validConfiguration, puppetName: 'Concurrent Puppet' },
    configurationFilePath,
  );

  const change = await captureCli(['setbottemp'], configurationFilePath, async () => '3');

  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /runtime temperament update failed/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'balanced');
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
  }
  assert.equal((await engine.stop()).exitCode, 0);
});

test('setbottemp reports persistence failure without applying the runtime update', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const receivedTemperaments: string[] = [];
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      temperament => {
        receivedTemperaments.push(temperament);
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['setbottemp'],
    configurationFilePath,
    async () => {
      writeFileSync(configurationFilePath, '{ malformed');
      return '1';
    },
  );
  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /temperament could not be saved/);
  assert.deepEqual(receivedTemperaments, []);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('setpersonality while stopped persists a custom block without launching a browser or engine', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let launchAttempted = false;
  let runtimeCalled = false;
  const answers = ['2', 'Sarcastic and deadpan.', 'Never cheerful.', '.'];

  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      requestRuntimeSetPersonality: async (path, mode, instruction) => {
        runtimeCalled = true;
        assert.equal(path, configurationFilePath);
        assert.equal(mode, 'custom');
        assert.equal(instruction, 'Sarcastic and deadpan.\nNever cheerful.');
        return { status: 'not-running' };
      },
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error('must not launch');
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runtimeCalled, true);
  assert.equal(launchAttempted, false);
  assert.match(result.output.at(-1) ?? '', /Personality saved: custom/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'custom');
    assert.equal(
      saved.configuration.customPersonalityInstruction,
      'Sarcastic and deadpan.\nNever cheerful.',
    );
  }
});

test('setpersonality rejects an oversized custom block before persistence', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const answers = [
    'custom',
    'x'.repeat(MAX_PERSONALITY_INSTRUCTION_CHARS + 1),
    '.',
  ];

  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
    undefined,
    {
      requestRuntimeSetPersonality: async () => ({ status: 'not-running' }),
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.errors[0], /must not exceed \d+ characters/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
    assert.equal(saved.configuration.customPersonalityInstruction, undefined);
  }
});

test('setpersonality switching back to Default clears the stored custom instruction', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(
    {
      ...validConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: 'Sarcastic and deadpan.',
    },
    configurationFilePath,
  );

  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => 'default',
    undefined,
    {
      requestRuntimeSetPersonality: async () => ({ status: 'not-running' }),
    },
  );

  assert.equal(result.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
    assert.equal(saved.configuration.customPersonalityInstruction, undefined);
  }
});

test('setpersonality cancellation leaves the persisted configuration unchanged', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let runtimeCalls = 0;

  const result = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => null,
    undefined,
    {
      requestRuntimeSetPersonality: async () => {
        runtimeCalls += 1;
        return { status: 'not-running' };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runtimeCalls, 0);
  assert.match(result.output.at(-1) ?? '', /cancelled/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
  }
});

test('setpersonality updates a running engine and persists without restarting it', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const receivedInstructions: Array<{
    mode: Parameters<CombustionController['setPersonality']>[0];
    instruction: Parameters<CombustionController['setPersonality']>[1];
  }> = [];
  let launchCalls = 0;
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => {
      launchCalls += 1;
      return {
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          return undefined;
        },
      };
    },
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (mode, instruction) => {
        receivedInstructions.push({ mode, instruction });
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const answers = ['custom', 'Cold and impersonal.', '.'];
  const change = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
  );
  assert.equal(change.exitCode, 0);
  assert.match(change.output.at(-1) ?? '', /Personality changed: custom/);
  assert.equal(launchCalls, 1);
  assert.deepEqual(receivedInstructions, [
    { mode: 'custom', instruction: 'Cold and impersonal.' },
  ]);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'custom');
    assert.equal(saved.configuration.customPersonalityInstruction, 'Cold and impersonal.');
  }

  const revert = await captureCli(['setpersonality'], configurationFilePath, async () => 'default');
  assert.equal(revert.exitCode, 0);
  assert.deepEqual(receivedInstructions[1], { mode: 'default', instruction: undefined });

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('setpersonality rolls back persisted configuration when the runtime update fails', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('runtime rejected the personality update');
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const answers = ['custom', 'Unstable tone.', '.'];
  const change = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
  );
  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /runtime personality update failed/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
    assert.equal(saved.configuration.customPersonalityInstruction, undefined);
  }

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('setpersonality preserves unrelated configuration persisted after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath);
  saveConfiguration(
    { ...validConfiguration, puppetName: 'Concurrent Puppet' },
    configurationFilePath,
  );
  const answers = ['custom', 'Sarcastic.', '.'];

  const change = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
  );

  assert.equal(change.exitCode, 0);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'custom');
    assert.equal(saved.configuration.customPersonalityInstruction, 'Sarcastic.');
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
  }
  assert.equal((await engine.stop()).exitCode, 0);
});

test('setpersonality rollback preserves unrelated configuration persisted after the engine loaded', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const engine = await startTestEngine(configurationFilePath, () => createTestCombustionController(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error('runtime rejected the personality update');
    },
  ));
  saveConfiguration(
    { ...validConfiguration, puppetName: 'Concurrent Puppet' },
    configurationFilePath,
  );
  const answers = ['custom', 'Unstable tone.', '.'];

  const change = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => answers.shift() ?? null,
  );

  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /runtime personality update failed/);
  const saved = loadConfiguration(configurationFilePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botPersonality, 'default');
    assert.equal(saved.configuration.customPersonalityInstruction, undefined);
    assert.equal(saved.configuration.puppetName, 'Concurrent Puppet');
  }
  assert.equal((await engine.stop()).exitCode, 0);
});

test('setpersonality reports persistence failure without applying the runtime update', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const receivedInstructions: string[] = [];
  const start = captureCli(['start'], configurationFilePath, undefined, undefined, {
    validateNvidiaApiKey: async () => undefined,
    launchBrowser: async () => ({
      endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      browserVersion: 'Brave Chromium test',
      disconnected: new Promise<void>(() => undefined),
      async prepare() {
        return stubPage;
      },
      async disconnect() {
        return undefined;
      },
    }),
    readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
    startCombustion: async () => createTestCombustionController(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      instruction => {
        receivedInstructions.push(instruction);
      },
    ),
  }, message => {
    if (message.includes('Engine ready')) ready.resolve();
  });

  await ready.promise;
  const change = await captureCli(
    ['setpersonality'],
    configurationFilePath,
    async () => {
      writeFileSync(configurationFilePath, '{ malformed');
      return 'default';
    },
  );
  assert.equal(change.exitCode, 1);
  assert.match(change.errors[0], /personality could not be saved/);
  assert.deepEqual(receivedInstructions, []);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  assert.equal((await start).exitCode, 0);
});

test('config reports only the setpersonality mode and never the custom instruction text', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(
    {
      ...validConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: 'Top secret tone directive.',
    },
    filePath,
  );

  const result = await captureCli(['config'], filePath);

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /setpersonality: custom/);
  assert.doesNotMatch(result.output[0], /Top secret tone directive/);
  assert.doesNotMatch(result.output.join('\n'), /Top secret tone directive/);
  assert.deepEqual(result.errors, []);
});

test('config reports when configuration is missing', async context => {
  const result = await captureCli(['config'], createTemporaryConfigPath(context));

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /Configuration has not been initialized/);
  assert.deepEqual(result.errors, []);
});

test('config reports persisted settings and puppet name', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration({ ...validConfiguration, puppetName: 'Test Puppet' }, filePath);

  const result = await captureCli(['config'], filePath);

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /Browser: brave/);
  assert.match(result.output[0], /Executable: C:\\Program Files\\BraveSoftware/);
  assert.match(result.output[0], /Profile: C:\\Users\\test/);
  assert.match(result.output[0], /Skip PIN restoration: false/);
  assert.match(result.output[0], /Messenger restoration PIN: 001234/);
  assert.match(result.output[0], /CDP port: 9222/);
  assert.match(result.output[0], /Startup URL: https:\/\/www\.facebook\.com/);
  assert.match(result.output[0], /Message destination: https:\/\/www\.facebook\.com\/messages\/t\/1618007223454558/);
  assert.match(result.output[0], /Bot temperament: balanced/);
  assert.match(result.output[0], /Puppet name: Test Puppet/);
  assert.deepEqual(result.errors, []);

  saveConfiguration({
    ...validConfiguration,
    skipPinRestoration: true,
    pin: null,
    messageDestination: 'https://www.facebook.com/messages/t/1618007223454558',
  }, filePath);
  const skippedPinResult = await captureCli(['config'], filePath);
  assert.match(skippedPinResult.output[0], /Messenger restoration PIN: null/);
  assert.match(skippedPinResult.output[0], /Puppet name: Not set/);

  saveConfiguration({ ...validConfiguration, puppetName: '' }, filePath);
  const emptyPuppetNameResult = await captureCli(['config'], filePath);
  assert.match(emptyPuppetNameResult.output[0], /Puppet name: Not set/);
});

test('help options and no command display usage', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = await captureCli(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /Usage: impbot <command>/);
    assert.match(result.output[0], /init\s+Initialize Impractical Bot/);
    assert.match(result.output[0], /config\s+Configure Impractical Bot/);
    assert.match(result.output[0], /changebrowser\s+Change the configured browser/);
    assert.match(result.output[0], /changemsgUrl\s+Change Messenger destination/);
    assert.match(result.output[0], /setbottemp\s+Set bot temperament/);
    assert.match(result.output[0], /setpersonality\s+Set bot personality/);
    assert.doesNotMatch(result.output[0], /changemsgdestination/);
    assert.doesNotMatch(result.output[0], /changemessagedestination/);
    assert.match(result.output[0], /updatekey\s+Replace the NVIDIA API key/);
    assert.match(result.output[0], /start\s+Start Impractical Bot/);
    assert.match(result.output[0], /pause\s+Pause Impractical Bot/);
    assert.match(result.output[0], /resume\s+Resume Impractical Bot/);
    assert.match(result.output[0], /stop\s+Stop Impractical Bot/);
    assert.doesNotMatch(result.output[0], /--tui/);
    assert.doesNotMatch(result.output[0], /\btui\b/);
    assert.deepEqual(result.errors, []);
  }
});

test('version options read the version from package metadata', async () => {
  const packageMetadata = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };

  for (const option of ['--version', '-v']) {
    const result = await captureCli([option]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [packageMetadata.version]);
    assert.deepEqual(result.errors, []);
  }
});

test('unknown commands and unexpected arguments fail with a usage hint', async () => {
  for (const args of [['unknown'], ['start', '--force']]) {
    const result = await captureCli(args);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.match(result.errors[0], /^Error: /);
    assert.match(result.errors[0], /Usage: impbot <command>/);
  }
});

test('removed dashboard flags and attach command are rejected', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  for (const args of [['start', '--tui'], ['tui']]) {
    const result = await captureCli(args, configurationFilePath);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.match(result.errors[0], /Usage: impbot <command>/);
    assert.doesNotMatch(result.output.join('\n'), /--tui/);
  }
});

test('start automatically opens the dashboard after readiness and keeps the engine running when it closes', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const shutdown = deferred<void>();
  const dashboardClosed = deferred<void>();
  const observed: string[] = [];
  const lifecycle: string[] = [];
  let dashboardStarts = 0;
  let dashboardCloses = 0;
  let combustionStops = 0;

  const start = captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    {
      checkDashboardTerminal: () => {
        lifecycle.push('terminal');
        return { ok: true };
      },
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => {
        lifecycle.push('launch');
        return {
          endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
          browserVersion: 'Brave Chromium test',
          disconnected: new Promise<void>(() => undefined),
          async prepare() {
            return stubPage;
          },
          async disconnect() {
            return undefined;
          },
        };
      },
      readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
      startCombustion: async () => createTestCombustionController(() => {
        combustionStops += 1;
      }),
      waitForShutdown: () => shutdown.promise,
      startDashboard: async options => {
        lifecycle.push('dashboard');
        dashboardStarts += 1;
        const beforeDashboard = observed.join('\n');
        assert.match(beforeDashboard, /CRANKING/);
        assert.match(beforeDashboard, /BACKREAD/);
        assert.match(beforeDashboard, /CONTEXT/);
        assert.match(beforeDashboard, /READY/);
        assert.ok(options);
        assert.equal(options.configurationFilePath, configurationFilePath);
        assert.equal(options.captureConsoleOutput, true);
        assert.equal(typeof options.requestStatus, 'function');
        assert.ok(options.commands);
        for (const operation of [
          'pause',
          'resume',
          'stop',
          'changeDestination',
          'setTemperament',
          'setPersonality',
        ] as const) {
          assert.equal(typeof options.commands[operation], 'function');
        }
        return {
          closed: dashboardClosed.promise,
          async close() {
            dashboardCloses += 1;
            dashboardClosed.resolve();
          },
          async refresh() {
            return undefined;
          },
        };
      },
    },
    message => {
      observed.push(message);
      if (message.includes('Engine ready')) ready.resolve();
    },
  );

  await ready.promise;
  assert.equal(dashboardStarts, 1);
  assert.deepEqual(lifecycle, ['terminal', 'launch', 'dashboard']);

  dashboardClosed.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(combustionStops, 0);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  shutdown.resolve();
  const result = await start;

  assert.equal(result.exitCode, 0);
  assert.equal(dashboardCloses, 1);
  assert.equal(combustionStops, 1);
  assert.match(result.output.join('\n'), /Engine ready/);
});

test('start Ctrl+C inside the active dashboard completes shutdown and releases runtime ownership', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const dashboardStarted = deferred<void>();
  const dashboardClosed = deferred<void>();
  let interrupt: (() => void) | undefined;
  let dashboardCloses = 0;
  let combustionStops = 0;
  let disconnects = 0;
  let browserCloses = 0;

  const start = captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    {
      checkDashboardTerminal: () => ({ ok: true }),
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => ({
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          disconnects += 1;
        },
      }),
      closeBrowser: async () => {
        browserCloses += 1;
      },
      readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
      startCombustion: async () => createTestCombustionController(() => {
        combustionStops += 1;
      }),
      waitForShutdown: () => new Promise<void>(() => undefined),
      startDashboard: async options => {
        assert.ok(options);
        interrupt = options.onInterrupt;
        dashboardStarted.resolve();
        return {
          closed: dashboardClosed.promise,
          async close() {
            dashboardCloses += 1;
            dashboardClosed.resolve();
          },
          async refresh() {
            return undefined;
          },
        };
      },
    },
    message => {
      if (message.includes('Engine ready')) ready.resolve();
    },
  );

  await ready.promise;
  await dashboardStarted.promise;
  assert.equal(typeof interrupt, 'function');

  interrupt!();
  const result = await start;

  assert.equal(result.exitCode, 130);
  assert.equal(dashboardCloses, 1);
  assert.equal(combustionStops, 1);
  assert.equal(disconnects, 1);
  assert.equal(browserCloses, 1);
  assert.match(result.output.join('\n'), /Shutdown requested; disconnecting Playwright/);

  const afterShutdown = await captureCli(['stop'], configurationFilePath);
  assert.match(afterShutdown.output[0], /No impractical-bot engine is running/);
});

test('C closes the dashboard without stopping the engine and a later Ctrl+C shuts it down', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const dashboardStarted = deferred<void>();
  const dashboardClosed = deferred<void>();
  let dashboardCloses = 0;
  let combustionStops = 0;
  let disconnects = 0;
  let browserCloses = 0;

  const start = captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    {
      checkDashboardTerminal: () => ({ ok: true }),
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => ({
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          disconnects += 1;
        },
      }),
      closeBrowser: async () => {
        browserCloses += 1;
      },
      readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
      startCombustion: async () => createTestCombustionController(() => {
        combustionStops += 1;
      }),
      waitForShutdown: () => new Promise<void>(() => undefined),
      startDashboard: async options => {
        assert.ok(options);
        assert.equal(typeof options.onInterrupt, 'function');
        dashboardStarted.resolve();
        return {
          closed: dashboardClosed.promise,
          async close() {
            dashboardCloses += 1;
            dashboardClosed.resolve();
          },
          async refresh() {
            return undefined;
          },
        };
      },
    },
    message => {
      if (message.includes('Engine ready')) ready.resolve();
    },
  );

  await ready.promise;
  await dashboardStarted.promise;

  dashboardClosed.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dashboardCloses, 0);
  assert.equal(combustionStops, 0);
  assert.equal(disconnects, 0);
  assert.equal(browserCloses, 0);

  process.emit('SIGINT');
  const result = await start;

  assert.equal(result.exitCode, 130);
  assert.equal(dashboardCloses, 1);
  assert.equal(combustionStops, 1);
  assert.equal(disconnects, 1);
  assert.equal(browserCloses, 1);

  const afterShutdown = await captureCli(['stop'], configurationFilePath);
  assert.match(afterShutdown.output[0], /No impractical-bot engine is running/);
});

test('start falls back to traditional CLI output in a non-interactive terminal', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  saveApplicationApiKey(configurationFilePath);
  const ready = deferred<void>();
  const shutdown = deferred<void>();
  const observed: string[] = [];
  let dashboardStarts = 0;

  const start = captureCli(
    ['start'],
    configurationFilePath,
    undefined,
    undefined,
    {
      checkDashboardTerminal: () => ({
        ok: false,
        reason: 'stdout is not an interactive terminal.',
      }),
      validateNvidiaApiKey: async () => undefined,
      launchBrowser: async () => ({
        endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
        browserVersion: 'Brave Chromium test',
        disconnected: new Promise<void>(() => undefined),
        async prepare() {
          return stubPage;
        },
        async disconnect() {
          return undefined;
        },
      }),
      readMessengerMessages: async () => ({ diagnostics: [], messages: [] }),
      startCombustion: async () => createTestCombustionController(),
      waitForShutdown: () => shutdown.promise,
      startDashboard: async () => {
        dashboardStarts += 1;
        throw new Error('the dashboard must not start without a TTY');
      },
    },
    message => {
      observed.push(message);
      if (message.includes('Engine ready')) ready.resolve();
    },
  );

  await ready.promise;
  assert.equal(dashboardStarts, 0);
  const beforeStop = observed.join('\n');
  assert.match(beforeStop, /CRANKING/);
  assert.match(beforeStop, /BACKREAD/);
  assert.match(beforeStop, /CONTEXT/);
  assert.match(beforeStop, /READY/);
  assert.doesNotMatch(beforeStop, /terminal dashboard/i);

  const stopped = await captureCli(['stop'], configurationFilePath);
  assert.equal(stopped.exitCode, 0);
  shutdown.resolve();
  const result = await start;

  assert.equal(result.exitCode, 0);
  assert.equal(dashboardStarts, 0);
  assert.deepEqual(result.errors, []);
});
