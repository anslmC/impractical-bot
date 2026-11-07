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
  BOT_TEMPERAMENT_COOLDOWNS_MS,
  BOT_TEMPERAMENT_YES_PROBABILITIES,
  DEFAULT_COMPOSER_SLICER,
  MAX_PERSONALITY_INSTRUCTION_CHARS,
  getBotTemperamentCooldownMs,
  getBotTemperamentYesProbability,
  isBotPersonalityMode,
  loadConfiguration,
  resolveBotPersonalityMode,
  resolveComposerSlicer,
  resolveConfigurationPaths,
  saveConfiguration,
  validateConfiguration,
  type Configuration,
} from '../src/config/configuration.js';

const validConfiguration: Configuration = {
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
  botTemperament: 'balanced',
  botPersonality: 'default',
  composerSlicer: { enabled: true, maxCharacters: 500 },
};

function createTemporaryConfigPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-config-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
}

test('configuration paths use LOCALAPPDATA and reject unsupported or invalid locations', () => {
  const localAppData = join(tmpdir(), 'test-local-app-data');
  const paths = resolveConfigurationPaths({ LOCALAPPDATA: localAppData }, 'win32');
  const expectedDirectory = win32.join(localAppData, 'Impractical Bot');

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
    puppetName: 'Updated Puppet',
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
  for (const startupUrl of ['not a URL', 'ftp://example.test']) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, startupUrl }),
      /startupUrl must be a valid HTTP or HTTPS URL/,
    );
  }
  for (const messageDestination of ['not a URL', 'ftp://example.test', null]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, messageDestination }),
      /messageDestination must be a valid HTTP or HTTPS URL/,
    );
  }
});

test('legacy configurations without optional fields remain valid', context => {
  const filePath = createTemporaryConfigPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.messageDestination;
  delete legacyConfiguration.puppetName;

  saveConfiguration(legacyConfiguration, filePath);
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.messageDestination, undefined);
    assert.equal(loaded.configuration.puppetName, undefined);
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

test('validation defaults the PIN restoration setting and rejects invalid values and unknown keys', () => {
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.skipPinRestoration;
  assert.equal(validateConfiguration(legacyConfiguration).skipPinRestoration, false);

  const legacyWithoutPuppetName: Record<string, unknown> = { ...validConfiguration };
  delete legacyWithoutPuppetName.puppetName;
  assert.equal(validateConfiguration(legacyWithoutPuppetName).puppetName, undefined);

  for (const skipPinRestoration of [undefined, null, 'false', 0]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, skipPinRestoration }),
      /skipPinRestoration must be a boolean/,
    );
  }
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, unexpected: true }),
    /unsupported field 'unexpected'/,
  );
});

test('puppetName allows an empty unset sentinel and rejects malformed names', () => {
  assert.equal(validateConfiguration({ ...validConfiguration, puppetName: '' }).puppetName, '');
  for (const puppetName of [null, '   ', ' Test Puppet ', `Test${String.fromCharCode(10)}Puppet`]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, puppetName }),
      /puppetName must be a trimmed string without control characters/,
    );
  }
  assert.equal(validateConfiguration(validConfiguration).puppetName, 'Test Puppet');
});

test('PIN validation requires six digits when enabled and null when skipped', () => {
  for (const pin of ['000000', '012345', '999999']) {
    assert.equal(validateConfiguration({
      ...validConfiguration,
      skipPinRestoration: false,
      pin,
    }).pin, pin);
  }
  assert.equal(validateConfiguration({
    ...validConfiguration,
    skipPinRestoration: true,
    pin: null,
  }).pin, null);

  for (const pin of [null, '', '12345', '1234567', '12a456', 123456]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, skipPinRestoration: false, pin }),
      /pin must contain exactly six digits/,
    );
  }
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, skipPinRestoration: true, pin: '123456' }),
    /pin must be null/,
  );
  const missingPin: Record<string, unknown> = { ...validConfiguration };
  delete missingPin.pin;
  assert.throws(
    () => validateConfiguration(missingPin),
    /pin is required/,
  );
  const skippedWithoutPin: Record<string, unknown> = {
    ...validConfiguration,
    skipPinRestoration: true,
  };
  delete skippedWithoutPin.pin;
  assert.equal(validateConfiguration(skippedWithoutPin).pin, null);
});

test('loading a legacy configuration defaults the PIN restoration setting and marks it for backfill', context => {
  const filePath = createTemporaryConfigPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.skipPinRestoration;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  const result = loadConfiguration(filePath);
  assert.equal(result.status, 'valid');
  if (result.status === 'valid') {
    assert.equal(result.configuration.skipPinRestoration, false);
    assert.equal(result.needsSkipPinRestorationBackfill, true);
  }
});

test('loading a legacy enabled-restoration configuration requires PIN reconfiguration', context => {
  const filePath = createTemporaryConfigPath(context);
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.pin;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  const result = loadConfiguration(filePath);
  assert.equal(result.status, 'pin-required');
  if (result.status === 'pin-required') {
    assert.equal(result.configuration.skipPinRestoration, false);
    assert.equal(result.configuration.browser, validConfiguration.browser);
    assert.equal('pin' in result.configuration, false);
  }
});

