import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { writeFileAtomically } from './atomic-write.js';
import {
  BROWSER_IDS,
  browserForExecutableName,
  isFullyQualifiedWindowsPath,
  type BrowserId,
} from '../browser/browser-definitions.js';

export { BROWSER_IDS };
export type { BrowserId };

export const CONFIGURATION_VERSION = 1;
export const BOT_TEMPERAMENTS = ['quiet', 'balanced', 'talkative'] as const;
export const DEFAULT_BOT_TEMPERAMENT = 'balanced' as const;

export const BOT_PERSONALITY_MODES = ['default', 'custom'] as const;
export const DEFAULT_BOT_PERSONALITY_MODE = 'default' as const;

export const MAX_PERSONALITY_INSTRUCTION_CHARS = 4000;

export const DEFAULT_COMPOSER_SLICER_MAX_CHARACTERS = 100;

export interface ComposerSlicerSettings {
  enabled: boolean;
  maxCharacters: number;
}

export type ComposerSlicerOverrides = Partial<ComposerSlicerSettings>;

export const DEFAULT_COMPOSER_SLICER: ComposerSlicerSettings = {
  enabled: true,
  maxCharacters: DEFAULT_COMPOSER_SLICER_MAX_CHARACTERS,
};

export type BotTemperament = typeof BOT_TEMPERAMENTS[number];
export type BotPersonalityMode = typeof BOT_PERSONALITY_MODES[number];

export const BOT_TEMPERAMENT_YES_PROBABILITIES: Readonly<Record<BotTemperament, number>> = {
  quiet: 0.1,
  balanced: 0.5,
  talkative: 0.95,
};

export const BOT_TEMPERAMENT_COOLDOWNS_MS: Readonly<Record<BotTemperament, number>> = {
  quiet: 25000,
  balanced: 15000,
  talkative: 6000,
};

export interface Configuration {
  version: typeof CONFIGURATION_VERSION;
  browser: BrowserId;
  executablePath: string;
  profilePath: string;
  skipPinRestoration: boolean;
  pin: string | null;
  cdpPort?: number;
  startupUrl?: string;
  messageDestination?: string;
  puppetName?: string;
  botTemperament?: BotTemperament;
  botPersonality?: BotPersonalityMode;
  customPersonalityInstruction?: string;
  composerSlicer?: ComposerSlicerOverrides;
}

export function isBotTemperament(value: unknown): value is BotTemperament {
  return typeof value === 'string' && (BOT_TEMPERAMENTS as readonly string[]).includes(value);
}

export function resolveBotTemperament(
  configuration: Pick<Configuration, 'botTemperament'>,
): BotTemperament {
  return configuration.botTemperament ?? DEFAULT_BOT_TEMPERAMENT;
}

export function getBotTemperamentYesProbability(temperament: BotTemperament): number {
  return BOT_TEMPERAMENT_YES_PROBABILITIES[temperament];
}

export function getBotTemperamentCooldownMs(temperament: BotTemperament): number {
  return BOT_TEMPERAMENT_COOLDOWNS_MS[temperament];
}

export function isBotPersonalityMode(value: unknown): value is BotPersonalityMode {
  return typeof value === 'string' && (BOT_PERSONALITY_MODES as readonly string[]).includes(value);
}

export function resolveBotPersonalityMode(
  configuration: Pick<Configuration, 'botPersonality'>,
): BotPersonalityMode {
  return configuration.botPersonality ?? DEFAULT_BOT_PERSONALITY_MODE;
}

export function resolveComposerSlicer(
  configuration: Pick<Configuration, 'composerSlicer'>,
): ComposerSlicerSettings {
  return {
    enabled: configuration.composerSlicer?.enabled ?? DEFAULT_COMPOSER_SLICER.enabled,
    maxCharacters:
      configuration.composerSlicer?.maxCharacters ?? DEFAULT_COMPOSER_SLICER.maxCharacters,
  };
}

