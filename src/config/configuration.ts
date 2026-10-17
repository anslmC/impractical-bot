import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONFIGURATION_VERSION = 1;
export const BROWSER_IDS = ['brave', 'chrome', 'edge'] as const;

export type BrowserId = typeof BROWSER_IDS[number];

export interface Configuration {
  version: typeof CONFIGURATION_VERSION;
  browser: BrowserId;
  executablePath: string;
  profilePath: string;
  cdpPort?: number;
}

export interface ConfigurationPaths {
  directory: string;
  filePath: string;
}

export type ConfigurationLoadResult =
  | { status: 'missing' }
  | { status: 'valid'; configuration: Configuration }
  | { status: 'malformed'; message: string }
  | { status: 'unsupported-version'; version: number };

const CONFIGURATION_DIRECTORY_NAME = 'Impractical Bot';
const CONFIGURATION_FILE_NAME = 'config.json';
const CONFIGURATION_KEYS = new Set([
  'version',
  'browser',
  'executablePath',
  'profilePath',
  'cdpPort',
]);
const BROWSER_EXECUTABLE_NAMES: Record<BrowserId, string> = {
  brave: 'brave.exe',
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
};

function isFullyQualifiedWindowsPath(value: string): boolean {
  return win32.isAbsolute(value) && win32.parse(value).root !== '\\';
}

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

export function validateConfiguration(value: unknown): Configuration {
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
  if (win32.basename(executablePath).toLowerCase() !== BROWSER_EXECUTABLE_NAMES[value.browser as BrowserId]) {
    throw new Error('executablePath must match the selected browser.');
  }
  const profilePath = requireWindowsAbsolutePath(value.profilePath, 'profilePath');

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

  return {
    version: CONFIGURATION_VERSION,
    browser: value.browser as BrowserId,
    executablePath,
    profilePath,
    ...(value.cdpPort === undefined ? {} : { cdpPort: value.cdpPort as number }),
  };
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

  try {
    return { status: 'valid', configuration: validateConfiguration(parsed) };
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

  const directory = dirname(selectedPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(selectedPath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, selectedPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    try {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }

  return configuration;
}