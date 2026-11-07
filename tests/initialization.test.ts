import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  getBrowserProfilePath,
  initializeConfiguration,
  promptBotPersonality,
  promptBotTemperament,
  promptMultilinePersonality,
  promptPinRestorationSettings,
} from '../src/browser/initialization.js';
import {
  loadConfiguration,
  resolveComposerSlicer,
  saveConfiguration,
  type Configuration,
} from '../src/config/configuration.js';

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
  skipPinRestoration: false,
  pin: '001234',
  cdpPort: 9222,
  startupUrl: 'https://www.facebook.com',
  messageDestination: 'https://www.facebook.com/messages',
  botTemperament: 'balanced',
  botPersonality: 'default',
  composerSlicer: { enabled: true, maxCharacters: 500 },
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
  assert.equal(promptCalls.length, 2);
  assert.match(promptCalls[0], /Rediscover available browsers/);
  assert.match(promptCalls[1], /Select this browser/);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'chrome');
    assert.equal(loaded.configuration.executablePath, chromePath);
  }
});

test('initial setup retries invalid message destination URLs', async context => {
  const filePath = createConfigurationPath(context);
  const errors: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'not-a-url', 'ftp://example.test/messages', ' https://example.test/messages ', 'yes', '', ''],
    errors,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.equal(errors.length, 2);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.messageDestination, 'https://example.test/messages');
    assert.equal(loaded.configuration.pin, null);
  }
});

test('a single discovered browser requires confirmation before saving', async context => {
  const filePath = createConfigurationPath(context);
  const promptCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', '', '123456', '', ''],
    promptCalls,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'brave');
    assert.equal(loaded.configuration.executablePath, bravePath);
    assert.equal(loaded.configuration.profilePath, win32.join(win32.dirname(filePath), 'brave-profile'));
    assert.equal(loaded.configuration.skipPinRestoration, false);
    assert.equal(loaded.configuration.pin, '123456');
    assert.equal(loaded.configuration.messageDestination, 'https://example.test/messages');
    assert.equal(existsSync(loaded.configuration.profilePath), false);
  }
  assert.match(promptCalls[2], /Skip Messenger PIN restoration/);
});

test('initial setup saves an affirmative PIN-restoration skip preference', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', 'yes', '3', ''],
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.skipPinRestoration, true);
    assert.equal(loaded.configuration.pin, null);
    assert.equal(loaded.configuration.messageDestination, 'https://example.test/messages');
    assert.equal(loaded.configuration.botTemperament, 'talkative');
  }
});

test('initial setup asks for bot temperament then personality and defaults both', async context => {
  const filePath = createConfigurationPath(context);
  const promptCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', 'yes', '', ''],
    promptCalls,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.equal(promptCalls.length, 5);
  assert.match(promptCalls[3], /temperament/i);
  assert.match(promptCalls[4], /personality/i);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botTemperament, 'balanced');
    assert.equal(loaded.configuration.botPersonality, 'default');
  }
});

test('fresh configuration uses the 100-character composer slicer default', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', 'yes', '', ''],
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.composerSlicer, undefined);
    assert.deepEqual(resolveComposerSlicer(loaded.configuration), {
      enabled: true,
      maxCharacters: 100,
    });
  }
});

test('startup preserves an explicitly configured composer slicer while backfilling defaults', async context => {
  const filePath = createConfigurationPath(context);
  const configured = {
    ...existingConfiguration,
    composerSlicer: { enabled: false, maxCharacters: 750 },
  };
  const legacyConfiguration: Record<string, unknown> = { ...configured };
  delete legacyConfiguration.cdpPort;
  delete legacyConfiguration.startupUrl;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
  })), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.deepEqual(loaded.configuration.composerSlicer, {
      enabled: false,
      maxCharacters: 750,
    });
    assert.deepEqual(resolveComposerSlicer(loaded.configuration), {
      enabled: false,
      maxCharacters: 750,
    });
  }
});

test('legacy configuration without temperament defaults to Balanced and can be backfilled', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.botTemperament;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botTemperament, 'balanced');
    assert.equal(loaded.needsBotTemperamentBackfill, true);
  }

  const promptCalls: string[] = [];
  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['1'],
    promptCalls,
  })), 'saved');
  assert.equal(promptCalls.length, 1);
  assert.match(promptCalls[0], /temperament/i);
  const saved = loadConfiguration(filePath);
  assert.equal(saved.status, 'valid');
  if (saved.status === 'valid') {
    assert.equal(saved.configuration.botTemperament, 'quiet');
  }
});

test('init backfills messageDestination and preserves existing settings', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.messageDestination;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));
  const promptCalls: string[] = [];

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['https://example.test/messages'],
    promptCalls,
  })), 'saved');
  assert.match(promptCalls[0], /message destination URL/);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.deepEqual(loaded.configuration, {
      ...existingConfiguration,
      messageDestination: 'https://example.test/messages',
    });
  }
});