test('loading a legacy skipped-restoration config safely backfills a null PIN', context => {
  const filePath = createTemporaryConfigPath(context);
  const legacyConfiguration: Record<string, unknown> = {
    ...validConfiguration,
    skipPinRestoration: true,
  };
  delete legacyConfiguration.pin;
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));

  const result = loadConfiguration(filePath);
  assert.equal(result.status, 'valid');
  if (result.status === 'valid') {
    assert.equal(result.configuration.skipPinRestoration, true);
    assert.equal(result.configuration.pin, null);
    assert.equal(result.needsPinBackfill, true);
  }
});
test('bot temperaments map deterministically to RNG YES probabilities', () => {
  assert.deepEqual(BOT_TEMPERAMENT_YES_PROBABILITIES, {
    quiet: 0.1,
    balanced: 0.5,
    talkative: 0.95,
  });
  assert.equal(getBotTemperamentYesProbability('quiet'), 0.1);
  assert.equal(getBotTemperamentYesProbability('balanced'), 0.5);
  assert.equal(getBotTemperamentYesProbability('talkative'), 0.95);
});

test('bot temperaments map deterministically to RNG cooldowns', () => {
  assert.deepEqual(BOT_TEMPERAMENT_COOLDOWNS_MS, {
    quiet: 25_000,
    balanced: 15_000,
    talkative: 6_000,
  });
  assert.equal(getBotTemperamentCooldownMs('quiet'), 25_000);
  assert.equal(getBotTemperamentCooldownMs('balanced'), 15_000);
  assert.equal(getBotTemperamentCooldownMs('talkative'), 6_000);
});

test('missing temperament defaults to Balanced and invalid values are rejected', context => {
  const missingTemperament: Record<string, unknown> = { ...validConfiguration };
  delete missingTemperament.botTemperament;
  assert.equal(validateConfiguration(missingTemperament).botTemperament, 'balanced');

  const filePath = createTemporaryConfigPath(context);
  writeFileSync(filePath, JSON.stringify(missingTemperament));
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botTemperament, 'balanced');
    assert.equal(loaded.needsBotTemperamentBackfill, true);
  }

  for (const botTemperament of [null, 'loud', 1, false]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, botTemperament }),
      /botTemperament must be one of 'quiet', 'balanced', or 'talkative'/,
    );
  }
});

test('legacy configurations without a personality default to Default mode', context => {
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.botPersonality;

  const validated = validateConfiguration(legacyConfiguration);
  assert.equal(validated.botPersonality, 'default');
  assert.equal(resolveBotPersonalityMode(validated), 'default');

  const filePath = createTemporaryConfigPath(context);
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botPersonality, 'default');
    assert.equal(loaded.configuration.customPersonalityInstruction, undefined);
  }
});

test('personality mode validation rejects unknown modes and requires a custom instruction', () => {
  assert.equal(isBotPersonalityMode('default'), true);
  assert.equal(isBotPersonalityMode('custom'), true);
  assert.equal(isBotPersonalityMode('loud'), false);

  for (const botPersonality of [null, 'loud', 1, false]) {
    assert.throws(
      () => validateConfiguration({ ...validConfiguration, botPersonality }),
      /botPersonality must be one of 'default' or 'custom'/,
    );
  }

  assert.throws(
    () => validateConfiguration({ ...validConfiguration, botPersonality: 'custom' }),
    /customPersonalityInstruction is required when botPersonality is custom/,
  );
  assert.throws(
    () => validateConfiguration({
      ...validConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: '   ',
    }),
    /customPersonalityInstruction is required when botPersonality is custom/,
  );
});

test('a custom personality instruction persists with newlines and reloads intact', context => {
  const customPersonalityInstruction = 'Sarcastic and deadpan.\nNever cheerful.\n\nMatch the room.';
  const filePath = createTemporaryConfigPath(context);
  const saved = saveConfiguration(
    { ...validConfiguration, botPersonality: 'custom', customPersonalityInstruction },
    filePath,
  );
  assert.equal(saved.botPersonality, 'custom');
  assert.equal(saved.customPersonalityInstruction, customPersonalityInstruction);

  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.botPersonality, 'custom');
    assert.equal(loaded.configuration.customPersonalityInstruction, customPersonalityInstruction);
    assert.equal(resolveBotPersonalityMode(loaded.configuration), 'custom');
  }

  const text = readFileSync(filePath, 'utf8');
  assert.ok(text.includes('botPersonality'));
  assert.ok(text.includes('customPersonalityInstruction'));
});