export type ConfigurationWithoutPin = Omit<Configuration, 'pin'>;

export interface ConfigurationPaths {
  directory: string;
  filePath: string;
}

export type ConfigurationLoadResult =
  | { status: 'missing' }
  | {
    status: 'valid';
    configuration: Configuration;
    needsSkipPinRestorationBackfill?: true;
    needsPinBackfill?: true;
    needsBotTemperamentBackfill?: true;
  }
  | { status: 'pin-required'; configuration: ConfigurationWithoutPin; needsBotTemperamentBackfill?: true }
  | { status: 'malformed'; message: string }
  | { status: 'unsupported-version'; version: number };

const CONFIGURATION_DIRECTORY_NAME = 'Impractical Bot';
const CONFIGURATION_FILE_NAME = 'config.json';
const CONFIGURATION_KEYS = new Set([
  'version',
  'browser',
  'executablePath',
  'profilePath',
  'skipPinRestoration',
  'pin',
  'cdpPort',
  'startupUrl',
  'messageDestination',
  'puppetName',
  'botTemperament',
  'botPersonality',
  'customPersonalityInstruction',
  'composerSlicer',
]);
const COMPOSER_SLICER_KEYS = new Set(['enabled', 'maxCharacters']);

export function resolveConfigurationPaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ConfigurationPaths {
  if (platform !== 'win32') {
    throw new Error(`Configuration storage is not supported on '${platform}'.`);
  }

  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !isFullyQualifiedWindowsPath(localAppData) || localAppData.includes('\0')) {
    throw new Error('LOCALAPPDATA must contain an absolute Windows path.');
  }

  const directory = win32.join(localAppData, CONFIGURATION_DIRECTORY_NAME);
  return {
    directory,
    filePath: win32.join(directory, CONFIGURATION_FILE_NAME),
  };
}

function requireWindowsAbsolutePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    !isFullyQualifiedWindowsPath(value)
  ) {
    throw new Error(`${field} must be an absolute Windows path.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function validateComposerSlicer(value: unknown): ComposerSlicerOverrides {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('composerSlicer must be a JSON object.');
  }
  const unknownKeys = Object.keys(value).filter(key => !COMPOSER_SLICER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`composerSlicer contains unsupported field '${unknownKeys[0]}'.`);
  }
  const overrides: ComposerSlicerOverrides = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error('composerSlicer.enabled must be a boolean.');
    }
    overrides.enabled = value.enabled;
  }
  if (value.maxCharacters !== undefined) {
    const maxCharacters = value.maxCharacters;
    if (
      typeof maxCharacters !== 'number' ||
      !Number.isInteger(maxCharacters) ||
      maxCharacters < 1
    ) {
      throw new Error('composerSlicer.maxCharacters must be a positive integer.');
    }
    overrides.maxCharacters = maxCharacters;
  }
  return overrides;
}

function validateConfigurationFields(value: unknown): ConfigurationWithoutPin {
  if (!isRecord(value)) {
    throw new Error('Configuration must be a JSON object.');
  }

  const unknownKeys = Object.keys(value).filter(key => !CONFIGURATION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Configuration contains unsupported field '${unknownKeys[0]}'.`);
  }

  if (value.version !== CONFIGURATION_VERSION) {
    throw new Error(`Configuration version must be ${CONFIGURATION_VERSION}.`);
  }
  if (!BROWSER_IDS.includes(value.browser as BrowserId)) {
    throw new Error("Browser must be one of 'brave', 'chrome', or 'edge'.");
  }

  const executablePath = requireWindowsAbsolutePath(value.executablePath, 'executablePath');
  if (win32.extname(executablePath).toLowerCase() !== '.exe') {
    throw new Error('executablePath must point to a Windows .exe file.');
  }
  if (browserForExecutableName(win32.basename(executablePath)) !== (value.browser as BrowserId)) {
    throw new Error('executablePath must match the selected browser.');
  }
  const profilePath = requireWindowsAbsolutePath(value.profilePath, 'profilePath');

  const hasSkipPinRestoration = Object.prototype.hasOwnProperty.call(value, 'skipPinRestoration');
  if (hasSkipPinRestoration && typeof value.skipPinRestoration !== 'boolean') {
    throw new Error('skipPinRestoration must be a boolean.');
  }
  if (
    value.cdpPort !== undefined &&
    (
      typeof value.cdpPort !== 'number' ||
      !Number.isInteger(value.cdpPort) ||
      value.cdpPort < 1 ||
      value.cdpPort > 65535
    )
  ) {
    throw new Error('cdpPort must be an integer between 1 and 65535.');
  }
  if (
    value.startupUrl !== undefined &&
    (typeof value.startupUrl !== 'string' || !isHttpOrHttpsUrl(value.startupUrl))
  ) {
    throw new Error('startupUrl must be a valid HTTP or HTTPS URL.');
  }
  if (
    value.messageDestination !== undefined &&
    (typeof value.messageDestination !== 'string' || !isHttpOrHttpsUrl(value.messageDestination))
  ) {
    throw new Error('messageDestination must be a valid HTTP or HTTPS URL.');
  }
  if (
    value.puppetName !== undefined &&
    (
      typeof value.puppetName !== 'string' ||
      (value.puppetName.length > 0 && value.puppetName !== value.puppetName.trim()) ||
      /[\u0000-\u001f\u007f]/.test(value.puppetName)
    )
  ) {
    throw new Error('puppetName must be a trimmed string without control characters.');
  }
  if (value.botTemperament !== undefined && !isBotTemperament(value.botTemperament)) {
    throw new Error("botTemperament must be one of 'quiet', 'balanced', or 'talkative'.");
  }
  if (value.botPersonality !== undefined && !isBotPersonalityMode(value.botPersonality)) {
    throw new Error("botPersonality must be one of 'default' or 'custom'.");
  }
  if (value.customPersonalityInstruction !== undefined) {
    if (typeof value.customPersonalityInstruction !== 'string') {
      throw new Error('customPersonalityInstruction must be a string.');
    }
    if (value.customPersonalityInstruction.length === 0) {
      throw new Error('customPersonalityInstruction must not be empty.');
    }
    if (/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/.test(value.customPersonalityInstruction)) {
      throw new Error(
        'customPersonalityInstruction must not contain control characters other than newlines and tabs.',
      );
    }
    if (value.customPersonalityInstruction.length > MAX_PERSONALITY_INSTRUCTION_CHARS) {
      throw new Error(
        `customPersonalityInstruction must not exceed ${MAX_PERSONALITY_INSTRUCTION_CHARS} characters.`,
      );
    }
  }
  if (
    value.botPersonality === 'custom' &&
    (!value.customPersonalityInstruction ||
      value.customPersonalityInstruction.trim().length === 0)
  ) {
    throw new Error('customPersonalityInstruction is required when botPersonality is custom.');
  }

  return {
    version: CONFIGURATION_VERSION,
    browser: value.browser as BrowserId,
    executablePath,
    profilePath,
    skipPinRestoration: hasSkipPinRestoration ? value.skipPinRestoration as boolean : false,
    ...(value.cdpPort === undefined ? {} : { cdpPort: value.cdpPort as number }),
    ...(value.startupUrl === undefined ? {} : { startupUrl: value.startupUrl as string }),
    ...(value.messageDestination === undefined
      ? {}
      : { messageDestination: value.messageDestination as string }),
    ...(value.puppetName === undefined ? {} : { puppetName: value.puppetName as string }),
    botTemperament: isBotTemperament(value.botTemperament)
      ? value.botTemperament
      : DEFAULT_BOT_TEMPERAMENT,
    botPersonality: isBotPersonalityMode(value.botPersonality)
      ? value.botPersonality
      : DEFAULT_BOT_PERSONALITY_MODE,
    ...(value.customPersonalityInstruction === undefined
      ? {}
      : { customPersonalityInstruction: value.customPersonalityInstruction }),
    ...(value.composerSlicer === undefined
      ? {}
      : { composerSlicer: validateComposerSlicer(value.composerSlicer) }),
  };
}