test('PIN preference prompt accepts Y, y, N, n, whitespace, and the default', async () => {
  for (const answer of ['Y', 'y', ' y ', 'N', 'n', ' N ', '']) {
    const skipPinRestoration = ['Y', 'y', ' y '].includes(answer);
    const answers = [answer, ...(skipPinRestoration ? [] : ['000007'])];
    const settings = await promptPinRestorationSettings(
      async () => answers.shift() ?? null,
      () => undefined,
    );

    assert.deepEqual(settings, {
      skipPinRestoration,
      pin: skipPinRestoration ? null : '000007',
    });
  }
});

test('PIN preference prompt retries invalid answers and PINs without exposing the PIN', async () => {
  const answers = ['maybe', 'N', '', '12345', '12a456', '001234'];
  const errors: string[] = [];
  let promptCount = 0;
  const settings = await promptPinRestorationSettings(async () => {
    promptCount += 1;
    return answers.shift() ?? null;
  }, message => errors.push(message));

  assert.deepEqual(settings, { skipPinRestoration: false, pin: '001234' });
  assert.equal(promptCount, 6);
  assert.equal(errors.length, 4);
  assert.ok(errors.every(message => !message.includes('001234')));
});

test('init preserves an existing PIN-restoration preference without prompting', async context => {
  const filePath = createConfigurationPath(context);
  const configuration = { ...existingConfiguration, skipPinRestoration: true, pin: null };
  saveConfiguration(configuration, filePath);
  const promptCalls: string[] = [];

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
    promptCalls,
  })), 'preserved');
  assert.deepEqual(promptCalls, []);
  assert.deepEqual(loadConfiguration(filePath), { status: 'valid', configuration });
});

test('init backfills skipPinRestoration without changing an existing browser selection', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.skipPinRestoration;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  assert.equal(await initializeConfiguration(createOptions(filePath, { installedPaths: [bravePath] })), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.deepEqual(loaded.configuration, {
      ...existingConfiguration,
      skipPinRestoration: false,
    });
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
    answers: ['2', 'https://example.test/messages', 'n', '012345', '1', ''],
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
    assert.equal(loaded.configuration.pin, '012345');
    assert.equal(loaded.configuration.messageDestination, 'https://example.test/messages');
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
    answers: ['4', ` ${edgePath} `, edgePath, 'https://example.test/messages', 'n', '012345', '', ''],
    errors,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.ok(errors.length > 0);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'edge');
    assert.equal(loaded.configuration.executablePath, edgePath);
    assert.equal(loaded.configuration.pin, '012345');
    assert.equal(loaded.configuration.messageDestination, 'https://example.test/messages');
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
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.skipPinRestoration;
  delete legacyConfiguration.cdpPort;
  delete legacyConfiguration.startupUrl;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  assert.equal(await initializeConfiguration(createOptions(filePath, { installedPaths: [bravePath] })), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.ok(loaded.configuration.cdpPort && loaded.configuration.cdpPort >= 20_000);
    assert.ok(loaded.configuration.cdpPort < 60_000);
    assert.equal(loaded.configuration.startupUrl, 'https://www.facebook.com');
    assert.equal(loaded.configuration.profilePath, legacyConfiguration.profilePath);
    assert.equal(loaded.configuration.skipPinRestoration, false);
    assert.equal(loaded.configuration.pin, existingConfiguration.pin);
  }
});

test('init reconfigures a legacy config missing its required PIN without changing unrelated fields', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.pin;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['n', '000042'],
  })), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.deepEqual(loaded.configuration, {
      ...existingConfiguration,
      pin: '000042',
    });
  }
});

test('init backfills a missing PIN as null when legacy restoration is skipped', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = {
    ...existingConfiguration,
    skipPinRestoration: true,
  };
  delete legacyConfiguration.pin;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));
  const promptCalls: string[] = [];

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [bravePath],
    promptCalls,
  })), 'saved');
  assert.deepEqual(promptCalls, []);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.skipPinRestoration, true);
    assert.equal(loaded.configuration.pin, null);
  }
});

test('initial setup persists a custom multiline personality with behavioral defaults intact', async context => {
  const filePath = createConfigurationPath(context);
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', 'yes', '', 'custom', 'Sarcastic and deadpan.', 'Never cheerful.', '.'],
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botPersonality, 'custom');
    assert.equal(
      loaded.configuration.customPersonalityInstruction,
      'Sarcastic and deadpan.\nNever cheerful.',
    );
  }
});