test('composer slicer settings resolve from defaults and persist only when configured', context => {
  const legacyConfiguration: Record<string, unknown> = { ...validConfiguration };
  delete legacyConfiguration.composerSlicer;

  const validated = validateConfiguration(legacyConfiguration);
  assert.equal(validated.composerSlicer, undefined, 'defaults are not baked into the configuration');
  assert.deepEqual(DEFAULT_COMPOSER_SLICER, { enabled: true, maxCharacters: 100 });
  assert.deepEqual(resolveComposerSlicer(validated), { enabled: true, maxCharacters: 100 });

  const filePath = createTemporaryConfigPath(context);
  writeFileSync(filePath, JSON.stringify(legacyConfiguration));
  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status === 'valid') {
    assert.equal(loaded.configuration.composerSlicer, undefined);
    assert.deepEqual(resolveComposerSlicer(loaded.configuration), {
      enabled: true,
      maxCharacters: 100,
    });
  }

  saveConfiguration(validated, filePath);
  assert.equal(
    readFileSync(filePath, 'utf8').includes('composerSlicer'),
    false,
    'saving settings never freezes the current slicer defaults into the file',
  );

  const configured = validateConfiguration({
    ...validConfiguration,
    composerSlicer: { enabled: false, maxCharacters: 250 },
  });
  assert.deepEqual(configured.composerSlicer, { enabled: false, maxCharacters: 250 });
  assert.deepEqual(resolveComposerSlicer(configured), { enabled: false, maxCharacters: 250 });

  const maximumOnly = validateConfiguration({
    ...validConfiguration,
    composerSlicer: { maxCharacters: 10 },
  });
  assert.deepEqual(resolveComposerSlicer(maximumOnly), {
    enabled: true,
    maxCharacters: 10,
  });

  const enabledOnly = validateConfiguration({
    ...validConfiguration,
    composerSlicer: { enabled: false },
  });
  assert.deepEqual(resolveComposerSlicer(enabledOnly), {
    enabled: false,
    maxCharacters: 100,
  });

  saveConfiguration(configured, filePath);
  const reloaded = loadConfiguration(filePath);
  assert.equal(reloaded.status, 'valid');
  if (reloaded.status === 'valid') {
    assert.deepEqual(reloaded.configuration.composerSlicer, { enabled: false, maxCharacters: 250 });
    assert.deepEqual(resolveComposerSlicer(reloaded.configuration), {
      enabled: false,
      maxCharacters: 250,
    });
  }
});

test('composer slicer defaults never overwrite explicit saved values', context => {
  const filePath = createTemporaryConfigPath(context);
  const explicit = validateConfiguration({
    ...validConfiguration,
    composerSlicer: { enabled: true, maxCharacters: 750 },
  });
  saveConfiguration(explicit, filePath);

  const loaded = loadConfiguration(filePath);
  assert.equal(loaded.status, 'valid');
  if (loaded.status !== 'valid') {
    return;
  }
  assert.deepEqual(loaded.configuration.composerSlicer, { enabled: true, maxCharacters: 750 });
  assert.deepEqual(resolveComposerSlicer(loaded.configuration), {
    enabled: true,
    maxCharacters: 750,
  });

  saveConfiguration({ ...loaded.configuration, puppetName: 'Renamed Puppet' }, filePath);
  const resaved = loadConfiguration(filePath);
  assert.equal(resaved.status, 'valid');
  if (resaved.status === 'valid') {
    assert.equal(resaved.configuration.puppetName, 'Renamed Puppet');
    assert.deepEqual(resaved.configuration.composerSlicer, { enabled: true, maxCharacters: 750 });
    assert.deepEqual(resolveComposerSlicer(resaved.configuration), {
      enabled: true,
      maxCharacters: 750,
    });
  }
});

test('composer slicer settings reject invalid values and unknown fields', () => {
  for (const composerSlicer of [null, 'enabled', [], { enabled: 'yes' }, { enabled: true, unexpected: 1 }]) {
    assert.throws(() => validateConfiguration({ ...validConfiguration, composerSlicer }));
  }
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, composerSlicer: { enabled: 'yes' } }),
    /composerSlicer\.enabled must be a boolean/,
  );
  for (const maxCharacters of [0, -5, 1.5, '500', null, true]) {
    assert.throws(
      () => validateConfiguration({
        ...validConfiguration,
        composerSlicer: { enabled: true, maxCharacters },
      }),
      /composerSlicer\.maxCharacters must be a positive integer/,
    );
  }
  assert.throws(
    () => validateConfiguration({ ...validConfiguration, composerSlicer: { unexpected: true } }),
    /composerSlicer contains unsupported field 'unexpected'/,
  );
});

test('custom personality instructions reject control characters and oversized text', () => {
  assert.throws(
    () => validateConfiguration({
      ...validConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: 'bad\u0007text',
    }),
    /must not contain control characters/,
  );
  assert.throws(
    () => validateConfiguration({
      ...validConfiguration,
      botPersonality: 'custom',
      customPersonalityInstruction: 'x'.repeat(MAX_PERSONALITY_INSTRUCTION_CHARS + 1),
    }),
    /must not exceed \d+ characters/,
  );
  assert.doesNotThrow(() => validateConfiguration({
    ...validConfiguration,
    botPersonality: 'custom',
    customPersonalityInstruction: 'x'.repeat(MAX_PERSONALITY_INSTRUCTION_CHARS),
  }));
});
