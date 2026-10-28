import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { InitializationOptions, InitializationStatus, TerminalPrompt } from '../src/browser/initialization.js';
import { runCli, type CliRuntimeOptions } from '../src/cli.js';
import { NvidiaApiKeyError } from '../src/ai/nvidia.js';
import type { BrowserLaunchSession } from '../src/browser/launch.js';
import { loadConfiguration, saveConfiguration, type Configuration } from '../src/config/configuration.js';
import { generateAliases } from '../src/components/alias-engine.js';
import type { BackreadResult } from '../src/components/backread.js';
import type { CombustionController } from '../src/components/combustion.js';
import { createContextStore } from '../src/components/context-store.js';

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

function createTestCombustionController(onStop?: () => void): CombustionController {
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => {
    resolveStopped = resolve;
  });
  return {
    stopped,
    async stop() {
      onStop?.();
      resolveStopped();
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
    if (role === 'button' && options.name === 'Your profile') return profileButton;
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

test('start prepares the destination, remains alive after readiness, and disconnects on shutdown', async context => {
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
      if (message.startsWith('DEBUG: Alias engine initialized')) events.push('aliases-initialized');
      if (message.startsWith('Engine ready')) events.push('engine-ready-logged');
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
  ]);
  assert.deepEqual(result.output, [
    'NVIDIA API key validated successfully.',
    'Browser launched and connected (Brave Chromium test).',
    'Puppet account name updated: "Test Puppet".',
    `DEBUG: Alias engine initialized for puppet name "Test Puppet" (${generateAliases('Test Puppet').valids.length} aliases).`,
    'WARNING: Browser is minimized. Backread may collect fewer messages than expected.',
    'Retrieved 2 messages; expected 30.',
    'Historical context seeded: 2 messages.',
    `Engine ready at ${validConfiguration.messageDestination}.`,
    'Shutdown requested; disconnecting Playwright.',
  ]);
  assert.deepEqual(result.errors, []);
  const savedConfiguration = loadConfiguration(configurationFilePath);
  assert.equal(savedConfiguration.status, 'valid');
  if (savedConfiguration.status === 'valid') {
    assert.equal(savedConfiguration.configuration.puppetName, 'Test Puppet');
  }
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
      if (message.startsWith('Engine ready')) shutdown.resolve();
    },
  );

  assert.equal(result.exitCode, 130);
  const retrievalFailureIndex = result.output.findIndex(message =>
    message.startsWith('Puppet account name retrieval failed')
  );
  const readyIndex = result.output.findIndex(message => message.startsWith('Engine ready'));
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
    assert.ok(result.output.includes('Debug mode enabled; skipping NVIDIA API key validation.'));
    assert.ok(result.output.includes('debug backread diagnostic'));
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
  assert.ok(!result.output.some(message => message.startsWith('Engine ready')));
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
  assert.ok(!result.output.some(message => message.startsWith('Engine ready')));
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
  assert.ok(!result.output.some(message => message.startsWith('Engine ready')));
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

test('updatekey validates a hidden replacement before saving it', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  const environmentFilePath = saveApplicationApiKey(configurationFilePath, 'nvapi-old-key');
  const submittedKey = 'nvapi-new-key';
  let prompted = false;

  const result = await captureCli(['updatekey'], configurationFilePath, undefined, undefined, {
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

test('stop remains separate and does not attach to or close a browser', async () => {
  let launchAttempted = false;
  const result = await captureCli(['stop'], undefined, undefined, undefined, {
    launchBrowser: async () => {
      launchAttempted = true;
      throw new Error('stop must not launch');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(launchAttempted, false);
  assert.match(result.errors[0], /No browser session is managed/);
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

test('changemessagedestination validates first and saves only after navigation succeeds', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);
  const destination = 'https://www.facebook.com/messages/t/987654321';
  const promptCalls: string[] = [];
  const answers = ['ftp://www.facebook.com/messages/t/987654321', destination];
  let navigationCalls = 0;

  const result = await captureCli(
    ['changemessagedestination'],
    filePath,
    async question => {
      promptCalls.push(question);
      return answers.shift() ?? null;
    },
    undefined,
    {
      navigateMessageDestination: async (configuration, selectedDestination) => {
        navigationCalls += 1;
        assert.deepEqual(configuration, validConfiguration);
        assert.equal(selectedDestination, destination);
        assert.deepEqual(loadConfiguration(filePath), {
          status: 'valid',
          configuration: validConfiguration,
        });
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(navigationCalls, 1);
  assert.equal(promptCalls.length, 2);
  assert.match(result.errors[0], /valid HTTP or HTTPS URL/);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: { ...validConfiguration, messageDestination: destination },
  });
});

test('changemessagedestination cancellation and navigation failure retain the configured destination', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);
  let navigationCalls = 0;

  const cancelled = await captureCli(
    ['changemessagedestination'],
    filePath,
    async () => null,
    undefined,
    {
      navigateMessageDestination: async () => {
        navigationCalls += 1;
      },
    },
  );
  assert.equal(cancelled.exitCode, 0);
  assert.equal(navigationCalls, 0);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: validConfiguration,
  });

  const failed = await captureCli(
    ['changemessagedestination'],
    filePath,
    async () => 'https://www.facebook.com/messages/t/987654321',
    undefined,
    {
      navigateMessageDestination: async () => {
        navigationCalls += 1;
        assert.deepEqual(loadConfiguration(filePath), {
          status: 'valid',
          configuration: validConfiguration,
        });
        throw new Error('CDP attachment failed');
      },
    },
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(navigationCalls, 1);
  assert.match(failed.errors[0], /CDP attachment failed/);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: validConfiguration,
  });
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
    assert.match(result.output[0], /init\s+Initialize impractical-bot/);
    assert.match(result.output[0], /config\s+Configure impractical-bot/);
    assert.match(result.output[0], /changebrowser\s+Change the configured browser/);
    assert.match(result.output[0], /updatekey\s+Replace the NVIDIA API key/);
    assert.match(result.output[0], /start\s+Start impractical-bot/);
    assert.match(result.output[0], /stop\s+Stop impractical-bot/);
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
