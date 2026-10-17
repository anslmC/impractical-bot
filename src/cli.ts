#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function handleInit(writeOutput: Output): void {
  writeOutput('The init command is not implemented yet.');
}

function handleConfig(writeOutput: Output): void {
  writeOutput('The config command is not implemented yet.');
}

function handleStart(writeOutput: Output): void {
  writeOutput('The start command is not implemented yet.');
}

function handleStop(writeOutput: Output): void {
  writeOutput('The stop command is not implemented yet.');
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

  const handlers: Record<string, (output: Output) => void> = {
    init: handleInit,
    config: handleConfig,
    start: handleStart,
    stop: handleStop,
  };
  const handler = command ? handlers[command] : undefined;

  if (!handler) {
    writeError(`Error: unknown command '${command}'.\n\n${usage}`);
    return 1;
  }

  handler(writeOutput);
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}