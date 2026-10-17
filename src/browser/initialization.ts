import { statSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { win32 } from 'node:path';
import {
  CONFIGURATION_VERSION,
  loadConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
  type BrowserId,
  type Configuration,
  type ConfigurationWithoutPin,
  type ConfigurationLoadResult,
} from '../config/configuration.js';
import {
  discoverBrowsers,
  getBrowserDisplayName,
  validateBrowserExecutablePath,
  type BrowserCandidate,
  type BrowserDiscoveryOptions,
} from './discovery.js';

export type InitializationStatus = 'saved' | 'preserved' | 'cancelled' | 'failed';
export type TerminalPrompt = (question: string) => Promise<string | null>;

export interface InitializationOptions extends BrowserDiscoveryOptions {
  configurationFilePath?: string;
  prompt: TerminalPrompt;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

export type SelectionResult =
  | { status: 'selected'; candidate: BrowserCandidate }
  | { status: 'cancelled' };

export interface PinRestorationSettings {
  skipPinRestoration: boolean;
  pin: string | null;
}

export async function promptSkipPinRestoration(
  prompt: TerminalPrompt,
  writeError: (message: string) => void,
): Promise<boolean | null> {
  while (true) {
    const answer = await prompt('Skip Messenger PIN restoration on startup? [y/N]: ');
    if (answer === null) {
      return null;
    }

    const normalizedAnswer = answer.trim().toLowerCase();
    if (normalizedAnswer === 'y' || normalizedAnswer === 'yes') {
      return true;
    }
    if (normalizedAnswer === '' || normalizedAnswer === 'n' || normalizedAnswer === 'no') {
      return false;
    }
    writeError('Enter y to skip PIN restoration, or n to restore chats with the PIN.');
  }
}

export async function promptPinRestorationSettings(
  prompt: TerminalPrompt,
  writeError: (message: string) => void,
): Promise<PinRestorationSettings | null> {
  const skipPinRestoration = await promptSkipPinRestoration(prompt, writeError);
  if (skipPinRestoration === null) {
    return null;
  }
  if (skipPinRestoration) {
    return { skipPinRestoration: true, pin: null };
  }

  while (true) {
    const pin = await prompt('Enter the six-digit Messenger restoration PIN: ');
    if (pin === null) {
      return null;
    }
    if (/^[0-9]{6}$/.test(pin)) {
      return { skipPinRestoration: false, pin };
    }
    writeError('PIN must contain exactly six digits. The PIN was not saved.');
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateForConfiguration(configuration: ConfigurationWithoutPin): BrowserCandidate {
  return {
    browser: configuration.browser,
    displayName: getBrowserDisplayName(configuration.browser),
    executablePath: configuration.executablePath,
  };
}

export function isBrowserExecutableAvailable(
  path: string,
  fileExists: (path: string) => boolean = isFile,
): boolean {
  try {
    return fileExists(path);
  } catch {
    return false;
  }
}

async function selectManualExecutable(
  prompt: TerminalPrompt,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
  fileExists: (path: string) => boolean,
): Promise<SelectionResult> {
  while (true) {
    const answer = await prompt('Enter executable path, or press Enter to cancel: ');
    if (answer === null || answer.length === 0) {
      return { status: 'cancelled' };
    }

    try {
      const candidate = validateBrowserExecutablePath(answer);
      if (!isBrowserExecutableAvailable(candidate.executablePath, fileExists)) {
        throw new Error('The executable does not exist or cannot be accessed.');
      }
      return { status: 'selected', candidate };
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
      writeOutput('No configuration was written. Enter a valid supported executable path or cancel.');
    }
  }
}

export async function selectBrowserCandidate(
  candidates: BrowserCandidate[],
  prompt: TerminalPrompt,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
  fileExists: (path: string) => boolean,
): Promise<SelectionResult> {
  if (candidates.length === 0) {
    writeOutput('No supported browser executables were found.');
    return selectManualExecutable(prompt, writeOutput, writeError, fileExists);
  }

  if (candidates.length === 1) {
    const [candidate] = candidates;
    writeOutput(`Found ${candidate.displayName}: ${candidate.executablePath}`);
    while (true) {
      const answer = await prompt('Select this browser? [y=yes, m=manual path, n=cancel]: ');
      if (answer === null || ['n', 'no', ''].includes(answer.trim().toLowerCase())) {
        return { status: 'cancelled' };
      }
      if (['y', 'yes'].includes(answer.trim().toLowerCase())) {
        return { status: 'selected', candidate };
      }
      if (answer.trim().toLowerCase() === 'm') {
        return selectManualExecutable(prompt, writeOutput, writeError, fileExists);
      }
      writeError('Enter y to select this browser, m for a manual path, or n to cancel.');
    }
  }

  writeOutput('Available browsers:');
  candidates.forEach((candidate, index) => {
    writeOutput(`  ${index + 1}) ${candidate.displayName} - ${candidate.executablePath}`);
  });
  writeOutput(`  ${candidates.length + 1}) Enter executable path manually`);
  writeOutput('  0) Cancel');

  while (true) {
    const answer = await prompt('Select a browser: ');
    if (answer === null || answer.trim() === '0' || answer.trim().toLowerCase() === 'q') {
      return { status: 'cancelled' };
    }
    const selection = Number(answer.trim());
    if (Number.isInteger(selection) && selection >= 1 && selection <= candidates.length) {
      return { status: 'selected', candidate: candidates[selection - 1] };
    }
    if (selection === candidates.length + 1) {
      return selectManualExecutable(prompt, writeOutput, writeError, fileExists);
    }
    writeError('Choose a listed browser, the manual-path option, or 0 to cancel.');
  }
}

function configurationForSelection(
  candidate: BrowserCandidate,
  configurationFilePath: string,
  pinSettings: PinRestorationSettings,
  existingConfiguration?: ConfigurationWithoutPin,
): Configuration {
  const profilePath = getBrowserProfilePath(candidate.browser, configurationFilePath);
  const browser: BrowserId = candidate.browser;
  return {
    ...existingConfiguration,
    version: CONFIGURATION_VERSION,
    browser,
    executablePath: candidate.executablePath,
    profilePath,
    ...pinSettings,
    cdpPort: existingConfiguration?.cdpPort ?? randomInt(20_000, 60_000),
    startupUrl: existingConfiguration?.startupUrl ?? 'https://www.facebook.com',
  };
}

export function getBrowserProfilePath(browser: BrowserId, configurationFilePath: string): string {
  const profileName = browser === 'edge' ? 'msedge-profile' : `${browser}-profile`;
  return win32.join(win32.dirname(configurationFilePath), profileName);
}

export async function initializeConfiguration(
  options: InitializationOptions,
): Promise<InitializationStatus> {
  const writeOutput = options.writeOutput ?? (message => console.log(message));
  const writeError = options.writeError ?? (message => console.error(message));
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? isFile;

  let configurationFilePath: string;
  try {
    configurationFilePath = options.configurationFilePath ??
      resolveConfigurationPaths(environment, platform).filePath;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 'failed';
  }

  let saved: ConfigurationLoadResult;
  try {
    saved = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
  if (saved.status === 'malformed') {
    writeError(`Configuration is malformed: ${saved.message}`);
    return 'failed';
  }
  if (saved.status === 'unsupported-version') {
    writeError(`Configuration schema version ${saved.version} is not supported.`);
    return 'failed';
  }
  const existingConfiguration = saved.status === 'valid' || saved.status === 'pin-required'
    ? saved.configuration
    : undefined;
  if (saved.status === 'valid') {
    const candidate = candidateForConfiguration(saved.configuration);
    if (isBrowserExecutableAvailable(candidate.executablePath, fileExists)) {
      if (
        saved.needsSkipPinRestorationBackfill === true ||
        saved.needsPinBackfill === true ||
        saved.configuration.cdpPort === undefined ||
        saved.configuration.startupUrl === undefined
      ) {
        saveConfiguration({
          ...saved.configuration,
          skipPinRestoration: saved.configuration.skipPinRestoration ?? false,
          pin: saved.configuration.pin ?? null,
          cdpPort: saved.configuration.cdpPort ?? randomInt(20_000, 60_000),
          startupUrl: saved.configuration.startupUrl ?? 'https://www.facebook.com',
        }, configurationFilePath);
        writeOutput('Existing configuration updated with missing default values.');
        return 'saved';
      }
      writeOutput(
        `Existing browser selection preserved: ${candidate.displayName} (${candidate.executablePath}).`,
      );
      return 'preserved';
    }

    writeError(
      `Saved ${candidate.displayName} executable is missing: ${candidate.executablePath}`,
    );
    const answer = await options.prompt('Rediscover available browsers? [y/N]: ');
    if (answer === null || !['y', 'yes'].includes(answer.trim().toLowerCase())) {
      writeOutput('Initialization cancelled. Existing configuration was not changed.');
      return 'cancelled';
    }
  }
  if (saved.status === 'pin-required') {
    const candidate = candidateForConfiguration(saved.configuration);
    if (isBrowserExecutableAvailable(candidate.executablePath, fileExists)) {
      const pinSettings = await promptPinRestorationSettings(options.prompt, writeError);
      if (pinSettings === null) {
        writeOutput('Initialization cancelled. No configuration was written.');
        return 'cancelled';
      }
      try {
        saveConfiguration({
          ...saved.configuration,
          ...pinSettings,
          cdpPort: saved.configuration.cdpPort ?? randomInt(20_000, 60_000),
          startupUrl: saved.configuration.startupUrl ?? 'https://www.facebook.com',
        }, configurationFilePath);
      } catch (error) {
        writeError(`Unable to save configuration: ${error instanceof Error ? error.message : String(error)}`);
        return 'failed';
      }
      writeOutput('Existing browser configuration updated with PIN-restoration settings.');
      return 'saved';
    }

    writeError(
      `Saved ${candidate.displayName} executable is missing: ${candidate.executablePath}`,
    );
    const answer = await options.prompt('Rediscover available browsers? [y/N]: ');
    if (answer === null || !['y', 'yes'].includes(answer.trim().toLowerCase())) {
      writeOutput('Initialization cancelled. Existing configuration was not changed.');
      return 'cancelled';
    }
  }

  let candidates: BrowserCandidate[];
  try {
    candidates = await discoverBrowsers({
      platform,
      environment,
      fileExists,
      registryLookup: options.registryLookup,
      pathLookup: options.pathLookup,
    });
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 'failed';
  }

  const selection = await selectBrowserCandidate(
    candidates,
    options.prompt,
    writeOutput,
    writeError,
    fileExists,
  );
  if (selection.status === 'cancelled') {
    writeOutput('Initialization cancelled. No configuration was written.');
    return 'cancelled';
  }
  if (!isBrowserExecutableAvailable(selection.candidate.executablePath, fileExists)) {
    writeError(`Selected browser executable is no longer available: ${selection.candidate.executablePath}`);
    return 'failed';
  }

  const pinSettings = saved.status === 'valid'
    ? {
      skipPinRestoration: saved.configuration.skipPinRestoration,
      pin: saved.configuration.pin,
    }
    : await promptPinRestorationSettings(options.prompt, writeError);
  if (pinSettings === null) {
    writeOutput('Initialization cancelled. No configuration was written.');
    return 'cancelled';
  }

  const configuration = configurationForSelection(
    selection.candidate,
    configurationFilePath,
    pinSettings,
    existingConfiguration,
  );
  try {
    saveConfiguration(configuration, configurationFilePath);
  } catch (error) {
    writeError(`Unable to save configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }

  writeOutput(
    `Browser selection saved: ${selection.candidate.displayName} (${selection.candidate.executablePath}).`,
  );
  writeOutput('The dedicated profile path is recorded but has not been created or launched.');
  return 'saved';
}