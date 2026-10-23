#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
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
  promptPinRestorationSettings,
  selectBrowserCandidate,
  type InitializationOptions,
  type InitializationStatus,
  type TerminalPrompt,
} from './browser/initialization.js';
import {
  closeConfiguredBrowser,
  launchConfiguredBrowser,
  navigateConfiguredBrowserToMessageDestination,
  type BrowserLaunchSession,
} from './browser/launch.js';
import {
  discoverBrowsers,
  validateBrowserExecutablePath,
  type BrowserCandidate,
  type BrowserDiscoveryOptions,
} from './browser/discovery.js';
import {
  loadConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
  validateConfiguration,
  type Configuration,
} from './config/configuration.js';
import {
  composeMessengerReply,
  type ReplyCompositionResult,
} from './messages/composer.js';
import {
  readMessengerMessages,
  type BackreadResult,
} from './messages/backread.js';

type Output = (message: string) => void;

export interface CliRuntimeOptions {
  launchBrowser?: (configuration: Configuration) => Promise<BrowserLaunchSession>;
  promptSecret?: TerminalPrompt;
  validateNvidiaApiKey?: (apiKey: string) => Promise<void>;
  readMessengerMessages?: typeof readMessengerMessages;
  generateNvidiaReply?: typeof generateNvidiaReply;
  composeMessengerReply?: typeof composeMessengerReply;
  waitForShutdown?: () => Promise<void>;
  closeBrowser?: (configuration: Configuration) => Promise<void>;
  navigateMessageDestination?: (
    configuration: Configuration,
    destination: string,
  ) => Promise<void>;
  discoverBrowsers?: (options?: BrowserDiscoveryOptions) => Promise<BrowserCandidate[]>;
  browserExecutableExists?: (path: string) => boolean;
}

const usage = `Usage: impbot <command>

Commands:
  init     Initialize impractical-bot
  config   Configure impractical-bot
  changebrowser  Change the configured browser
  changemessagedestination  Change the message destination
  updatekey  Replace the NVIDIA API key
  start    Start impractical-bot
  stop     Stop impractical-bot

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

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
        // The prompt result must not include or expose the submitted value.
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
    writeOutput(diagnostic);
  }
  writeOutput(`Retrieved ${result.messages.length} messages; expected 30.`);
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
  ].join('\n'));
  return 0;
}

async function handleChangeBrowser(
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

  const currentConfiguration = configurationResult.configuration;
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

  try {
    await (runtime.closeBrowser ?? closeConfiguredBrowser)(currentConfiguration);
  } catch (error) {
    writeError(`Unable to close the current browser: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
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

