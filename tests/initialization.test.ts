import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getBrowserProfilePath, initializeConfiguration } from '../src/browser/initialization.js';
import { loadConfiguration, saveConfiguration, type Configuration } from '../src/config/configuration.js';

const environment: NodeJS.ProcessEnv = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  PATH: '',
};

const bravePath = win32.join(environment.ProgramFiles as string, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe');
const chromePath = win32.join(environment.ProgramFiles as string, 'Google\\Chrome\\Application\\chrome.exe');
const edgePath = 'C:\\Manual\\msedge.exe';

function normalized(path: string): string {
  return win32.normalize(path).replace(/\\+$/, '').toLowerCase();
}

function createConfigurationPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-init-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
}

function createPrompt(answers: Array<string | null>, seen: string[] = []) {
  return async (question: string): Promise<string | null> => {
    seen.push(question);
    return answers.shift() ?? null;
  };
}

function createOptions(
  configurationFilePath: string,
  options: {
    installedPaths?: string[];
    answers?: Array<string | null>;
    promptCalls?: string[];
    discoveryCalls?: string[];
    output?: string[];
    errors?: string[];
  } = {},
) {
  return {
    configurationFilePath,
    platform: 'win32' as NodeJS.Platform,
    environment,
    fileExists: (path: string) =>
      (options.installedPaths ?? []).some(installed => normalized(installed) === normalized(path)),
    registryLookup: async (browser: string) => {
      options.discoveryCalls?.push(`registry:${browser}`);
      return [];
    },
    pathLookup: async (executable: string) => {
      options.discoveryCalls?.push(`path:${executable}`);
      return [];
    },
    prompt: createPrompt(options.answers ?? [], options.promptCalls),
    writeOutput: (message: string) => options.output?.push(message),
    writeError: (message: string) => options.errors?.push(message),
  };
}

const existingConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: bravePath,
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\browser-profile',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
};

test('browser profile paths use stable browser-specific names', () => {
  const configurationFilePath = 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\config.json';

  assert.equal(getBrowserProfilePath('brave', configurationFilePath),
    'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\brave-profile');
  assert.equal(getBrowserProfilePath('edge', configurationFilePath),
    'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\msedge-profile');
  assert.equal(getBrowserProfilePath('chrome', configurationFilePath),
    'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\chrome-profile');
});

test('a valid saved browser selection is preserved without prompting or rediscovery', async context => {
  const filePath = createConfigurationPath(context);
  saveConfiguration(existingConfiguration, filePath);
  const promptCalls: string[] = [];
  const discoveryCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    promptCalls,
    discoveryCalls,
  });

  assert.equal(await initializeConfiguration(options), 'preserved');
  assert.deepEqual(promptCalls, []);
  assert.deepEqual(discoveryCalls, []);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: existingConfiguration,
  });
});

test('a stale saved executable requires rediscovery consent and does not switch silently', async context => {
  const filePath = createConfigurationPath(context);
  saveConfiguration(existingConfiguration, filePath);
  const discoveryCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [chromePath],
    answers: ['n'],
    discoveryCalls,
  });

  assert.equal(await initializeConfiguration(options), 'cancelled');
  assert.deepEqual(discoveryCalls, []);
  assert.deepEqual(loadConfiguration(filePath), {
    status: 'valid',
    configuration: existingConfiguration,
  });
});

test('confirmed rediscovery can replace a stale selection only after selection confirmation', async context => {
  const filePath = createConfigurationPath(context);
  saveConfiguration(existingConfiguration, filePath);
  const promptCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [chromePath],
    answers: ['yes', 'y'],
    promptCalls,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.match(promptCalls[0], /Rediscover available browsers/);
  assert.match(promptCalls[1], /Select this browser/);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'chrome');
    assert.equal(loaded.configuration.executablePath, chromePath);
  }
});

test('a single discovered browser requires confirmation before saving', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y'],
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'brave');
    assert.equal(loaded.configuration.executablePath, bravePath);
    assert.equal(loaded.configuration.profilePath, win32.join(win32.dirname(filePath), 'brave-profile'));
    assert.equal(existsSync(loaded.configuration.profilePath), false);
  }
});

