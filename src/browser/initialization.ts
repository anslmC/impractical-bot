import { statSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { win32 } from 'node:path';
import {
  BOT_TEMPERAMENTS,
  BOT_PERSONALITY_MODES,
  CONFIGURATION_VERSION,
  DEFAULT_BOT_TEMPERAMENT,
  DEFAULT_BOT_PERSONALITY_MODE,
  getBotTemperamentYesProbability,
  loadConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
  type BotTemperament,
  type BotPersonalityMode,
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

export async function promptBotTemperament(
  prompt: TerminalPrompt,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
  currentTemperament: BotTemperament = DEFAULT_BOT_TEMPERAMENT,
): Promise<BotTemperament | null> {
  const labels: Record<BotTemperament, string> = {
    quiet: 'Quiet',
    balanced: 'Balanced',
    talkative: 'Talkative',
  };
  writeOutput('Bot temperament:');
  for (const temperament of BOT_TEMPERAMENTS) {
    const yesProbability = Math.round(getBotTemperamentYesProbability(temperament) * 100);
    writeOutput(
      `  ${temperament === currentTemperament ? '*' : ' '} ${labels[temperament]}: ` +
      `${yesProbability}% yes / ${100 - yesProbability}% no`,
    );
  }

  while (true) {
    const answer = await prompt(
      `Select bot temperament [quiet, balanced, talkative] (default: ${labels[currentTemperament]}): `,
    );
    if (answer === null) {
      return null;
    }

    const normalized = answer.trim().toLowerCase();
    if (normalized === '') {
      return currentTemperament;
    }
    if (normalized === '1' || normalized === 'q' || normalized === 'quiet') {
      return 'quiet';
    }
    if (normalized === '2' || normalized === 'b' || normalized === 'balanced') {
      return 'balanced';
    }
    if (normalized === '3' || normalized === 't' || normalized === 'talkative') {
      return 'talkative';
    }
    writeError('Choose Quiet, Balanced, or Talkative. The bot temperament was not changed.');
  }
}

export type PersonalitySelection =
  | { mode: 'default' }
  | { mode: 'custom'; instruction: string };

export async function promptMultilinePersonality(
  prompt: TerminalPrompt,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
): Promise<string | null> {
  writeOutput(
    'Enter your custom personality instructions. Finish by entering a line that contains only a period (.) and pressing Enter.',
  );
  const lines: string[] = [];
  while (true) {
    const answer = await prompt(lines.length === 0 ? '> ' : '  ... ');
    if (answer === null) {
      return null;
    }
    if (answer.trim() === '.') {
      break;
    }
    lines.push(answer);
  }
  const instruction = lines.join('\n').trim();
  if (instruction.length === 0) {
    writeError('Custom personality instructions must not be empty.');
    return null;
  }
  return instruction;
}

export async function promptBotPersonality(
  prompt: TerminalPrompt,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
  currentMode: BotPersonalityMode = DEFAULT_BOT_PERSONALITY_MODE,
  currentInstruction?: string,
): Promise<PersonalitySelection | null> {
  const labels: Record<BotPersonalityMode, string> = {
    default: 'Default',
    custom: 'Custom',
  };
  writeOutput('Bot personality:');
  for (const mode of BOT_PERSONALITY_MODES) {
    writeOutput(
      `  ${mode === currentMode ? '*' : ' '} ${labels[mode]}: ` +
        (mode === 'default'
          ? 'Existing personality behavior'
          : 'Your own custom instruction block'),
    );
  }

  while (true) {
    const answer = await prompt(
      `Select personality [default, custom] (default: ${labels[currentMode]}): `,
    );
    if (answer === null) {
      return null;
    }

    const normalized = answer.trim().toLowerCase();
    if (normalized === '') {
      if (currentMode === 'custom' && currentInstruction !== undefined) {
        return { mode: 'custom', instruction: currentInstruction };
      }
      return { mode: 'default' };
    }
    if (normalized === 'default') {
      return { mode: 'default' };
    }
    if (normalized === 'custom') {
      const instruction = await promptMultilinePersonality(prompt, writeOutput, writeError);
      if (instruction === null) {
        return null;
      }
      return { mode: 'custom', instruction };
    }
    writeError('Choose Default or Custom. The personality was not changed.');
  }
}

async function promptMessageDestination(
  prompt: TerminalPrompt,
  writeError: (message: string) => void,
): Promise<string | null> {
  while (true) {
    const answer = await prompt('Enter the message destination URL: ');
    if (answer === null) {
      return null;
    }

    const messageDestination = answer.trim();
    try {
      if (['http:', 'https:'].includes(new URL(messageDestination).protocol)) {
        return messageDestination;
      }
    } catch {
      writeError('Message destination must be a valid HTTP or HTTPS URL.');
      continue;
    }
    writeError('Message destination must be a valid HTTP or HTTPS URL.');
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
  messageDestination: string,
  pinSettings: PinRestorationSettings,
  botTemperament: BotTemperament,
  existingConfiguration?: ConfigurationWithoutPin,
  botPersonality?: BotPersonalityMode,
  customPersonalityInstruction?: string,
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
    messageDestination,
    botTemperament,
    ...(botPersonality === undefined ? {} : { botPersonality }),
    ...(customPersonalityInstruction === undefined
      ? {}
      : { customPersonalityInstruction }),
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
      let messageDestination = saved.configuration.messageDestination;
      if (messageDestination === undefined) {
        messageDestination = await promptMessageDestination(options.prompt, writeError) ?? undefined;
        if (messageDestination === undefined) {
          writeOutput('Initialization cancelled. Existing configuration was not changed.');
          return 'cancelled';
        }
      }
      let botTemperament = saved.configuration.botTemperament ?? DEFAULT_BOT_TEMPERAMENT;
      if (saved.needsBotTemperamentBackfill === true) {
        const selectedTemperament = await promptBotTemperament(
          options.prompt,
          writeOutput,
          writeError,
          DEFAULT_BOT_TEMPERAMENT,
        );
        if (selectedTemperament === null) {
          writeOutput('Initialization cancelled. Existing configuration was not changed.');
          return 'cancelled';
        }
        botTemperament = selectedTemperament;
      }
      if (
        saved.needsSkipPinRestorationBackfill === true ||
        saved.needsPinBackfill === true ||
        saved.needsBotTemperamentBackfill === true ||
        saved.configuration.cdpPort === undefined ||
        saved.configuration.startupUrl === undefined ||
        saved.configuration.messageDestination === undefined
      ) {
        saveConfiguration({
          ...saved.configuration,
          skipPinRestoration: saved.configuration.skipPinRestoration ?? false,
          pin: saved.configuration.pin ?? null,
          cdpPort: saved.configuration.cdpPort ?? randomInt(20_000, 60_000),
          startupUrl: saved.configuration.startupUrl ?? 'https://www.facebook.com',
          messageDestination,
          botTemperament,
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
      const messageDestination = saved.configuration.messageDestination ??
        await promptMessageDestination(options.prompt, writeError);
      if (messageDestination === null) {
        writeOutput('Initialization cancelled. No configuration was written.');
        return 'cancelled';
      }
      const pinSettings = await promptPinRestorationSettings(options.prompt, writeError);
      if (pinSettings === null) {
        writeOutput('Initialization cancelled. No configuration was written.');
        return 'cancelled';
      }
      let botTemperament = saved.configuration.botTemperament ?? DEFAULT_BOT_TEMPERAMENT;
      if (saved.needsBotTemperamentBackfill === true) {
        const selectedTemperament = await promptBotTemperament(
          options.prompt,
          writeOutput,
          writeError,
          DEFAULT_BOT_TEMPERAMENT,
        );
        if (selectedTemperament === null) {
          writeOutput('Initialization cancelled. No configuration was written.');
          return 'cancelled';
        }
        botTemperament = selectedTemperament;
      }
      try {
        saveConfiguration({
          ...saved.configuration,
          messageDestination,
          ...pinSettings,
          cdpPort: saved.configuration.cdpPort ?? randomInt(20_000, 60_000),
          startupUrl: saved.configuration.startupUrl ?? 'https://www.facebook.com',
          botTemperament,
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

  const messageDestination = existingConfiguration?.messageDestination ??
    await promptMessageDestination(options.prompt, writeError);
  if (messageDestination === null) {
    writeOutput('Initialization cancelled. No configuration was written.');
    return 'cancelled';
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

  let botTemperament = existingConfiguration?.botTemperament ?? DEFAULT_BOT_TEMPERAMENT;
  if (
    existingConfiguration === undefined ||
    (saved.status === 'valid' && saved.needsBotTemperamentBackfill === true)
  ) {
    const selectedTemperament = await promptBotTemperament(
      options.prompt,
      writeOutput,
      writeError,
      DEFAULT_BOT_TEMPERAMENT,
    );
    if (selectedTemperament === null) {
      writeOutput('Initialization cancelled. No configuration was written.');
      return 'cancelled';
    }
    botTemperament = selectedTemperament;
  }

  let botPersonality = existingConfiguration?.botPersonality ?? DEFAULT_BOT_PERSONALITY_MODE;
  let customPersonalityInstruction = existingConfiguration?.customPersonalityInstruction;
  if (existingConfiguration === undefined) {
    const selection = await promptBotPersonality(
      options.prompt,
      writeOutput,
      writeError,
      DEFAULT_BOT_PERSONALITY_MODE,
    );
    if (selection === null) {
      writeOutput('Initialization cancelled. No configuration was written.');
      return 'cancelled';
    }
    botPersonality = selection.mode;
    customPersonalityInstruction =
      selection.mode === 'custom' ? selection.instruction : undefined;
  }

  const configuration = configurationForSelection(
    selection.candidate,
    configurationFilePath,
    messageDestination,
    pinSettings,
    botTemperament,
    existingConfiguration,
    botPersonality,
    customPersonalityInstruction,
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