async function handleChangeMessageDestination(
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

  try {
    await (runtime.navigateMessageDestination ?? navigateConfiguredBrowserToMessageDestination)(
      configuration,
      messageDestination,
    );
  } catch (error) {
    writeError(`Unable to change message destination: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    saveConfiguration({ ...configuration, messageDestination }, configurationFilePath);
  } catch (error) {
    writeError(`Unable to save message destination: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  writeOutput(`Message destination saved: ${messageDestination}.`);
  return 0;
}

async function handleStart(
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

  const DEBUG_MODE = process.env.IMPRACTICAL_BOT_DEBUG === '1';
  const ENABLE_DEBUG_AUTO_RESPONSE = false;
  let apiKey = '';
  if (!DEBUG_MODE || ENABLE_DEBUG_AUTO_RESPONSE) {
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
    try {
      await (runtime.validateNvidiaApiKey ?? validateNvidiaApiKey)(apiKey);
    } catch (error) {
      writeError(getSafeNvidiaError(error, 'Unable to validate the NVIDIA API key.'));
      return 1;
    }
    writeOutput('NVIDIA API key validated successfully.');
  } else {
    writeOutput('Debug mode enabled; skipping NVIDIA API key validation.');
  }

  let resolveSigint!: () => void;
  const sigintPromise = new Promise<void>(resolve => {
    resolveSigint = resolve;
  });
  const onSigint = (): void => resolveSigint();
  process.once('SIGINT', onSigint);
  const shutdownPromise = runtime.waitForShutdown
    ? Promise.race([sigintPromise, Promise.resolve().then(() => runtime.waitForShutdown!())])
    : sigintPromise;
  let session: BrowserLaunchSession | undefined;
  let exitCode = 0;
  let startupStage: 'launch' | 'prepare' = 'launch';

  try {
    const launchPromise = (runtime.launchBrowser ?? launchConfiguredBrowser)(configurationResult.configuration);
    const launchResult = await Promise.race([
      launchPromise.then(
        launchedSession => ({ type: 'launched' as const, session: launchedSession }),
        error => ({ type: 'failed' as const, error }),
      ),
      shutdownPromise.then(() => ({ type: 'shutdown' as const })),
    ]);
    if (launchResult.type === 'failed') {
      writeError(`Unable to start browser: ${launchResult.error instanceof Error ? launchResult.error.message : String(launchResult.error)}`);
      exitCode = 1;
    } else if (launchResult.type === 'shutdown') {
      session = await launchPromise.catch(() => undefined);
      writeOutput('Shutdown requested; disconnecting Playwright.');
      exitCode = 130;
    } else {
      session = launchResult.session;
      startupStage = 'prepare';
      writeOutput(`Browser launched and connected (${session.browserVersion}).`);
      const preparationResult = await Promise.race([
        session.prepare().then(page => ({ type: 'ready' as const, page })),
        shutdownPromise.then(() => ({ type: 'shutdown' as const })),
        session.disconnected.then(() => ({ type: 'disconnected' as const })),
      ]);
      if (preparationResult.type === 'shutdown') {
        writeOutput('Shutdown requested; disconnecting Playwright.');
        exitCode = 130;
      } else if (preparationResult.type === 'disconnected') {
        throw new Error('The browser disconnected during startup preparation.');
      } else {
        writeOutput(`Engine ready at ${configurationResult.configuration.messageDestination}.`);
        try {
          if (await session.isWindowMinimized?.(preparationResult.page)) {
            writeOutput('WARNING: Browser is minimized. Backread may collect fewer messages than expected.');
          }
        } catch {
          writeError('Unable to detect browser window state.');
        }
        let backread: BackreadResult | undefined;
        try {
          backread = await (runtime.readMessengerMessages ?? readMessengerMessages)(
            preparationResult.page,
          );
          writeBackreadResult(backread, writeOutput);
        } catch {
          writeError('Unable to read Messenger messages.');
        }
        if (backread && ENABLE_DEBUG_AUTO_RESPONSE) {
          let reply: string | undefined;
          try {
            reply = await (runtime.generateNvidiaReply ?? generateNvidiaReply)(apiKey, backread.messages);
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
                };
                writeError(`Automatic send blocked; ${failures[composition.reason]}. The reply remains unsent.`);
              }
            } catch (error) {
              writeError(`Unable to prepare the Messenger reply: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        const runtimeResult = await Promise.race([
          shutdownPromise.then(() => 'shutdown' as const),
          session.disconnected.then(() => 'disconnected' as const),
        ]);
        if (runtimeResult === 'shutdown') {
          writeOutput('Shutdown requested; disconnecting Playwright.');
          exitCode = 130;
        } else {
          throw new Error('The browser disconnected unexpectedly while the engine was running.');
        }
      }
    }
  } catch (error) {
    const action = startupStage === 'launch' ? 'start browser' : 'prepare browser';
    writeError(`Unable to ${action}: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (session) {
      try {
        await session.disconnect();
      } catch (error) {
        writeError(`Unable to disconnect Playwright: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
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

async function handleStop(writeOutput: Output, writeError: Output): Promise<number> {
  writeError('No browser session is managed by this process; `start` leaves the browser running.');
  void writeOutput;
  return 1;
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

  if (remainingArgs.length > 0) {
    writeError(`Error: unexpected argument '${remainingArgs[0]}'.\n\n${usage}`);
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
    changemessagedestination: () => handleChangeMessageDestination(
      writeOutput,
      writeError,
      configurationFilePath,
      prompt,
      runtime,
    ),
    updatekey: () => handleUpdateKey(writeOutput, writeError, configurationFilePath, runtime),
    start: () => handleStart(writeOutput, writeError, configurationFilePath, prompt, runtime),
    stop: () => handleStop(writeOutput, writeError),
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