test('re-init rediscovery preserves an existing custom personality instruction', async context => {
  const filePath = createConfigurationPath(context);
  saveConfiguration(
    {
      ...existingConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: 'Sarcastic and deadpan.',
    },
    filePath,
  );

  assert.equal(await initializeConfiguration(createOptions(filePath, {
    installedPaths: [chromePath],
    answers: ['yes', 'y'],
  })), 'saved');

  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.browser, 'chrome');
    assert.equal(loaded.configuration.botPersonality, 'custom');
    assert.equal(loaded.configuration.customPersonalityInstruction, 'Sarcastic and deadpan.');
  }
});

test('personality prompt defaults to the current mode and never exposes the stored instruction', async () => {
  const seen: string[] = [];
  const output: string[] = [];
  const keptSelection = await promptBotPersonality(
    createPrompt([''], seen),
    message => output.push(message),
    message => output.push(message),
    'custom',
    'stored-secret-instruction',
  );
  assert.deepEqual(keptSelection, { mode: 'custom', instruction: 'stored-secret-instruction' });
  assert.ok(!seen.some(message => message.includes('stored-secret-instruction')));
  assert.ok(!output.some(message => message.includes('stored-secret-instruction')));

  const defaultSelection = await promptBotPersonality(
    createPrompt(['']),
    () => undefined,
    () => undefined,
    'default',
  );
  assert.deepEqual(defaultSelection, { mode: 'default' });
});

test('personality prompt collects multiline custom text until a terminating period', async () => {
  const answers: Array<string | null> = ['custom', 'first line', 'second line', '   ', '.'];
  const selection = await promptBotPersonality(
    createPrompt(answers),
    () => undefined,
    () => undefined,
  );
  assert.deepEqual(selection, { mode: 'custom', instruction: 'first line\nsecond line' });
});

test('personality prompt retries invalid answers and cancellation returns null', async () => {
  const errors: string[] = [];
  const retryAnswers: Array<string | null> = ['loud', 'default'];
  const retry = await promptBotPersonality(
    createPrompt(retryAnswers),
    () => undefined,
    message => errors.push(message),
  );
  assert.deepEqual(retry, { mode: 'default' });
  assert.match(errors[0], /Choose 1 \(Default\) or 2 \(Custom\)/);

  const cancelled = await promptBotPersonality(createPrompt([null]), () => undefined, () => undefined);
  assert.equal(cancelled, null);
});

test('temperament and personality prompts present numbered choices', async () => {
  const temperamentQuestions: string[] = [];
  const temperamentOutput: string[] = [];
  const temperament = await promptBotTemperament(
    createPrompt(['2'], temperamentQuestions),
    message => temperamentOutput.push(message),
    () => undefined,
    'balanced',
  );

  assert.equal(temperament, 'balanced');
  assert.match(temperamentQuestions[0] ?? '', /Select temperament \[1-3\]/);
  assert.ok(temperamentOutput.includes('  [1] Quiet: 10% yes / 90% no'));
  assert.ok(temperamentOutput.includes('  [2] Balanced: 50% yes / 50% no (current)'));
  assert.ok(temperamentOutput.includes('  [3] Talkative: 95% yes / 5% no'));

  const personalityQuestions: string[] = [];
  const personalityOutput: string[] = [];
  const personality = await promptBotPersonality(
    createPrompt(['2', 'deadpan', '.'], personalityQuestions),
    message => personalityOutput.push(message),
    () => undefined,
    'default',
  );

  assert.deepEqual(personality, { mode: 'custom', instruction: 'deadpan' });
  assert.match(personalityQuestions[0] ?? '', /Select personality \[1-2\]/);
  assert.ok(personalityOutput.includes('  [1] Default: Existing personality behavior (current)'));
  assert.ok(personalityOutput.includes('  [2] Custom: Your own custom instruction block'));
});

test('invalid numbered choices retry and cancellation returns null', async () => {
  const temperamentErrors: string[] = [];
  const temperamentQuestions: string[] = [];
  const temperament = await promptBotTemperament(
    createPrompt(['9', '3'], temperamentQuestions),
    () => undefined,
    message => temperamentErrors.push(message),
  );
  assert.equal(temperament, 'talkative');
  assert.match(
    temperamentErrors[0] ?? '',
    /Choose 1 \(Quiet\), 2 \(Balanced\), or 3 \(Talkative\)/,
  );
  assert.match(temperamentQuestions[0] ?? '', /default: Balanced/);

  const personalityErrors: string[] = [];
  const personality = await promptBotPersonality(
    createPrompt(['7', '1']),
    () => undefined,
    message => personalityErrors.push(message),
  );
  assert.deepEqual(personality, { mode: 'default' });
  assert.match(personalityErrors[0] ?? '', /Choose 1 \(Default\) or 2 \(Custom\)/);

  assert.equal(
    await promptBotTemperament(createPrompt([null]), () => undefined, () => undefined),
    null,
  );
  assert.equal(
    await promptBotPersonality(createPrompt([null]), () => undefined, () => undefined),
    null,
  );
});

