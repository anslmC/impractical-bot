import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { discoverBrowsers, validateBrowserExecutablePath } from '../src/browser/discovery.js';
import { browserForExecutableName } from '../src/browser/browser-definitions.js';
import { BROWSER_IDS, type BrowserId } from '../src/config/configuration.js';

const environment: NodeJS.ProcessEnv = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  PATH: 'C:\\Tools',
};

const executablePaths: Record<BrowserId, string> = {
  brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  chrome: 'Google\\Chrome\\Application\\chrome.exe',
  edge: 'Microsoft\\Edge\\Application\\msedge.exe',
};

function knownPath(browser: BrowserId, root = environment.ProgramFiles as string): string {
  return win32.join(root, executablePaths[browser]);
}

function normalized(path: string): string {
  return win32.normalize(path).replace(/\\+$/, '').toLowerCase();
}

test('maps executable names to supported browsers case-insensitively', () => {
  assert.equal(browserForExecutableName('brave.exe'), 'brave');
  assert.equal(browserForExecutableName('CHROME.EXE'), 'chrome');
  assert.equal(browserForExecutableName('msedge.exe'), 'edge');
  assert.equal(browserForExecutableName('firefox.exe'), undefined);
  assert.equal(browserForExecutableName(''), undefined);
});

test('discovers each supported browser from known installation paths', async () => {
  const expectedDisplayNames = {
    brave: 'Brave Browser',
    chrome: 'Google Chrome',
    edge: 'Microsoft Edge',
  };

  for (const browser of BROWSER_IDS) {
    const executablePath = knownPath(browser);
    const results = await discoverBrowsers({
      platform: 'win32',
      environment,
      fileExists: path => normalized(path) === normalized(executablePath),
      registryLookup: async () => [],
      pathLookup: async () => [],
    });

    assert.deepEqual(results, [{
      browser,
      displayName: expectedDisplayNames[browser],
      executablePath,
    }]);
  }
});

test('finds multiple installation locations in deterministic order', async () => {
  const perUserPath = knownPath('brave', environment.LOCALAPPDATA);
  const systemPath = knownPath('brave');
  const installedPaths = new Set([normalized(perUserPath), normalized(systemPath)]);

  const results = await discoverBrowsers({
    platform: 'win32',
    environment,
    fileExists: path => installedPaths.has(normalized(path)),
    registryLookup: async () => [],
    pathLookup: async () => [],
  });

  assert.deepEqual(results.map(candidate => candidate.executablePath), [perUserPath, systemPath]);
});

test('deduplicates executable paths across discovery sources', async () => {
  const executablePath = knownPath('brave', environment.LOCALAPPDATA);
  const alternativeSpelling = executablePath.replaceAll('\\', '/').toUpperCase();

  const results = await discoverBrowsers({
    platform: 'win32',
    environment,
    fileExists: path => normalized(path) === normalized(executablePath),
    registryLookup: async browser => browser === 'brave' ? [alternativeSpelling] : [],
    pathLookup: async name => name === 'brave.exe' ? [alternativeSpelling] : [],
  });

  assert.deepEqual(results.map(candidate => candidate.executablePath), [executablePath]);
});

test('registry and PATH failures are ignored while missing executables are rejected', async () => {
  const results = await discoverBrowsers({
    platform: 'win32',
    environment,
    fileExists: () => false,
    registryLookup: async () => {
      throw new Error('registry unavailable');
    },
    pathLookup: async () => {
      throw new Error('PATH unavailable');
    },
  });

  assert.deepEqual(results, []);
});

test('registry and PATH results are executable-verified and retain source ordering', async () => {
  const registryPath = 'C:\\Registry\\Microsoft\\Edge\\msedge.exe';
  const pathResult = 'C:\\Portable\\chrome.exe';
  const existingPaths = new Set([normalized(registryPath), normalized(pathResult)]);

  const results = await discoverBrowsers({
    platform: 'win32',
    environment,
    fileExists: path => existingPaths.has(normalized(path)),
    registryLookup: async browser => browser === 'edge' ? [registryPath] : [],
    pathLookup: async name => name === 'chrome.exe' ? [pathResult] : [],
  });

  assert.deepEqual(results.map(candidate => candidate.executablePath), [registryPath, pathResult]);
  assert.deepEqual(results.map(candidate => candidate.browser), ['edge', 'chrome']);
});

test('default PATH lookup searches only the injected Windows PATH', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-path-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const executablePath = join(directory, 'chrome.exe');
  writeFileSync(executablePath, '');

  const results = await discoverBrowsers({
    platform: 'win32',
    environment: { PATH: directory },
    registryLookup: async () => [],
  });

  assert.deepEqual(results, [{
    browser: 'chrome',
    displayName: 'Google Chrome',
    executablePath,
  }]);
});

test('manual executable paths accept supported names and reject invalid paths', () => {
  assert.equal(validateBrowserExecutablePath('C:\\Apps\\brave.exe').browser, 'brave');
  assert.equal(validateBrowserExecutablePath('C:\\Apps\\CHROME.EXE').browser, 'chrome');
  assert.equal(validateBrowserExecutablePath('C:\\Apps\\msedge.exe').browser, 'edge');
  assert.throws(() => validateBrowserExecutablePath(' chrome.exe'), /fully qualified/);
  assert.throws(() => validateBrowserExecutablePath('\\rooted\\brave.exe'), /fully qualified/);
  assert.throws(() => validateBrowserExecutablePath('C:\\Apps\\firefox.exe'), /must be brave/);
  assert.throws(() => validateBrowserExecutablePath('C:\\Apps\\chrome.exe '), /fully qualified/);
});

test('unsupported platforms fail before invoking Windows discovery sources', async () => {
  let called = false;
  await assert.rejects(
    discoverBrowsers({
      platform: 'linux',
      registryLookup: async () => {
        called = true;
        return [];
      },
      pathLookup: async () => {
        called = true;
        return [];
      },
    }),
    /not supported/,
  );
  assert.equal(called, false);
});