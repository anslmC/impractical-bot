import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { InitializationOptions, InitializationStatus, TerminalPrompt } from '../src/browser/initialization.js';
import { runCli } from '../src/cli.js';
import { saveConfiguration, type Configuration } from '../src/config/configuration.js';

async function captureCli(
  args: string[],
  configurationFilePath?: string,
  prompt?: TerminalPrompt,
  initialize?: (options: InitializationOptions) => Promise<InitializationStatus>,
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
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\profile',
  cdpPort: 9222,
};

test('start and stop remain placeholders', async () => {
  for (const command of ['start', 'stop']) {
    const result = await captureCli([command]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [`The ${command} command is not implemented yet.`]);
    assert.deepEqual(result.errors, []);
  }
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

test('config reports validated persisted configuration', async context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);

  const result = await captureCli(['config'], filePath);

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /Browser: brave/);
  assert.match(result.output[0], /Executable: C:\\Program Files\\BraveSoftware/);
  assert.match(result.output[0], /Profile: C:\\Users\\test/);
  assert.match(result.output[0], /CDP port: 9222/);
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