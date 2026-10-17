import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
  validateConfiguration,
  type Configuration,
} from '../src/config/configuration.js';

const validConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\impractical-bot\\profile',
  cdpPort: 9222,
};

function createTemporaryConfigPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-config-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
}

test('configuration paths use LOCALAPPDATA and reject unsupported or invalid locations', () => {
  const localAppData = join(tmpdir(), 'test-local-app-data');
  const paths = resolveConfigurationPaths({ LOCALAPPDATA: localAppData }, 'win32');
  const expectedDirectory = win32.join(localAppData, 'impractical-bot');

  assert.deepEqual(paths, {
    directory: expectedDirectory,
    filePath: win32.join(expectedDirectory, 'config.json'),
  });
  assert.throws(() => resolveConfigurationPaths({}, 'win32'), /LOCALAPPDATA/);
  assert.throws(
    () => resolveConfigurationPaths({ LOCALAPPDATA: 'relative-path' }, 'win32'),
    /absolute Windows path/,
  );
  assert.throws(
    () => resolveConfigurationPaths({ LOCALAPPDATA: '\\rooted-only' }, 'win32'),
    /absolute Windows path/,
  );
  assert.throws(
    () => resolveConfigurationPaths({ LOCALAPPDATA: localAppData }, 'linux'),
    /not supported/,
  );
});

test('loading distinguishes a missing configuration', context => {
  assert.deepEqual(loadConfiguration(createTemporaryConfigPath(context)), { status: 'missing' });
});

test('valid configuration saves atomically and loads with its schema', context => {
  const filePath = createTemporaryConfigPath(context);

  assert.deepEqual(saveConfiguration(validConfiguration, filePath), validConfiguration);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: validConfiguration,
  });

  const updatedConfiguration: Configuration = {
    ...validConfiguration,
    browser: 'chrome',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  };
  assert.deepEqual(saveConfiguration(updatedConfiguration, filePath), updatedConfiguration);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: updatedConfiguration,
  });
  assert.deepEqual(readdirSync(dirname(filePath)), ['config.json']);
});

test('loading distinguishes malformed JSON and invalid configuration values', context => {
  const filePath = createTemporaryConfigPath(context);
  writeFileSync(filePath, '{ invalid json');
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'malformed',
    message: 'Configuration file is not valid JSON.',
  });

  writeFileSync(filePath, JSON.stringify({ ...validConfiguration, browser: 'firefox' }));
  const result = loadConfiguration(filePath);
  assert.equal(result.status, 'malformed');
  if (result.status === 'malformed') {
    assert.match(result.message, /Browser must be one of/);
  }
});

test('loading distinguishes unsupported schema versions', context => {
  const filePath = createTemporaryConfigPath(context);
  writeFileSync(filePath, JSON.stringify({ ...validConfiguration, version: 2 }));

  assert.deepEqual(loadConfiguration(filePath), {
    status: 'unsupported-version',
    version: 2,
  });
});

test('validation rejects invalid browsers, paths, and CDP ports', () => {
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, browser: 'firefox' }),
    /Browser must be one of/,
  );
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, executablePath: 'chrome.exe' }),
    /absolute Windows path/,
  );
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, executablePath: '\\rooted-only.exe' }),
    /absolute Windows path/,
  );
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, executablePath: 'C:\\apps\\chrome' }),
    /Windows \.exe file/,
  );
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, browser: 'chrome' }),
    /match the selected browser/,
  );
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, profilePath: 'profile' }),
    /absolute Windows path/,
  );

  for (const cdpPort of [0, 65536, 1.5, '9222', null]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, cdpPort }),
      /cdpPort must be an integer between 1 and 65535/,
    );
  }
});

test('saving refuses to overwrite malformed configuration or leave partial files on failure', context => {
  const filePath = createTemporaryConfigPath(context);
  const originalContent = '{ malformed';
  writeFileSync(filePath, originalContent);

  assert.throws(() => saveConfiguration(validConfiguration, filePath), /Refusing to overwrite/);
  assert.equal(readFileSync(filePath, 'utf8'), originalContent);
  assert.deepEqual(readdirSync(dirname(filePath)), ['config.json']);

  const blockingPath = join(dirname(filePath), 'not-a-directory');
  writeFileSync(blockingPath, 'preserve me');
  assert.throws(() => saveConfiguration(validConfiguration, join(blockingPath, 'config.json')));
  assert.equal(readFileSync(blockingPath, 'utf8'), 'preserve me');
  assert.deepEqual(readdirSync(dirname(filePath)).sort(), ['config.json', 'not-a-directory']);
});