test('initial setup accepts numeric temperament and personality selections', async context => {
  const filePath = createConfigurationPath(context);
  const promptCalls: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers: ['y', 'https://example.test/messages', 'yes', '3', '2', 'Cold and impersonal.', '.'],
    promptCalls,
  });

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.match(promptCalls[3] ?? '', /Select temperament \[1-3\]/);
  assert.match(promptCalls[4] ?? '', /Select personality \[1-2\]/);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botTemperament, 'talkative');
    assert.equal(loaded.configuration.botPersonality, 'custom');
    assert.equal(loaded.configuration.customPersonalityInstruction, 'Cold and impersonal.');
  }
});

test('multiline personality collection rejects an empty block and supports cancellation', async () => {
  const errors: string[] = [];
  const empty = await promptMultilinePersonality(
    createPrompt(['.', '']),
    () => undefined,
    message => errors.push(message),
  );
  assert.equal(empty, null);
  assert.match(errors[0], /must not be empty/);

  const cancelled = await promptMultilinePersonality(createPrompt([null]), () => undefined, () => undefined);
  assert.equal(cancelled, null);

  const trimmed = await promptMultilinePersonality(
    createPrompt(['  padded  ', '.']),
    () => undefined,
    () => undefined,
  );
  assert.equal(trimmed, 'padded');
});

test('init backfill preserves configuration persisted while prompts are open', async context => {
  const filePath = createConfigurationPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...existingConfiguration };
  delete legacyConfiguration.botTemperament;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  const concurrent = {
    ...existingConfiguration,
    puppetName: 'Concurrent Puppet',
    botTemperament: 'talkative' as const,
    messageDestination: 'https://www.facebook.com/messages/t/777777777',
  };
  const options = createOptions(filePath, { installedPaths: [bravePath] });
  let prompts = 0;
  options.prompt = async question => {
    prompts += 1;
    assert.match(question, /temperament/i);
    saveConfiguration(concurrent, filePath);
    return '1';
  };

  assert.equal(await initializeConfiguration(options), 'saved');
  assert.equal(prompts, 1);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    // The concurrently persisted values win over the stale backfill snapshot.
    assert.equal(loaded.configuration.botTemperament, 'talkative');
    assert.equal(loaded.configuration.puppetName, 'Concurrent Puppet');
    assert.equal(
      loaded.configuration.messageDestination,
      'https://www.facebook.com/messages/t/777777777',
    );
  }
});

test('init PIN-restoration backfill preserves unrelated concurrent updates', async context => {
  const filePath = createConfigurationPath(context);
  const pinRequiredConfiguration: Record<string, unknown> = {
    ...existingConfiguration,
    skipPinRestoration: false,
  };
  delete pinRequiredConfiguration.pin;
  writeFileSync(filePath, JSON.stringify(pinRequiredConfiguration));

  const concurrent = {
    ...pinRequiredConfiguration,
    puppetName: 'Concurrent Puppet',
    messageDestination: 'https://www.facebook.com/messages/t/888888888',
  };
  const options = createOptions(filePath, { installedPaths: [bravePath], answers: ['n', '000042'] });
  const basePrompt = options.prompt;
  let prompts = 0;
  options.prompt = async question => {
    prompts += 1;
    if (prompts === 1) {
      // A concurrent writer changes unrelated fields but leaves the PIN unset.
      writeFileSync(filePath, JSON.stringify(concurrent));
    }
    return basePrompt(question);
  };

  assert.equal(await initializeConfiguration(options), 'saved');
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.pin, '000042');
    assert.equal(loaded.configuration.skipPinRestoration, false);
    assert.equal(loaded.configuration.puppetName, 'Concurrent Puppet');
    assert.equal(
      loaded.configuration.messageDestination,
      'https://www.facebook.com/messages/t/888888888',
    );
  }
});

test('fresh init aborts rather than overwriting a configuration created while prompts are open', async context => {
  const filePath = createConfigurationPath(context);
  const concurrent = { ...existingConfiguration, puppetName: 'Concurrent Puppet' };
  const answers = [
    'y',
    'https://example.test/messages',
    'n',
    '000042',
    '1',
    'default',
  ];
  const errors: string[] = [];
  const options = createOptions(filePath, {
    installedPaths: [bravePath],
    answers,
    errors,
  });
  let wroteConcurrent = false;
  options.prompt = async question => {
    if (/Select this browser/.test(question) && !wroteConcurrent) {
      wroteConcurrent = true;
      saveConfiguration(concurrent, filePath);
    }
    return answers.shift() ?? null;
  };

  assert.equal(await initializeConfiguration(options), 'failed');
  assert.match(
    errors.join('\n'),
    /configuration changed while prompts were open/,
  );
  assert.deepEqual(loadConfiguration(filePath), { status: 'valid', configuration: concurrent });
});