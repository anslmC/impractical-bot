#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Page } from 'playwright';
import {
  generateNvidiaReply,
  loadNvidiaApiKey,
  NvidiaApiKeyError,
  resolveNvidiaEnvironmentPath,
  saveNvidiaApiKey,
  validateNvidiaApiKey,
} from './ai/nvidia.js';
import {
  initializeConfiguration,
  getBrowserProfilePath,
  isBrowserExecutableAvailable,
  promptBotTemperament,
  promptBotPersonality,
  promptPinRestorationSettings,
  selectBrowserCandidate,
  type InitializationOptions,
  type InitializationStatus,
  type TerminalPrompt,
} from './browser/initialization.js';
import {
  assertConfiguredBrowserCanStart,
  closeConfiguredBrowser,
  launchConfiguredBrowser,
  type BrowserLaunchSession,
} from './browser/launch.js';
import {
  discoverBrowsers,
  validateBrowserExecutablePath,
  type BrowserCandidate,
  type BrowserDiscoveryOptions,
} from './browser/discovery.js';
import {
  createUnavailableGroupRoster,
  extractGroupRoster,
  formatGroupRosterOutcome,
  sanitizeGroupRoster,
  type GroupRoster,
} from './browser/group-roster.js';
import {
  loadConfiguration,
  resolveBotTemperament,
  resolveBotPersonalityMode,
  resolveComposerSlicer,
  resolveConfigurationPaths,
  saveConfiguration,
  validateConfiguration,
  type ComposerSlicerOverrides,
  type Configuration,
} from './config/configuration.js';
import {
  composeMessengerReply,
  type ReplyCompositionResult,
} from './components/composer.js';
import { composeProductionSystemInstruction } from './components/personality.js';
import { generateAliases } from './components/alias-engine.js';
import {
  formatTerminalDiagnostic,
  formatTerminalMilestone,
  formatTerminalText,
} from './components/terminal-formatting.js';
import {
  startCombustion,
  type CombustionController,
} from './components/combustion.js';
import { createContextStore } from './components/context-store.js';
import {
  readMessengerMessages,
  type BackreadResult,
} from './components/backread.js';
import {
  createRuntimeControl,
  requestRuntimeChangeDestination,
  requestRuntimePause,
  requestRuntimeResume,
  requestRuntimeSetTemperament,
  requestRuntimeSetPersonality,
  requestRuntimeStatus,
  requestRuntimeStatusSnapshot,
  requestRuntimeStop,
  RuntimeAlreadyRunningError,
  RuntimeControlTimeoutError,
  waitForRuntimeShutdown,
  type RuntimeControl,
  type RuntimeShutdownWaitResult,
  type RuntimeStatusResult,
  type RuntimeStopResult,
} from './runtime-control.js';
import { CLI_COMMANDS, formatCliCommand } from './cli-commands.js';
import {
  checkDashboardTerminal,
  startDashboard,
  type DashboardSession,
  type DashboardTerminalCheck,
} from './tui/index.js';

type Output = (message: string) => void;

export interface CliRuntimeOptions {
  checkBrowserStartup?: (configuration: Configuration) => Promise<void>;
  launchBrowser?: (configuration: Configuration) => Promise<BrowserLaunchSession>;
  promptSecret?: TerminalPrompt;
  isInteractive?: () => boolean;
  validateNvidiaApiKey?: (apiKey: string) => Promise<void>;
  readMessengerMessages?: typeof readMessengerMessages;
  extractGroupRoster?: typeof extractGroupRoster;
  createContextStore?: typeof createContextStore;
  startCombustion?: typeof startCombustion;
  generateNvidiaReply?: typeof generateNvidiaReply;
  composeMessengerReply?: typeof composeMessengerReply;
  waitForShutdown?: () => Promise<void>;
  closeBrowser?: (configuration: Configuration) => Promise<void>;
  requestRuntimeChangeDestination?: typeof requestRuntimeChangeDestination;
  requestRuntimeSetTemperament?: typeof requestRuntimeSetTemperament;
  requestRuntimeSetPersonality?: typeof requestRuntimeSetPersonality;
  requestRuntimeStatus?: typeof requestRuntimeStatus;
  requestRuntimeStatusSnapshot?: typeof requestRuntimeStatusSnapshot;
  requestRuntimePause?: typeof requestRuntimePause;
  requestRuntimeResume?: typeof requestRuntimeResume;
  requestRuntimeStop?: typeof requestRuntimeStop;
  waitForRuntimeShutdown?: typeof waitForRuntimeShutdown;
  discoverBrowsers?: (options?: BrowserDiscoveryOptions) => Promise<BrowserCandidate[]>;
  browserExecutableExists?: (path: string) => boolean;
  checkDashboardTerminal?: () => DashboardTerminalCheck;
  startDashboard?: typeof startDashboard;
}

const commandReference = CLI_COMMANDS
  .map(command => `  ${formatCliCommand(command)}`)
  .join('\n');

const composerSlicerCommandReference = [
  '  setcomposerslicer enabled <true|false> [--force]',
  '  setcomposerslicer maxCharacters <positive-integer> [--force]',
  '  setcomposerslicer status',
].join('\n');

const usage = `Usage: impbot <command>

Commands:
${commandReference}

Composer Slicer:
${composerSlicerCommandReference}

Options:
  -h, --help     Show this help
  -v, --version  Show the version
  --debug        Start without the interactive dashboard`;

function promptTerminal(question: string): Promise<string | null> {
  const terminal = createInterface({ input: stdin, output: stdout });
  return new Promise(resolveAnswer => {
    let settled = false;
    const finish = (answer: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      terminal.close();
      resolveAnswer(answer);
    };

    terminal.once('close', () => finish(null));
    terminal.once('SIGINT', () => finish(null));
    terminal.question(question, answer => finish(answer));
  });
}