test('a selected executable that disappears before save is rejected without writing', async context => {
  const filePath = createConfigurationPath(context);
  const installedPaths = [bravePath];
  const options = createOptions(filePath, {
    installedPaths,
    answers: ['y'],
  });
  options.prompt = async () => {
    installedPaths.length = 0;
    return 'y';
  };

  assert.equal(await initializeConfiguration(options), 'failed');
  assert.deepEqual(loadConfiguration(filePath), { status: 'missing' });
});

test('multiple browsers show a menu and persist only the selected browser', async context => {
  const filePath = createConfigurationPath(context);
  const output: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath, chromePath],
    answers: ['2'],
    output,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.ok(output.some(message => message.includes('1) Brave Browser')));
  assert.ok(output.some(message => message.includes('2) Google Chrome')));
  assert.ok(output.some(message => message.includes('manual')));
  assert.ok(output.some(message => message.includes('Cancel')));
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'chrome');
  }
});

test('cancelling selection leaves configuration missing', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    installedPaths: [bravePath, chromePath],
    answers: ['0'],
  });

  assert.equal(await initializeConfiguration(options), 'cancelled');
  assert.deepEqual(loadConfiguration(filePath), { status: 'missing' });
});

test('manual path input retries invalid values and saves only an existing supported executable', async context => {
  const filePath = createConfigurationPath(context);
  const errors: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [edgePath],
    answers: ['4', ` ${edgePath} `, edgePath],
    errors,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.ok(errors.length > 0);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'edge');
    assert.equal(loaded.configuration.executablePath, edgePath);
  }
});

test('manual path cancellation or failed validation never writes configuration', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    answers: ['C:\\Unsupported\\firefox.exe', null],
  });

  assert.equal(await initializeConfiguration(options), 'cancelled');
  assert.deepEqual(loadConfiguration(filePath), { status: 'missing' });
});

test('when discovery is empty, manual path entry or cancellation is offered', async context => {
  const filePath = createConfigurationPath(context);
  const output: string[] = [];
  const options = createOptions(filePath, {
    answers: [null],
    output,
  });

  assert.equal(await initializeConfiguration(options), 'cancelled');
  assert.ok(output.some(message => message.includes('No supported browser executables')));
  assert.deepEqual(loadConfiguration(filePath), { status: 'missing' });
});

test('malformed and unsupported configurations are not overwritten', async context => {
  const filePath = createConfigurationPath(context);
  const malformedContent = '{ malformed';
  writeFileSync(filePath, malformedContent);
  const malformedOptions = createOptions(filePath, { installedPaths: [chromePath] });

  assert.equal(await initializeConfiguration(malformedOptions), 'failed');
  assert.equal(readFileSync(filePath, 'utf8'), malformedContent);

  writeFileSync(filePath, JSON.stringify({ ...existingConfiguration, version: 2 }));
  const unsupportedContent = readFileSync(filePath, 'utf8');
  assert.equal(await initializeConfiguration(createOptions(filePath, { installedPaths: [chromePath] })), 'failed');
  assert.equal(readFileSync(filePath, 'utf8'), unsupportedContent);
});

test('a legacy valid configuration is upgraded with a CDP port and startup URL', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration = { ...existingConfiguration };
  delete (legacyConfiguration as Partial<Configuration>).cdpPort;
  delete (legacyConfiguration as Partial<Configuration>).startupUrl;
  saveConfiguration(legacyConfiguration, filePath);

  assert.equal(await initializeConfiguration(createOptions(filePath, { installedPaths: [bravePath] })), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.ok(loaded.configuration.cdpPort && loaded.configuration.cdpPort >= 20_000);
    assert.ok(loaded.configuration.cdpPort < 60_000);
    assert.equal(loaded.configuration.startupUrl, 'https://www.facebook.com');
    assert.equal(loaded.configuration.profilePath, legacyConfiguration.profilePath);
  }
});