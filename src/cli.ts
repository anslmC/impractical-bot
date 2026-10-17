#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfiguration } from './config/configuration.js';

type Output = (message: string) => void;

const usage = `Usage: impbot <command>

Commands:
  init     Initialize impractical-bot
  config   Configure impractical-bot
  start    Start impractical-bot
  stop     Stop impractical-bot

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

function handleInit(writeError: Output): number {
  writeError(
    'Initialization is unavailable: browser discovery is not implemented. No configuration was written.',
  );
  return 1;
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

  const configuration = result.configuration;
  writeOutput([
    'Current configuration:',
    `  Version: ${configuration.version}`,
    `  Browser: ${configuration.browser}`,
    `  Executable: ${configuration.executablePath}`,
    `  Profile: ${configuration.profilePath}`,
    `  CDP port: ${configuration.cdpPort ?? 'not configured'}`,
  ].join('\n'));
  return 0;
}

function handleStart(writeOutput: Output): number {
  writeOutput('The start command is not implemented yet.');
  return 0;
}

function handleStop(writeOutput: Output): number {
  writeOutput('The stop command is not implemented yet.');
  return 0;
}

function getVersion(): string {
  const packagePath = resolve(__dirname, '../../package.json');
  const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version: string;
  };
  return packageMetadata.version;
}

export function runCli(
  args: string[],
  writeOutput: Output = message => console.log(message),
  writeError: Output = message => console.error(message),
  configurationFilePath?: string,
): number {
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

  const handlers: Record<string, () => number> = {
    init: () => handleInit(writeError),
    config: () => handleConfig(writeOutput, writeError, configurationFilePath),
    start: () => handleStart(writeOutput),
    stop: () => handleStop(writeOutput),
  };
  const handler = command ? handlers[command] : undefined;

  if (!handler) {
    writeError(`Error: unknown command '${command}'.\n\n${usage}`);
    return 1;
  }

  return handler();
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}