function promptSecretTerminal(question: string): Promise<string | null> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Hidden input requires an interactive terminal.'));
  }

  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  stdout.write(question);

  return new Promise(resolveAnswer => {
    let answer = '';
    const finish = (result: string | null): void => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
      }
      if (wasPaused) {
        stdin.pause();
      }
      stdout.write('\n');
      resolveAnswer(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        const code = character.charCodeAt(0);
        if (code === 3 || code === 4) {
          finish(null);
          return;
        }
        if (code === 10 || code === 13) {
          finish(answer);
          return;
        }
        if (code === 8 || code === 127) {
          answer = answer.slice(0, -1);
        } else if (code >= 32 && code <= 126) {
          answer += character;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function getSafeNvidiaError(error: unknown, fallback: string): string {
  return error instanceof NvidiaApiKeyError ? error.message : fallback;
}

function writeBackreadResult(result: BackreadResult, writeOutput: Output): void {
  for (const diagnostic of result.diagnostics) {
    writeOutput(formatTerminalDiagnostic(diagnostic));
  }
  writeOutput(formatTerminalMilestone(
    'BACKREAD',
    `Retrieved ${result.messages.length} messages; expected 30.`,
  ));
}

async function ensureNvidiaApiKey(
  configurationFilePath: string | undefined,
  promptSecret: TerminalPrompt,
  validateApiKey: (apiKey: string) => Promise<void>,
  writeOutput: Output,
  writeError: Output,
): Promise<boolean> {
  let environmentFilePath: string;
  let existingKey: string | undefined;
  try {
    environmentFilePath = resolveNvidiaEnvironmentPath(configurationFilePath);
    existingKey = loadNvidiaApiKey(environmentFilePath);
  } catch {
    writeError('Unable to load the application NVIDIA API key file.');
    return false;
  }
  if (existingKey) {
    return true;
  }

  let submittedKey: string | null;
  try {
    submittedKey = await promptSecret('Enter your NVIDIA API key: ');
  } catch {
    writeError('Unable to read the NVIDIA API key using hidden input.');
    return false;
  }
  if (submittedKey === null) {
    writeError('NVIDIA API key setup was cancelled; no key was saved.');
    return false;
  }

  const apiKey = submittedKey.trim();
  try {
    await validateApiKey(apiKey);
    saveNvidiaApiKey(environmentFilePath, apiKey);
  } catch (error) {
    writeError(getSafeNvidiaError(error, 'Unable to validate or save the NVIDIA API key.'));
    return false;
  }
  writeOutput('NVIDIA API key saved.');
  return true;
}

async function handleInit(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  prompt: TerminalPrompt,
  initialize: (options: InitializationOptions) => Promise<InitializationStatus>,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let runtimeStatus: RuntimeStatusResult;
  try {
    runtimeStatus = await (runtime.requestRuntimeStatus ?? requestRuntimeStatus)(configurationFilePath);
  } catch (error) {
    writeError(
      'Unable to check whether impractical-bot is running: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (runtimeStatus.status === 'running') {
    writeError(
      'An impractical-bot engine is running for this configuration. Run `impbot stop` before ' +
      'running `impbot init`; no configuration was changed.',
    );
    return 1;
  }

  const status = await initialize({
    configurationFilePath,
    prompt,
    writeOutput,
    writeError,
  });
  if (status === 'failed') {
    return 1;
  }
  if (status === 'cancelled') {
    return 0;
  }
  const configured = await ensureNvidiaApiKey(
    configurationFilePath,
    runtime.promptSecret ?? promptSecretTerminal,
    runtime.validateNvidiaApiKey ?? validateNvidiaApiKey,
    writeOutput,
    writeError,
  );
  return configured ? 0 : 1;
}

function handleConfig(writeOutput: Output, writeError: Output, filePath?: string): number {
  let result;
  try {
    result = loadConfiguration(filePath);
  } catch (error) {
    writeError(
      `Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (result.status === 'missing') {
    writeOutput('Configuration has not been initialized. No configuration file was found.');
    return 0;
  }
  if (result.status === 'malformed') {
    writeError(`Configuration is malformed: ${result.message}`);
    return 1;
  }
  if (result.status === 'unsupported-version') {
    writeError(`Configuration schema version ${result.version} is not supported.`);
    return 1;
  }
  if (result.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return 1;
  }

  const configuration = result.configuration;
  const composerSlicer = resolveComposerSlicer(configuration);
  writeOutput([
    'Current configuration:',
    `  Version: ${configuration.version}`,
    `  Browser: ${configuration.browser}`,
    `  Executable: ${configuration.executablePath}`,
    `  Profile: ${configuration.profilePath}`,
    `  Skip PIN restoration: ${configuration.skipPinRestoration}`,
    `  Messenger restoration PIN: ${configuration.pin}`,
    `  CDP port: ${configuration.cdpPort ?? 'not configured'}`,
    `  Startup URL: ${configuration.startupUrl ?? 'not configured'}`,
    `  Message destination: ${configuration.messageDestination ?? 'not configured'}`,
    `  Bot temperament: ${resolveBotTemperament(configuration)}`,
    `  setpersonality: ${resolveBotPersonalityMode(configuration)}`,
    `  Composer slicer: ${composerSlicer.enabled
      ? `enabled at ${String(composerSlicer.maxCharacters)} characters`
      : 'disabled'}`,
    `  Puppet name: ${configuration.puppetName || 'Not set'}`,
  ].join('\n'));
  return 0;
}

function writeComposerSlicerUsageError(writeError: Output, message: string): number {
  writeError(`Error: ${message}\n\nComposer Slicer commands:\n${composerSlicerCommandReference}`);
  return 1;
}

function handleComposerSlicerStatus(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
): number {
  const current = readConfigurationForOwnedWrite(configurationFilePath);
  if (current.status !== 'valid') {
    writeError(current.reason);
    return 1;
  }

  const composerSlicer = resolveComposerSlicer(current.configuration);
  writeOutput([
    'Composer Slicer Configuration',
    '',
    `Enabled:        ${composerSlicer.enabled ? 'Yes' : 'No'}`,
    `Max Characters: ${composerSlicer.maxCharacters}`,
  ].join('\n'));
  return 0;
}

async function handleSetComposerSlicer(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  args: string[],
  prompt: TerminalPrompt,
  runtime: CliRuntimeOptions,
): Promise<number> {
  const force = args.includes('--force');
  const [setting, value, ...extra] = args.filter(argument => argument !== '--force');

  if (setting === undefined) {
    return writeComposerSlicerUsageError(writeError, 'missing Composer Slicer setting.');
  }

  if (setting === 'status') {
    if (value !== undefined) {
      return writeComposerSlicerUsageError(
        writeError,
        `unexpected argument '${value}' for 'status'.`,
      );
    }
    return handleComposerSlicerStatus(writeOutput, writeError, configurationFilePath);
  }

  if (setting !== 'enabled' && setting !== 'maxCharacters') {
    return writeComposerSlicerUsageError(
      writeError,
      `unknown Composer Slicer setting '${setting}'.`,
    );
  }

  if (value === undefined) {
    return writeComposerSlicerUsageError(
      writeError,
      `missing value for Composer Slicer setting '${setting}'.`,
    );
  }

  if (extra.length > 0) {
    return writeComposerSlicerUsageError(writeError, `unexpected argument '${extra[0]}'.`);
  }

  let composerSlicer: ComposerSlicerOverrides;
  let savedMessage: string;
  if (setting === 'enabled') {
    if (value !== 'true' && value !== 'false') {
      writeError("Error: 'enabled' must be 'true' or 'false'.");
      return 1;
    }
    const enabled = value === 'true';
    composerSlicer = { enabled };
    savedMessage = `enabled ${String(enabled)}`;
  } else {
    const maxCharacters = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isInteger(maxCharacters) || maxCharacters < 1) {
      writeError("Error: 'maxCharacters' must be a positive integer.");
      return 1;
    }
    composerSlicer = { maxCharacters };
    savedMessage = `maxCharacters ${String(maxCharacters)}`;
  }

  const current = readConfigurationForOwnedWrite(configurationFilePath);
  if (current.status !== 'valid') {
    writeError(current.reason);
    return 1;
  }

  let runtimeStatus: RuntimeStatusResult;
  try {
    runtimeStatus = await (runtime.requestRuntimeStatus ?? requestRuntimeStatus)(
      configurationFilePath,
    );
  } catch (error) {
    writeError(
      'Unable to check whether impractical-bot is running: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    writeError('The Composer Slicer configuration was not changed.');
    return 1;
  }

  if (runtimeStatus.status === 'running') {
    writeOutput([
      'WARNING: Impractical Bot engine is currently running.',
      '',
      'Changes to Composer Slicer will NOT affect the active engine.',
      'A restart is required before the new settings take effect.',
    ].join('\n'));

    if (force) {
      writeOutput(
        'Continuing because --force was supplied. The running engine retains its existing ' +
        'configuration until restarted.',
      );
    } else {
      const interactive = runtime.isInteractive?.() ??
        (stdin.isTTY === true || prompt !== promptTerminal);
      if (!interactive) {
        writeError(
          'Confirmation is required to change Composer Slicer while the engine is running, ' +
          'but non-interactive execution cannot prompt for confirmation. Re-run with --force ' +
          'to save without confirmation. The Composer Slicer configuration was not changed.',
        );
        return 1;
      }

      const answer = await prompt('Save these changes anyway? [y/N]: ');
      const normalized = answer === null ? null : answer.trim().toLowerCase();
      if (normalized === null || normalized === 'n' || normalized === '') {
        writeOutput('Composer Slicer configuration was not changed.');
        return 0;
      }
      if (normalized !== 'y') {
        writeError(
          "Enter 'y' to save the changes or 'n' to cancel. " +
          'The Composer Slicer configuration was not changed.',
        );
        return 1;
      }
    }
  }

  const latest = readConfigurationForOwnedWrite(configurationFilePath);
  if (latest.status !== 'valid') {
    writeError(latest.reason);
    return 1;
  }

  try {
    saveConfiguration(
      {
        ...latest.configuration,
        composerSlicer: {
          ...latest.configuration.composerSlicer,
          ...composerSlicer,
        },
      },
      configurationFilePath,
    );
  } catch (error) {
    writeError(
      `Unable to save Composer Slicer configuration: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  writeOutput(`Composer Slicer configuration saved: ${savedMessage}.`);
  return 0;
}

function isValidPuppetName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

async function retrievePuppetName(page: Page): Promise<string> {
  const profileButton = page.getByRole('button', { name: 'Account, your profile', exact: true });
  if (await profileButton.count() !== 1 || !await profileButton.isVisible() ||
      !await profileButton.isEnabled()) {
    throw new Error('The visible Your profile button was not uniquely available.');
  }

  try {
    await profileButton.click();
    const profileDialog = page.getByRole('dialog', { name: 'Your profile', exact: true });
    await profileDialog.waitFor({ state: 'visible', timeout: 20_000 });
    const profileLink = profileDialog.locator('a[href="/me/"]');
    if (await profileLink.count() !== 1 || !await profileLink.isVisible() ||
        await profileLink.getAttribute('href') !== '/me/') {
      throw new Error('The /me/ link was not uniquely available in the profile dialog.');
    }

    const puppetName = (await profileLink.innerText()).trim();
    if (!isValidPuppetName(puppetName)) {
      throw new Error('The profile dialog did not contain a valid displayed account name.');
    }
    return puppetName;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

async function updatePuppetName(
  page: Page,
  configuration: Configuration,
  configurationFilePath: string | undefined,
  writeOutput: Output,
): Promise<void> {
  let puppetName: string;
  try {
    puppetName = await retrievePuppetName(page);
  } catch (error) {
    writeOutput(formatTerminalText(
      'Puppet account name retrieval failed; keeping the existing configured value. ' +
      `${error instanceof Error ? error.message : 'Unknown retrieval error.'}`,
      'yellow',
    ));
    return;
  }

  try {
    const latest = readConfigurationForOwnedWrite(configurationFilePath);
    if (latest.status !== 'valid') {
      throw new Error(latest.reason);
    }
    const savedConfiguration = saveConfiguration(
      { ...latest.configuration, puppetName },
      configurationFilePath,
    );
    configuration.puppetName = savedConfiguration.puppetName;
    writeOutput(
      `${formatTerminalText('Puppet account name updated:', 'cyan')} ` +
      `${formatTerminalText(JSON.stringify(puppetName), 'bold')}.`,
    );
  } catch (error) {
    writeOutput(
      `Puppet account name retrieved as ${JSON.stringify(puppetName)}, but saving failed; ` +
      `keeping the existing configured value. ${error instanceof Error ? error.message : 'Unknown save error.'}`,
    );
  }
}

function loadLatestConfiguration(
  configurationFilePath: string | undefined,
  writeError: Output,
  failurePrefix: string,
): Configuration | undefined {
  let result;
  try {
    result = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (result.status === 'missing') {
    writeError(`${failurePrefix}: the configuration file no longer exists.`);
    return undefined;
  }
  if (result.status === 'malformed') {
    writeError(`${failurePrefix}: ${result.message}`);
    return undefined;
  }
  if (result.status === 'unsupported-version') {
    writeError(`${failurePrefix}: schema version ${result.version} is not supported.`);
    return undefined;
  }
  if (result.status === 'pin-required') {
    writeError(`${failurePrefix}: Messenger PIN configuration is required.`);
    return undefined;
  }
  return result.configuration;
}

type OwnedWriteConfiguration =
  | { status: 'valid'; configuration: Configuration }
  | { status: 'invalid'; reason: string };

function readConfigurationForOwnedWrite(
  configurationFilePath: string | undefined,
): OwnedWriteConfiguration {
  let result;
  try {
    result = loadConfiguration(configurationFilePath);
  } catch (error) {
    return {
      status: 'invalid',
      reason: `Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.status === 'missing') {
    return {
      status: 'invalid',
      reason: 'Configuration has not been initialized. Run `impbot init` first.',
    };
  }
  if (result.status === 'malformed') {
    return { status: 'invalid', reason: `Configuration is malformed: ${result.message}` };
  }
  if (result.status === 'unsupported-version') {
    return {
      status: 'invalid',
      reason: `Configuration schema version ${result.version} is not supported.`,
    };
  }
  if (result.status === 'pin-required') {
    return {
      status: 'invalid',
      reason: 'Messenger PIN configuration is required. Run `impbot init` to reconfigure it.',
    };
  }
  return { status: 'valid', configuration: result.configuration };
}

function loadChangeBrowserConfiguration(
  configurationFilePath: string | undefined,
  writeError: Output,
): Configuration | undefined {
  let result;
  try {
    result = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (result.status === 'missing') {
    writeError('Configuration has not been initialized. Run `impbot init` first.');
    return undefined;
  }
  if (result.status === 'malformed') {
    writeError(`Configuration is malformed: ${result.message}`);
    return undefined;
  }
  if (result.status === 'unsupported-version') {
    writeError(`Configuration schema version ${result.version} is not supported.`);
    return undefined;
  }
  if (result.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return undefined;
  }
  return result.configuration;
}

async function handleChangeBrowser(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  prompt: TerminalPrompt,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let currentConfiguration = loadChangeBrowserConfiguration(configurationFilePath, writeError);
  if (!currentConfiguration) {
    return 1;
  }

  let runtimeStatus: RuntimeStatusResult;
  try {
    runtimeStatus = await (runtime.requestRuntimeStatus ?? requestRuntimeStatus)(configurationFilePath);
  } catch (error) {
    writeError(
      'Unable to check whether impractical-bot is running: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let browserClosedByEngineShutdown = false;
  if (runtimeStatus.status === 'running') {
    let stopResult: RuntimeStopResult;
    try {
      stopResult = await (runtime.requestRuntimeStop ?? requestRuntimeStop)(configurationFilePath);
    } catch (error) {
      writeError(
        'Unable to stop the running impractical-bot engine: ' +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      writeError('The browser was not changed. Run `impbot stop` and retry once the engine has exited.');
      return 1;
    }

    if (stopResult.status === 'stopped') {
      let shutdownResult: RuntimeShutdownWaitResult;
      try {
        shutdownResult = await (runtime.waitForRuntimeShutdown ?? waitForRuntimeShutdown)(
          configurationFilePath,
        );
      } catch (error) {
        writeError(
          'Unable to verify that the impractical-bot engine shut down: ' +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        writeError('The browser was not changed.');
        return 1;
      }
      if (shutdownResult.status !== 'stopped') {
        writeError(
          `The impractical-bot engine did not confirm shutdown: ${shutdownResult.reason} ` +
          'The browser was not changed.',
        );
        return 1;
      }

      writeOutput(`Engine ${stopResult.instanceId} stopped gracefully before the browser change.`);

      const reloadedConfiguration = loadChangeBrowserConfiguration(
        configurationFilePath,
        writeError,
      );
      if (!reloadedConfiguration) {
        writeError(
          'The impractical-bot engine was stopped, but the browser was not changed because the ' +
          'configuration could not be reloaded.',
        );
        return 1;
      }
      currentConfiguration = reloadedConfiguration;
      browserClosedByEngineShutdown = true;
    }
  }

  let candidates: BrowserCandidate[];
  try {
    candidates = await (runtime.discoverBrowsers ?? discoverBrowsers)();
  } catch (error) {
    writeError(`Unable to discover browsers: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const fileExists = runtime.browserExecutableExists ?? (path => isBrowserExecutableAvailable(path));
  const selection = await selectBrowserCandidate(
    candidates,
    prompt,
    writeOutput,
    writeError,
    fileExists,
  );
  if (selection.status === 'cancelled') {
    writeOutput('Browser change cancelled. The current configuration was not changed.');
    return 0;
  }

  let candidate: BrowserCandidate;
  try {
    candidate = validateBrowserExecutablePath(selection.candidate.executablePath);
    if (candidate.browser !== selection.candidate.browser) {
      throw new Error('Selected browser does not match its executable.');
    }
  } catch (error) {
    writeError(`Selected browser executable is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!isBrowserExecutableAvailable(candidate.executablePath, fileExists)) {
    writeError(`Selected browser executable is unavailable: ${candidate.executablePath}`);
    return 1;
  }

  let profilePath = currentConfiguration.profilePath;
  if (candidate.browser !== currentConfiguration.browser) {
    try {
      const selectedConfigurationPath = configurationFilePath ?? resolveConfigurationPaths().filePath;
      profilePath = getBrowserProfilePath(candidate.browser, selectedConfigurationPath);
    } catch (error) {
      writeError(`Unable to determine the selected browser profile: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const pinSettings = await promptPinRestorationSettings(prompt, writeError);
  if (pinSettings === null) {
    writeOutput('Browser change cancelled. The current configuration was not changed.');
    return 0;
  }

  const nextConfiguration: Configuration = {
    ...currentConfiguration,
    browser: candidate.browser,
    executablePath: candidate.executablePath,
    profilePath,
    ...pinSettings,
  };

  if (!browserClosedByEngineShutdown) {
    try {
      await (runtime.closeBrowser ?? closeConfiguredBrowser)(currentConfiguration);
    } catch (error) {
      writeError(`Unable to close the current browser: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  try {
    saveConfiguration(nextConfiguration, configurationFilePath);
  } catch (error) {
    writeError(`Unable to save browser selection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  writeOutput(`Browser selection saved: ${candidate.displayName} (${candidate.executablePath}).`);
  writeOutput('The selected browser was not launched.');
  return 0;
}

async function handleChangeMsgUrl(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  prompt: TerminalPrompt,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let configurationResult;
  try {
    configurationResult = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (configurationResult.status === 'missing') {
    writeError('Configuration has not been initialized. Run `impbot init` first.');
    return 1;
  }
  if (configurationResult.status === 'malformed') {
    writeError(`Configuration is malformed: ${configurationResult.message}`);
    return 1;
  }
  if (configurationResult.status === 'unsupported-version') {
    writeError(`Configuration schema version ${configurationResult.version} is not supported.`);
    return 1;
  }
  if (configurationResult.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return 1;
  }

  const configuration = configurationResult.configuration;
  let messageDestination: string | undefined;
  while (messageDestination === undefined) {
    const answer = await prompt('Enter the new message destination URL, or press Enter to cancel: ');
    if (answer === null || answer.trim() === '') {
      writeOutput('Message destination change cancelled. The current configuration was not changed.');
      return 0;
    }

    const candidate = answer.trim();
    try {
      validateConfiguration({ ...configuration, messageDestination: candidate });
      messageDestination = candidate;
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
    }
  }

  let result;
  try {
    result = await (runtime.requestRuntimeChangeDestination ?? requestRuntimeChangeDestination)(
      configurationFilePath,
      messageDestination,
    );
  } catch (error) {
    writeError(`Unable to change message destination: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (result.status === 'not-running') {
    const latestConfiguration = loadLatestConfiguration(
      configurationFilePath,
      writeError,
      'Unable to save message destination',
    );
    if (!latestConfiguration) {
      return 1;
    }
    try {
      saveConfiguration(
        { ...latestConfiguration, messageDestination },
        configurationFilePath,
      );
    } catch (error) {
      writeError(`Unable to save message destination: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    writeOutput(`Message destination saved: ${messageDestination}.`);
    return 0;
  }

  if (result.status === 'changed') {
    writeOutput(
      `Message destination changed: ${messageDestination}. ` +
      (result.resumed
        ? `Engine ${result.instanceId} resumed.`
        : `Engine ${result.instanceId} remains paused.`),
    );
    return 0;
  }

  if (result.status === 'rejected') {
    writeError(`Message destination change rejected: ${result.reason}`);
    writeOutput(
      result.resumed
        ? 'The message destination was not changed. The engine resumed at the previous destination.'
        : 'The message destination was not changed. The engine remains paused; ' +
          'run `impbot resume` to resume normal operation.',
    );
    return 1;
  }

  writeError(`Message destination change failed: ${result.reason}`);
  writeOutput(
    result.resumed
      ? 'The message destination was not changed. The engine resumed at the previous destination.'
      : 'The engine remains paused. Run `impbot resume` after resolving the failure, ' +
        'or `impbot stop` to shut down.',
  );
  return 1;
}

async function handleSetBotTemperament(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  prompt: TerminalPrompt,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let configurationResult;
  try {
    configurationResult = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (configurationResult.status === 'missing') {
    writeError('Configuration has not been initialized. Run `impbot init` first.');
    return 1;
  }
  if (configurationResult.status === 'malformed') {
    writeError(`Configuration is malformed: ${configurationResult.message}`);
    return 1;
  }
  if (configurationResult.status === 'unsupported-version') {
    writeError(`Configuration schema version ${configurationResult.version} is not supported.`);
    return 1;
  }
  if (configurationResult.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return 1;
  }

  const configuration = configurationResult.configuration;
  const temperament = await promptBotTemperament(
    prompt,
    writeOutput,
    writeError,
    resolveBotTemperament(configuration),
  );
  if (temperament === null) {
    writeOutput('Bot temperament change cancelled. The current configuration was not changed.');
    return 0;
  }

  let result;
  try {
    result = await (runtime.requestRuntimeSetTemperament ?? requestRuntimeSetTemperament)(
      configurationFilePath,
      temperament,
    );
  } catch (error) {
    writeError(`Unable to change bot temperament: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (result.status === 'not-running') {
    const latestConfiguration = loadLatestConfiguration(
      configurationFilePath,
      writeError,
      'Unable to save bot temperament',
    );
    if (!latestConfiguration) {
      return 1;
    }
    try {
      saveConfiguration(
        { ...latestConfiguration, botTemperament: temperament },
        configurationFilePath,
      );
    } catch (error) {
      writeError(`Unable to save bot temperament: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    writeOutput(`Bot temperament saved: ${temperament}.`);
    return 0;
  }

  if (result.status === 'changed') {
    writeOutput(`Bot temperament changed: ${temperament}. Engine ${result.instanceId} updated.`);
    return 0;
  }

  writeError(`Bot temperament change failed: ${result.reason}`);
  writeOutput('The previous bot temperament remains active and configured.');
  return 1;
}

async function handleSetPersonality(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  prompt: TerminalPrompt,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let configurationResult;
  try {
    configurationResult = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (configurationResult.status === 'missing') {
    writeError('Configuration has not been initialized. Run `impbot init` first.');
    return 1;
  }
  if (configurationResult.status === 'malformed') {
    writeError(`Configuration is malformed: ${configurationResult.message}`);
    return 1;
  }
  if (configurationResult.status === 'unsupported-version') {
    writeError(`Configuration schema version ${configurationResult.version} is not supported.`);
    return 1;
  }
  if (configurationResult.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return 1;
  }

  const configuration = configurationResult.configuration;
  const currentMode = resolveBotPersonalityMode(configuration);
  const selection = await promptBotPersonality(
    prompt,
    writeOutput,
    writeError,
    currentMode,
    configuration.customPersonalityInstruction,
  );
  if (selection === null) {
    writeOutput('Personality change cancelled. The current configuration was not changed.');
    return 0;
  }

  let result;
  try {
    result = await (runtime.requestRuntimeSetPersonality ?? requestRuntimeSetPersonality)(
      configurationFilePath,
      selection.mode,
      selection.mode === 'custom' ? selection.instruction : '',
    );
  } catch (error) {
    writeError(`Unable to change personality: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (result.status === 'not-running') {
    const latestConfiguration = loadLatestConfiguration(
      configurationFilePath,
      writeError,
      'Unable to save personality',
    );
    if (!latestConfiguration) {
      return 1;
    }
    try {
      saveConfiguration(
        {
          ...latestConfiguration,
          botPersonality: selection.mode,
          customPersonalityInstruction:
            selection.mode === 'custom' ? selection.instruction : undefined,
        },
        configurationFilePath,
      );
    } catch (error) {
      writeError(`Unable to save personality: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    writeOutput(`Personality saved: ${selection.mode}.`);
    return 0;
  }

  if (result.status === 'changed') {
    writeOutput(`Personality changed: ${selection.mode}. Engine ${result.instanceId} updated.`);
    return 0;
  }

  writeError(`Personality change failed: ${result.reason}`);
  writeOutput('The previous personality remains active and configured.');
  return 1;
}

async function handleStart(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  runtime: CliRuntimeOptions,
  debug = false,
): Promise<number> {
  const dashboardTerminal = debug === false
    ? (runtime.checkDashboardTerminal ?? checkDashboardTerminal)()
    : undefined;
  const useDashboard = dashboardTerminal?.ok === true;

  let configurationResult;
  try {
    configurationResult = loadConfiguration(configurationFilePath);
  } catch (error) {
    writeError(`Unable to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (configurationResult.status === 'missing') {
    writeError('Configuration has not been initialized. Run `impbot init` first.');
    return 1;
  }
  if (configurationResult.status === 'malformed') {
    writeError(`Configuration is malformed: ${configurationResult.message}`);
    return 1;
  }
  if (configurationResult.status === 'unsupported-version') {
    writeError(`Configuration schema version ${configurationResult.version} is not supported.`);
    return 1;
  }
  if (configurationResult.status === 'pin-required') {
    writeError('Messenger PIN configuration is required. Run `impbot init` to reconfigure it.');
    return 1;
  }

  const DEBUG_MODE = process.env.IMPRACTICAL_BOT_DEBUG === '1';
  const ENABLE_DEBUG_AUTO_RESPONSE = false;
  let apiKey = '';
  try {
    const environmentFilePath = resolveNvidiaEnvironmentPath(configurationFilePath);
    apiKey = loadNvidiaApiKey(environmentFilePath) ?? '';
  } catch {
    writeError('Unable to load the application NVIDIA API key file.');
    return 1;
  }
  if (!apiKey) {
    writeError('NVIDIA API key is missing. Run `impbot init` or `impbot updatekey` first.');
    return 1;
  }
  writeOutput(formatTerminalMilestone('STARTUP', 'Verifying browser configuration.'));
  try {
    await (runtime.checkBrowserStartup ?? assertConfiguredBrowserCanStart)(
      configurationResult.configuration,
    );
  } catch (error) {
    writeError(`Unable to start browser: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  writeOutput(formatTerminalMilestone('BROWSER', 'Browser configuration verified.'));
  if (!DEBUG_MODE || ENABLE_DEBUG_AUTO_RESPONSE) {
    try {
      await (runtime.validateNvidiaApiKey ?? validateNvidiaApiKey)(apiKey);
    } catch (error) {
      writeError(getSafeNvidiaError(error, 'Unable to validate the NVIDIA API key.'));
      return 1;
    }
    writeOutput(formatTerminalMilestone('STARTUP', 'NVIDIA API key validated successfully.'));
  } else {
    writeOutput(formatTerminalMilestone(
      'STARTUP',
      'Debug mode enabled; skipping NVIDIA API key validation.',
    ));
  }

  type ShutdownSource = 'sigint' | 'runtime-control' | 'injected';
  let resolveShutdown!: (source: ShutdownSource) => void;
  const shutdownRequest = new Promise<ShutdownSource>(resolve => {
    resolveShutdown = resolve;
  });
  let combustionController: CombustionController | undefined;
  let runtimeControl: RuntimeControl | undefined;
  let dashboardSession: DashboardSession | undefined;
  const onSigint = (): void => {
    runtimeControl?.setState('stopping');
    resolveShutdown('sigint');
  };
  process.once('SIGINT', onSigint);
  try {
    runtimeControl = await createRuntimeControl(
      configurationFilePath,
      {
        requestShutdown: () => resolveShutdown('runtime-control'),
        requestPause: async () => {
          await combustionController?.pause();
        },
        requestResume: async () => {
          await combustionController?.resume();
        },
        requestStatus: () => ({
          browser: configurationResult.configuration.browser,
          temperament: resolveBotTemperament(configurationResult.configuration),
          personality: resolveBotPersonalityMode(configurationResult.configuration),
          messengerDestination: configurationResult.configuration.messageDestination ?? '',
        }),
        requestChangeDestination: async (destination, options) => {
          if (!combustionController) {
            return {
              status: 'failed',
              reason: 'The engine is not ready to change destinations.',
            };
          }
          return combustionController.changeDestination(destination, {
            resume: options.resume,
            persist: newDestination => {
              const latest = readConfigurationForOwnedWrite(configurationFilePath);
              if (latest.status !== 'valid') {
                throw new Error(latest.reason);
              }
              const savedConfiguration = saveConfiguration(
                {
                  ...latest.configuration,
                  messageDestination: newDestination,
                },
                configurationFilePath,
              );
              configurationResult.configuration.messageDestination =
                savedConfiguration.messageDestination;
            },
          });
        },
        requestSetTemperament: async temperament => {
          if (!combustionController) {
            return {
              status: 'failed',
              reason: 'The engine is not ready to change temperaments.',
            };
          }

          const previousTemperament = resolveBotTemperament(configurationResult.configuration);
          const latestTemperament = readConfigurationForOwnedWrite(configurationFilePath);
          if (latestTemperament.status !== 'valid') {
            return {
              status: 'failed',
              reason: `The temperament could not be saved. ${latestTemperament.reason}`,
            };
          }
          try {
            const savedConfiguration = saveConfiguration(
              {
                ...latestTemperament.configuration,
                botTemperament: temperament,
              },
              configurationFilePath,
            );
            configurationResult.configuration.botTemperament =
              savedConfiguration.botTemperament;
          } catch (error) {
            return {
              status: 'failed',
              reason:
                'The temperament could not be saved. ' +
                `${error instanceof Error ? error.message : String(error)}`,
            };
          }

          try {
            combustionController.setTemperament(temperament);
          } catch (error) {
            const latestRollback = readConfigurationForOwnedWrite(configurationFilePath);
            if (latestRollback.status !== 'valid') {
              return {
                status: 'failed',
                reason:
                  'The runtime temperament update failed and the persisted temperament ' +
                  `could not be restored. ${latestRollback.reason}`,
              };
            }
            try {
              const restoredConfiguration = saveConfiguration(
                {
                  ...latestRollback.configuration,
                  botTemperament: previousTemperament,
                },
                configurationFilePath,
              );
              configurationResult.configuration.botTemperament =
                restoredConfiguration.botTemperament;
            } catch (rollbackError) {
              return {
                status: 'failed',
                reason:
                  'The runtime temperament update failed and the persisted temperament ' +
                  'could not be restored. ' +
                  `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              };
            }
            return {
              status: 'failed',
              reason:
                'The runtime temperament update failed; the previous temperament remains ' +
                'active and configured. ' +
                `${error instanceof Error ? error.message : String(error)}`,
            };
          }

          return { status: 'changed' };
        },
        requestSetPersonality: async (mode, instruction) => {
          if (!combustionController) {
            return {
              status: 'failed',
              reason: 'The engine is not ready to change personalities.',
            };
          }

          const previousMode = resolveBotPersonalityMode(configurationResult.configuration);
          const previousInstruction =
            configurationResult.configuration.customPersonalityInstruction;
          const latestPersonality = readConfigurationForOwnedWrite(configurationFilePath);
          if (latestPersonality.status !== 'valid') {
            return {
              status: 'failed',
              reason: `The personality could not be saved. ${latestPersonality.reason}`,
            };
          }
          try {
            const savedConfiguration = saveConfiguration(
              {
                ...latestPersonality.configuration,
                botPersonality: mode,
                ...(mode === 'custom'
                  ? { customPersonalityInstruction: instruction }
                  : { customPersonalityInstruction: undefined }),
              },
              configurationFilePath,
            );
            configurationResult.configuration.botPersonality =
              savedConfiguration.botPersonality;
            configurationResult.configuration.customPersonalityInstruction =
              savedConfiguration.customPersonalityInstruction;
          } catch (error) {
            return {
              status: 'failed',
              reason:
                'The personality could not be saved. ' +
                `${error instanceof Error ? error.message : String(error)}`,
            };
          }

          try {
            combustionController.setPersonality(
              mode,
              mode === 'custom' ? instruction : undefined,
            );
          } catch (error) {
            const latestRollback = readConfigurationForOwnedWrite(configurationFilePath);
            if (latestRollback.status !== 'valid') {
              return {
                status: 'failed',
                reason:
                  'The runtime personality update failed and the persisted personality ' +
                  `could not be restored. ${latestRollback.reason}`,
              };
            }
            try {
              const restoredConfiguration = saveConfiguration(
                {
                  ...latestRollback.configuration,
                  botPersonality: previousMode,
                  ...(previousMode === 'custom'
                    ? { customPersonalityInstruction: previousInstruction }
                    : { customPersonalityInstruction: undefined }),
                },
                configurationFilePath,
              );
              configurationResult.configuration.botPersonality =
                restoredConfiguration.botPersonality;
              configurationResult.configuration.customPersonalityInstruction =
                restoredConfiguration.customPersonalityInstruction;
            } catch (rollbackError) {
              return {
                status: 'failed',
                reason:
                  'The runtime personality update failed and the persisted personality ' +
                  'could not be restored. ' +
                  `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              };
            }
            return {
              status: 'failed',
              reason:
                'The runtime personality update failed; the previous personality remains ' +
                'active and configured. ' +
                `${error instanceof Error ? error.message : String(error)}`,
            };
          }

          return { status: 'changed' };
        },
      },
    );
  } catch (error) {
    process.removeListener('SIGINT', onSigint);
    writeError(error instanceof RuntimeAlreadyRunningError
      ? error.message
      : `Unable to claim runtime ownership: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const shutdownPromise: Promise<ShutdownSource> = runtime.waitForShutdown
    ? Promise.race([
        shutdownRequest,
        Promise.resolve().then(() => runtime.waitForShutdown!()).then(() => {
          runtimeControl?.setState('stopping');
          return 'injected' as const;
        }),
      ])
    : shutdownRequest;
  const startupAbort = new AbortController();
  void shutdownPromise.then(() => startupAbort.abort());
  let session: BrowserLaunchSession | undefined;
  let aliasData: ReturnType<typeof generateAliases> | undefined;
  let exitCode = 0;
  let startupStage: 'launch' | 'prepare' | 'cranking' | 'combustion' = 'launch';

  try {
    writeOutput(formatTerminalMilestone('BROWSER', 'Launching browser session.'));
    const launchPromise = (runtime.launchBrowser ?? launchConfiguredBrowser)(configurationResult.configuration);
    const launchResult = await Promise.race([
      launchPromise.then(
        launchedSession => ({ type: 'launched' as const, session: launchedSession }),
        error => ({ type: 'failed' as const, error }),
      ),
      shutdownPromise.then(source => ({ type: 'shutdown' as const, source })),
    ]);
    if (launchResult.type === 'failed') {
      writeError(`Unable to start browser: ${launchResult.error instanceof Error ? launchResult.error.message : String(launchResult.error)}`);
      exitCode = 1;
    } else if (launchResult.type === 'shutdown') {
      session = await launchPromise.catch(() => undefined);
      writeOutput('Shutdown requested; disconnecting Playwright.');
      exitCode = launchResult.source === 'runtime-control' ? 0 : 130;
    } else {
      session = launchResult.session;
      startupStage = 'prepare';
      writeOutput(formatTerminalMilestone(
        'BROWSER',
        `${session.reusedExistingBrowser ? 'Attached to existing browser' : 'Browser launched and connected'} ` +
        `(${session.browserVersion}).`,
      ));
      const preparationResult = await Promise.race([
        session.prepare({ signal: startupAbort.signal }).then(
          page => ({ type: 'ready' as const, page }),
        ),
        shutdownPromise.then(source => ({ type: 'shutdown' as const, source })),
        session.disconnected.then(() => ({ type: 'disconnected' as const })),
      ]);
      if (preparationResult.type === 'shutdown') {
        writeOutput('Shutdown requested; disconnecting Playwright.');
        exitCode = preparationResult.source === 'runtime-control' ? 0 : 130;
      } else if (preparationResult.type === 'disconnected') {
        throw new Error('The browser disconnected during startup preparation.');
      } else {
        writeOutput(formatTerminalMilestone('CRANKING', 'Preparing Messenger context.'));
        await updatePuppetName(
          preparationResult.page,
          configurationResult.configuration,
          configurationFilePath,
          writeOutput,
        );
        const puppetName = configurationResult.configuration.puppetName;
        if (!puppetName) {
          throw new Error('A configured puppet name is required to initialize the alias engine.');
        }
        let groupRoster: GroupRoster;
        try {
          groupRoster = sanitizeGroupRoster(
            await (runtime.extractGroupRoster ?? extractGroupRoster)(
              preparationResult.page,
              puppetName,
            ),
          );
        } catch {
          groupRoster = createUnavailableGroupRoster('group roster extraction failed');
        }
        console.log(formatGroupRosterOutcome(groupRoster));
        aliasData = generateAliases(puppetName);
        writeOutput(formatTerminalMilestone(
          'ALIASES',
          `DEBUG: Alias engine initialized for puppet name ${JSON.stringify(puppetName)} ` +
          `(${aliasData.valids.length} aliases).`,
        ));
        try {
          if (await session.isWindowMinimized?.(preparationResult.page)) {
            writeOutput('WARNING: Browser is minimized. Backread may collect fewer messages than expected.');
          }
        } catch {
          writeError('Unable to detect browser window state.');
        }
        startupStage = 'cranking';
        let backread: BackreadResult;
        writeOutput(formatTerminalMilestone('BACKREAD', 'Reading historical Messenger messages.'));
        try {
          backread = await (runtime.readMessengerMessages ?? readMessengerMessages)(
            preparationResult.page,
          );
        } catch {
          throw new Error('Unable to read Messenger messages.');
        }
        const contextStore = (runtime.createContextStore ?? createContextStore)();
        try {
          contextStore.add(backread.messages.map(({ id, ...message }) => ({
            ...message,
            messageId: id,
          })));
          const seededMessageIds = new Set(contextStore.getState().messageIds);
          if (backread.messages.some(message => !seededMessageIds.has(message.id))) {
            throw new Error('One or more Backread messages were not retained.');
          }
        } catch {
          throw new Error('Unable to seed historical message context.');
        }
        writeBackreadResult(backread, writeOutput);
        writeOutput(formatTerminalMilestone(
          'CONTEXT',
          `Historical context seeded: ${contextStore.getState().size} messages.`,
        ));

        if (ENABLE_DEBUG_AUTO_RESPONSE) {
          let reply: string | undefined;
          const debugIdentity = {
            name: configurationResult.configuration.puppetName ?? '',
            aliases: aliasData.valids,
          };
          const debugSystemInstruction = composeProductionSystemInstruction({
            identity: debugIdentity,
            personalityMode: resolveBotPersonalityMode(configurationResult.configuration),
            customPersonalityInstruction:
              configurationResult.configuration.customPersonalityInstruction,
            roster: groupRoster,
          });
          try {
            reply = await (runtime.generateNvidiaReply ?? generateNvidiaReply)(
              apiKey,
              backread.messages,
              {
                systemInstruction: debugSystemInstruction,
                identity: debugIdentity,
                roster: groupRoster,
              },
            );
          } catch (error) {
            writeError(getSafeNvidiaError(error, 'Unable to generate a Messenger reply.'));
          }
          if (reply !== undefined) {
            writeOutput('Generated reply; checking the composer before automatic send.');
            try {
              const composition: ReplyCompositionResult = await (
                runtime.composeMessengerReply ?? composeMessengerReply
              )(preparationResult.page, reply);
              if (composition.status === 'sent') {
                writeOutput('Send control clicked; delivery is not confirmed.');
              } else {
                const failures: Record<typeof composition.reason, string> = {
                  'composer-region-missing': 'the Thread composer region was not found',
                  'composer-region-ambiguous': 'the Thread composer region was not unique',
                  'send-control-missing': 'the matching Send control was not found',
                  'send-control-ambiguous': 'the matching Send control was not unique',
                  hidden: 'the matching Send control was hidden',
                  disabled: 'the matching Send control was disabled',
                  'payload-too-long': 'the reply exceeded the configured character maximum',
                };
                writeError(`Automatic send blocked; ${failures[composition.reason]}. The reply remains unsent.`);
              }
            } catch (error) {
              writeError(`Unable to prepare the Messenger reply: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        startupStage = 'combustion';
        combustionController = await (runtime.startCombustion ?? startCombustion)({
          page: preparationResult.page,
          contextStore,
          configuration: configurationResult.configuration,
          aliases: aliasData.valids,
          apiKey,
          debugMode: DEBUG_MODE,
          roster: groupRoster,
        });
        runtimeControl.setState('running');
        writeOutput(formatTerminalMilestone(
          'READY',
          `Engine ready at ${configurationResult.configuration.messageDestination}.`,
        ));
        if (useDashboard) {
          try {
            dashboardSession = await (runtime.startDashboard ?? startDashboard)({
              configurationFilePath,
              requestStatus: runtime.requestRuntimeStatusSnapshot ?? requestRuntimeStatusSnapshot,
              captureConsoleOutput: true,
              onInterrupt: onSigint,
              commands: {
                pause: () => (runtime.requestRuntimePause ?? requestRuntimePause)(
                  configurationFilePath,
                ),
                resume: () => (runtime.requestRuntimeResume ?? requestRuntimeResume)(
                  configurationFilePath,
                ),
                stop: () => (runtime.requestRuntimeStop ?? requestRuntimeStop)(
                  configurationFilePath,
                ),
                changeDestination: destination =>
                  (runtime.requestRuntimeChangeDestination ?? requestRuntimeChangeDestination)(
                    configurationFilePath,
                    destination,
                  ),
                setTemperament: temperament =>
                  (runtime.requestRuntimeSetTemperament ?? requestRuntimeSetTemperament)(
                    configurationFilePath,
                    temperament,
                  ),
                setPersonality: (mode, instruction) =>
                  (runtime.requestRuntimeSetPersonality ?? requestRuntimeSetPersonality)(
                    configurationFilePath,
                    mode,
                    instruction,
                  ),
              },
            });
          } catch (error) {
            writeError(
              'Unable to open the terminal dashboard: ' +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const engineSession = session;
        const engineCombustion = combustionController;
        const waitForEngine = () => Promise.race([
          shutdownPromise.then(source => ({ type: 'shutdown' as const, source })),
          engineSession.disconnected.then(() => 'disconnected' as const),
          engineCombustion.stopped.then(() => 'combustion-stopped' as const),
        ]);
        const dashboardClosed = dashboardSession?.closed.then(
          () => ({ type: 'dashboard-closed' as const }),
        );
        let runtimeResult = dashboardClosed === undefined
          ? await waitForEngine()
          : await Promise.race([waitForEngine(), dashboardClosed]);
        if (typeof runtimeResult === 'object' && runtimeResult.type === 'dashboard-closed') {
          runtimeResult = await waitForEngine();
        }
        if (typeof runtimeResult === 'object' && runtimeResult.type === 'shutdown') {
          writeOutput('Shutdown requested; disconnecting Playwright.');
          exitCode = runtimeResult.source === 'runtime-control' ? 0 : 130;
        } else if (runtimeResult === 'combustion-stopped') {
          throw new Error('Combustion stopped unexpectedly.');
        } else {
          throw new Error('The browser disconnected unexpectedly while the engine was running.');
        }
      }
    }
  } catch (error) {
    const action = startupStage === 'launch'
      ? 'start browser'
      : startupStage === 'prepare'
        ? 'prepare browser'
        : startupStage === 'cranking'
          ? 'crank engine'
          : 'start Combustion';
    writeError(`Unable to ${action}: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (dashboardSession) {
      try {
        await dashboardSession.close();
      } catch (error) {
        writeError(
          `Unable to close the terminal dashboard: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        exitCode = 1;
      }
    }
    runtimeControl.setState('stopping');
    if (combustionController) {
      try {
        await combustionController.stop();
      } catch (error) {
        writeError(`Unable to stop Combustion: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
    }
    if (session) {
      try {
        await session.disconnect();
      } catch (error) {
        writeError(`Unable to disconnect Playwright: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
      try {
        await (runtime.closeBrowser ?? closeConfiguredBrowser)(configurationResult.configuration);
      } catch (error) {
        writeError(`Unable to close the configured browser: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
    }
    runtimeControl.complete(exitCode);
    try {
      await runtimeControl.close();
    } catch (error) {
      writeError(`Unable to release runtime ownership: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

async function handleUpdateKey(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  runtime: CliRuntimeOptions,
): Promise<number> {
  let runtimeStatus: RuntimeStatusResult;
  try {
    runtimeStatus = await (runtime.requestRuntimeStatus ?? requestRuntimeStatus)(configurationFilePath);
  } catch (error) {
    writeError(
      'Unable to check whether impractical-bot is running: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (runtimeStatus.status === 'running') {
    writeError(
      'An impractical-bot engine is running for this configuration and would keep using the ' +
      'current NVIDIA API key. Run `impbot stop`, then run `impbot updatekey`, then restart ' +
      'impractical-bot. The NVIDIA API key was not changed.',
    );
    return 1;
  }

  let apiKey: string | null;
  try {
    apiKey = await (runtime.promptSecret ?? promptSecretTerminal)('Enter the replacement NVIDIA API key: ');
  } catch {
    writeError('Unable to read the NVIDIA API key using hidden input.');
    return 1;
  }
  if (apiKey === null) {
    writeOutput('NVIDIA API key update cancelled.');
    return 0;
  }

  const normalizedKey = apiKey.trim();
  try {
    await (runtime.validateNvidiaApiKey ?? validateNvidiaApiKey)(normalizedKey);
  } catch (error) {
    writeError(getSafeNvidiaError(error, 'Unable to validate the replacement NVIDIA API key.'));
    return 1;
  }

  try {
    saveNvidiaApiKey(resolveNvidiaEnvironmentPath(configurationFilePath), normalizedKey);
  } catch {
    writeError('Unable to save the replacement NVIDIA API key. The previous key was preserved.');
    return 1;
  }
  writeOutput('NVIDIA API key updated.');
  return 0;
}

async function handlePause(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  runtime: CliRuntimeOptions,
): Promise<number> {
  try {
    const result = await (runtime.requestRuntimePause ?? requestRuntimePause)(
      configurationFilePath,
    );
    if (result.status === 'not-running') {
      writeOutput('No impractical-bot engine is running for this configuration.');
      return 0;
    }
    writeOutput(`Engine ${result.instanceId} paused.`);
    return 0;
  } catch (error) {
    writeError(`Unable to pause impractical-bot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function handleResume(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  runtime: CliRuntimeOptions,
): Promise<number> {
  try {
    const result = await (runtime.requestRuntimeResume ?? requestRuntimeResume)(
      configurationFilePath,
    );
    if (result.status === 'not-running') {
      writeOutput('No impractical-bot engine is running for this configuration.');
      return 0;
    }
    writeOutput(`Engine ${result.instanceId} resumed.`);
    return 0;
  } catch (error) {
    writeError(`Unable to resume impractical-bot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function handleStop(
  writeOutput: Output,
  writeError: Output,
  configurationFilePath: string | undefined,
  runtime: CliRuntimeOptions,
): Promise<number> {
  try {
    const result = await (runtime.requestRuntimeStop ?? requestRuntimeStop)(configurationFilePath);
    if (result.status === 'not-running') {
      writeOutput('No impractical-bot engine is running for this configuration.');
      return 0;
    }
    writeOutput(`Engine ${result.instanceId} stopped gracefully.`);
    return 0;
  } catch (error) {
    writeError(`Unable to stop impractical-bot: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof RuntimeControlTimeoutError) {
      writeOutput(
        'The engine may have stopped even though it did not respond. Check that its window has ' +
        'exited before running `impbot stop` again.',
      );
    }
    return 1;
  }
}

function getVersion(): string {
  const packagePath = resolve(__dirname, '../../package.json');
  const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version: string;
  };
  return packageMetadata.version;
}

export async function runCli(
  args: string[],
  writeOutput: Output = message => console.log(message),
  writeError: Output = message => console.error(message),
  configurationFilePath?: string,
  prompt: TerminalPrompt = promptTerminal,
  initialize: (options: InitializationOptions) => Promise<InitializationStatus> = initializeConfiguration,
  runtime: CliRuntimeOptions = {},
): Promise<number> {
  const [command, ...remainingArgs] = args;

  if (args.length === 0 || args.length === 1 && (command === '--help' || command === '-h')) {
    writeOutput(usage);
    return 0;
  }

  if (args.length === 1 && (command === '--version' || command === '-v')) {
    writeOutput(getVersion());
    return 0;
  }

  const debug = command === 'start' && remainingArgs[0] === '--debug';
  const acceptsArguments = command === 'setcomposerslicer';
  const unexpectedArgs = debug ? remainingArgs.slice(1) : remainingArgs;
  if (!acceptsArguments && unexpectedArgs.length > 0) {
    writeError(`Error: unexpected argument '${unexpectedArgs[0]}'.\n\n${usage}`);
    return 1;
  }

  const handlers: Record<string, () => number | Promise<number>> = {
    init: () => handleInit(writeOutput, writeError, configurationFilePath, prompt, initialize, runtime),
    config: () => handleConfig(writeOutput, writeError, configurationFilePath),
    changebrowser: () => handleChangeBrowser(
      writeOutput,
      writeError,
      configurationFilePath,
      prompt,
      runtime,
    ),
    changemsgUrl: () => handleChangeMsgUrl(
      writeOutput,
      writeError,
      configurationFilePath,
      prompt,
      runtime,
    ),
    setbottemp: () => handleSetBotTemperament(
      writeOutput,
      writeError,
      configurationFilePath,
      prompt,
      runtime,
    ),
    setpersonality: () => handleSetPersonality(
      writeOutput,
      writeError,
      configurationFilePath,
      prompt,
      runtime,
    ),
    setcomposerslicer: () => handleSetComposerSlicer(
      writeOutput,
      writeError,
      configurationFilePath,
      remainingArgs,
      prompt,
      runtime,
    ),
    updatekey: () => handleUpdateKey(writeOutput, writeError, configurationFilePath, runtime),
    start: () => handleStart(writeOutput, writeError, configurationFilePath, runtime, debug),
    pause: () => handlePause(writeOutput, writeError, configurationFilePath, runtime),
    resume: () => handleResume(writeOutput, writeError, configurationFilePath, runtime),
    stop: () => handleStop(writeOutput, writeError, configurationFilePath, runtime),
  };
  const handler = command ? handlers[command] : undefined;

  if (!handler) {
    writeError(`Error: unknown command '${command}'.\n\n${usage}`);
    return 1;
  }

  return await handler();
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    exitCode => {
      process.exitCode = exitCode;
    },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}