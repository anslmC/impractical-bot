import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { saveConfiguration, type Configuration } from '../src/config/configuration.js';

function captureCli(args: string[], configurationFilePath?: string) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = runCli(
    args,
    message => output.push(message),
    message => errors.push(message),
    configurationFilePath,
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
  profilePath: 'C:\\Users\\test\\AppData\\Local\\impractical-bot\\profile',
  cdpPort: 9222,
};

test('start and stop remain placeholders', () => {
  for (const command of ['start', 'stop']) {
    const result = captureCli([command]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [`The ${command} command is not implemented yet.`]);
    assert.deepEqual(result.errors, []);
  }
});

test('init does not invent browser configuration', () => {
  const result = captureCli(['init']);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors[0], /browser discovery is not implemented/);
  assert.match(result.errors[0], /No configuration was written/);
});

test('config reports when configuration is missing', context => {
  const result = captureCli(['config'], createTemporaryConfigPath(context));

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /Configuration has not been initialized/);
  assert.deepEqual(result.errors, []);
});

test('config reports validated persisted configuration', context => {
  const filePath = createTemporaryConfigPath(context);
  saveConfiguration(validConfiguration, filePath);

  const result = captureCli(['config'], filePath);

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /Browser: brave/);
  assert.match(result.output[0], /Executable: C:\\Program Files\\BraveSoftware/);
  assert.match(result.output[0], /Profile: C:\\Users\\test/);
  assert.match(result.output[0], /CDP port: 9222/);
  assert.deepEqual(result.errors, []);
});

test('help options and no command display usage', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = captureCli(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /Usage: impbot <command>/);
    assert.match(result.output[0], /init\s+Initialize impractical-bot/);
    assert.match(result.output[0], /config\s+Configure impractical-bot/);
    assert.match(result.output[0], /start\s+Start impractical-bot/);
    assert.match(result.output[0], /stop\s+Stop impractical-bot/);
    assert.deepEqual(result.errors, []);
  }
});

test('version options read the version from package metadata', () => {
  const packageMetadata = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };

  for (const option of ['--version', '-v']) {
    const result = captureCli([option]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [packageMetadata.version]);
    assert.deepEqual(result.errors, []);
  }
});

test('unknown commands and unexpected arguments fail with a usage hint', () => {
  for (const args of [['unknown'], ['start', '--force']]) {
    const result = captureCli(args);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.match(result.errors[0], /^Error: /);
    assert.match(result.errors[0], /Usage: impbot <command>/);
  }
});