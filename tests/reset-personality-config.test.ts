import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadConfiguration,
  saveConfiguration,
  type Configuration,
} from '../src/config/configuration.js';

// This test compiles to dist/tests, so the project root is three levels up.
const projectRoot = dirname(dirname(__dirname));
const utilityPath = join(projectRoot, 'Tools', 'utilities', 'reset-personality-config.js');

const customConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\profile',
  skipPinRestoration: false,
  pin: '001234',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
  messageDestination: 'https://www.facebook.com/messages',
  puppetName: 'Test Puppet',
  botTemperament: 'talkative',
  botPersonality: 'custom',
  customPersonalityInstruction: 'Sarcastic and deadpan. Never cheerful.',
};

interface TemporaryLocalAppData {
  localAppData: string;
  configPath: string;
}

function createTemporaryLocalAppData(context: TestContext): TemporaryLocalAppData {
  const localAppData = mkdtempSync(join(tmpdir(), 'impractical-bot-reset-'));
  context.after(() => rmSync(localAppData, { recursive: true, force: true }));
  return {
    localAppData,
    configPath: join(localAppData, 'Impractical Bot', 'config.json'),
  };
}

function runUtility(localAppData: string) {
  const result = spawnSync(process.execPath, [utilityPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('reset utility restores the default personality and preserves unrelated settings', context => {
  const { localAppData, configPath } = createTemporaryLocalAppData(context);
  saveConfiguration(customConfiguration, configPath);

  const result = runUtility(localAppData);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /default/);
  assert.equal(result.stderr, '');

  const loaded = loadConfiguration(configPath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status !== 'valid') {
    return;
  }
  assert.equal(loaded.configuration.botPersonality, 'default');
  assert.equal(loaded.configuration.customPersonalityInstruction, undefined);

  const personalityKeys = new Set(['botPersonality', 'customPersonalityInstruction']);
  for (const [key, value] of Object.entries(customConfiguration)) {
    if (personalityKeys.has(key)) {
      continue;
    }
    assert.deepEqual(
      (loaded.configuration as unknown as Record<string, unknown>)[key],
      value,
      `expected ${key} to be preserved`,
    );
  }
});

test('reset utility never prints the stored custom personality instruction', context => {
  const { localAppData, configPath } = createTemporaryLocalAppData(context);
  saveConfiguration(customConfiguration, configPath);

  const result = runUtility(localAppData);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes(customConfiguration.customPersonalityInstruction!), false);
  assert.equal(result.stderr.includes(customConfiguration.customPersonalityInstruction!), false);
  assert.equal(result.stdout.includes(customConfiguration.pin!), false);
});

test('reset utility leaves an already default configuration untouched', context => {
  const { localAppData, configPath } = createTemporaryLocalAppData(context);
  saveConfiguration(
    { ...customConfiguration, botPersonality: 'default', customPersonalityInstruction: undefined },
    configPath,
  );
  const before = readFileSync(configPath, 'utf8');

  const result = runUtility(localAppData);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /already 'default'/);
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('reset utility reports a missing configuration without creating one', context => {
  const { localAppData, configPath } = createTemporaryLocalAppData(context);
  mkdirSync(dirname(configPath), { recursive: true });

  const result = runUtility(localAppData);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found/);
  assert.equal(loadConfiguration(configPath).status, 'missing');
});

test('reset utility refuses to overwrite a malformed configuration', context => {
  const { localAppData, configPath } = createTemporaryLocalAppData(context);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, '{ not json', 'utf8');

  const result = runUtility(localAppData);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed/i);
  assert.equal(readFileSync(configPath, 'utf8'), '{ not json');
});
