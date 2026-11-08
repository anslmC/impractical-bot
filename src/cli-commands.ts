export interface CliCommandDefinition {
  readonly name: string;
  readonly description: string;
}

export const CLI_COMMAND_NAME_WIDTH = 18;

export const CLI_COMMANDS: readonly CliCommandDefinition[] = [
  { name: 'init', description: 'Initialize Impractical Bot' },
  { name: 'config', description: 'Configure Impractical Bot' },
  { name: 'changebrowser', description: 'Change the configured browser' },
  { name: 'changemsgUrl', description: 'Change Messenger destination' },
  { name: 'setbottemp', description: 'Set bot temperament' },
  { name: 'setpersonality', description: 'Set bot personality' },
  { name: 'setcomposerslicer', description: 'Configure Composer Slicer' },
  { name: 'updatekey', description: 'Replace the NVIDIA API key' },
  { name: 'start', description: 'Start Impractical Bot' },
  { name: 'pause', description: 'Pause Impractical Bot' },
  { name: 'resume', description: 'Resume Impractical Bot' },
  { name: 'stop', description: 'Stop Impractical Bot' },
];

const RUNNING_ENGINE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'changemsgUrl',
  'setbottemp',
  'setpersonality',
  'pause',
  'resume',
  'stop',
]);

export const RUNNING_ENGINE_COMMANDS: readonly CliCommandDefinition[] =
  CLI_COMMANDS.filter(command => RUNNING_ENGINE_COMMAND_NAMES.has(command.name));
