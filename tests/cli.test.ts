import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { InitializationOptions, InitializationStatus, TerminalPrompt } from '../src/browser/initialization.js';
import { runCli, type CliRuntimeOptions } from '../src/cli.js';
import type { BrowserLaunchSession } from '../src/browser/launch.js';
import { saveConfiguration, type Configuration } from '../src/config/configuration.js';

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
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\browser-profile',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
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
  assert.match(result.output[0], /CDP port: 9222/);
  assert.match(result.output[0], /Startup URL: https:\/\/www\.facebook\.com/);
  assert.deepEqual(result.errors, []);
});

test('help options and no command display usage', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = await captureCli(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /Usage: impbot <command>/);
    assert.match(result.output[0], /init\s+Initialize impractical-bot/);
    assert.match(result.output[0], /config\s+Configure impractical-bot/);
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
