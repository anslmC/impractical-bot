import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { InitializationOptions, InitializationStatus, TerminalPrompt } from '../src/browser/initialization.js';
import { runCli, type CliRuntimeOptions } from '../src/cli.js';
import type { BrowserLaunchSession } from '../src/browser/launch.js';
import { loadConfiguration, saveConfiguration, type Configuration } from '../src/config/configuration.js';

async function captureCli(
  args: string[],
  configurationFilePath?: string,
  prompt?: TerminalPrompt,
  initialize?: (options: InitializationOptions) => Promise<InitializationStatus>,
  runtime?: CliRuntimeOptions,
) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(
    args,
    message => output.push(message),
    message => errors.push(message),
    configurationFilePath,
    prompt,
    initialize,
    runtime,
  );
  return { exitCode, output, errors };
}

function createTemporaryConfigPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-cli-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
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

test('start launches, reports connection, disconnects Playwright, and returns', async context => {
  const configurationFilePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, configurationFilePath);
  let receivedConfiguration: Configuration | undefined;
  let disconnects = 0;
  const session: BrowserLaunchSession = {
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    browserVersion: 'Brave Chromium test',
    async disconnect() {
      disconnects += 1;
    },
  };
  const runtime: CliRuntimeOptions = {
    launchBrowser: async configuration => {
      receivedConfiguration = configuration;
      return session;
    },
  };

  const result = await captureCli(['start'], configurationFilePath, undefined, undefined, runtime);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(receivedConfiguration, validConfiguration);
  assert.equal(disconnects, 1);
  assert.deepEqual(result.output, [
    'Browser launched and connected (Brave Chromium test).',
    'Playwright disconnected; the browser remains open.',
  ]);
  assert.deepEqual(result.errors, []);
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

test('config reports persisted browser, profile, port, and startup URL', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);

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
  assert.deepEqual(result.errors, []);

  saveConfiguration({
    ...validConfiguration,
    skipPinRestoration: true,
    pin: null,
    messageDestination: 'https://www.facebook.com/messages/t/1618007223454558',
  }, filePath);
  const skippedPinResult = await captureCli(['config'], filePath);
  assert.match(skippedPinResult.output[0], /Messenger restoration PIN: null/);
});

test('help options and no command display usage', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = await captureCli(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /Usage: impbot <command>/);
    assert.match(result.output[0], /init\s+Initialize impractical-bot/);
    assert.match(result.output[0], /config\s+Configure impractical-bot/);
    assert.match(result.output[0], /changebrowser\s+Change the configured browser/);
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
