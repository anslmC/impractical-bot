import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  CONFIGURATION_VERSION,
  loadConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
  type BrowserId,
  type Configuration,
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

type SelectionResult =
  | { status: 'selected'; candidate: BrowserCandidate }
  | { status: 'cancelled' };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateForConfiguration(configuration: Configuration): BrowserCandidate {
  return {
    browser: configuration.browser,
    displayName: getBrowserDisplayName(configuration.browser),
    executablePath: configuration.executablePath,
  };
}

function isExecutableAvailable(
  path: string,
  fileExists: (path: string) => boolean,
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
      if (!isExecutableAvailable(candidate.executablePath, fileExists)) {
        throw new Error('The executable does not exist or cannot be accessed.');
      }
      return { status: 'selected', candidate };
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
      writeOutput('No configuration was written. Enter a valid supported executable path or cancel.');
    }
  }
}

async function selectCandidate(
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
): Configuration {
  const profilePath = win32.join(win32.dirname(configurationFilePath), 'browser-profile');
  const browser: BrowserId = candidate.browser;
  return {
    version: CONFIGURATION_VERSION,
    browser,
    executablePath: candidate.executablePath,
    profilePath,
  };
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

  if (saved.status === 'valid') {
    const candidate = candidateForConfiguration(saved.configuration);
    if (isExecutableAvailable(candidate.executablePath, fileExists)) {
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

  const selection = await selectCandidate(
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
  if (!isExecutableAvailable(selection.candidate.executablePath, fileExists)) {
    writeError(`Selected browser executable is no longer available: ${selection.candidate.executablePath}`);
    return 'failed';
  }

  const configuration = configurationForSelection(selection.candidate, configurationFilePath);
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