export function validateConfiguration(value: unknown): Configuration {
  const configuration = validateConfigurationFields(value);
  if (!isRecord(value)) {
    throw new Error('Configuration must be a JSON object.');
  }
  const hasPin = Object.prototype.hasOwnProperty.call(value, 'pin');
  if (!hasPin && !configuration.skipPinRestoration) {
    throw new Error('pin is required when Messenger PIN restoration is enabled.');
  }

  const pin = hasPin ? value.pin : null;
  if (configuration.skipPinRestoration) {
    if (pin !== null) {
      throw new Error('pin must be null when Messenger PIN restoration is skipped.');
    }
  } else if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) {
    throw new Error('pin must contain exactly six digits when Messenger PIN restoration is enabled.');
  }

  return { ...configuration, pin: pin as string | null };
}

function getFilePath(filePath?: string): string {
  const selectedPath = filePath ?? resolveConfigurationPaths().filePath;
  if (!isFullyQualifiedWindowsPath(selectedPath) || selectedPath.includes('\0')) {
    throw new Error('Configuration file path must be an absolute Windows path.');
  }
  return selectedPath;
}

export function loadConfiguration(filePath?: string): ConfigurationLoadResult {
  const selectedPath = getFilePath(filePath);
  let source: string;

  try {
    source = readFileSync(selectedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return { status: 'malformed', message: 'Configuration file is not valid JSON.' };
  }

  if (!isRecord(parsed)) {
    return { status: 'malformed', message: 'Configuration must be a JSON object.' };
  }
  if (!Number.isInteger(parsed.version)) {
    return { status: 'malformed', message: 'Configuration version must be an integer.' };
  }
  if (parsed.version !== CONFIGURATION_VERSION) {
    return { status: 'unsupported-version', version: parsed.version as number };
  }

  const hasPin = Object.prototype.hasOwnProperty.call(parsed, 'pin');
  if (!hasPin && parsed.skipPinRestoration !== true) {
    try {
      return {
        status: 'pin-required',
        configuration: validateConfigurationFields(parsed),
        ...(!Object.prototype.hasOwnProperty.call(parsed, 'botTemperament')
          ? { needsBotTemperamentBackfill: true as const }
          : {}),
      };
    } catch (error) {
      return {
        status: 'malformed',
        message: error instanceof Error ? error.message : 'Configuration values are invalid.',
      };
    }
  }

  try {
    const configuration = validateConfiguration(
      !hasPin ? { ...parsed, pin: null } : parsed,
    );
    return {
      status: 'valid',
      configuration,
      ...(!Object.prototype.hasOwnProperty.call(parsed, 'skipPinRestoration')
        ? { needsSkipPinRestorationBackfill: true as const }
        : {}),
      ...(!hasPin ? { needsPinBackfill: true as const } : {}),
      ...(!Object.prototype.hasOwnProperty.call(parsed, 'botTemperament')
        ? { needsBotTemperamentBackfill: true as const }
        : {}),
    };
  } catch (error) {
    return {
      status: 'malformed',
      message: error instanceof Error ? error.message : 'Configuration values are invalid.',
    };
  }
}

export function saveConfiguration(value: unknown, filePath?: string): Configuration {
  const configuration = validateConfiguration(value);
  const selectedPath = getFilePath(filePath);
  const existing = loadConfiguration(selectedPath);

  if (existing.status === 'malformed') {
    throw new Error(`Refusing to overwrite malformed configuration: ${existing.message}`);
  }
  if (existing.status === 'unsupported-version') {
    throw new Error(
      `Refusing to overwrite configuration with unsupported version ${existing.version}.`,
    );
  }

  writeFileAtomically(selectedPath, `${JSON.stringify(configuration, null, 2)}\n`);

  return configuration;
}