import {
  BOT_PERSONALITY_MODES,
  BOT_TEMPERAMENTS,
  MAX_PERSONALITY_INSTRUCTION_CHARS,
  isHttpOrHttpsUrl,
  type BotPersonalityMode,
  type BotTemperament,
} from '../config/configuration.js';
import { RUNNING_ENGINE_COMMANDS, type CliCommandDefinition } from '../cli-commands.js';
import type {
  RuntimeChangeDestinationResult,
  RuntimePauseResult,
  RuntimeResumeResult,
  RuntimeSetPersonalityResult,
  RuntimeSetTemperamentResult,
  RuntimeStopResult,
} from '../runtime-control.js';

export interface DashboardCommandApi {
  pause(): Promise<RuntimePauseResult>;
  resume(): Promise<RuntimeResumeResult>;
  stop(): Promise<RuntimeStopResult>;
  changeDestination(destination: string): Promise<RuntimeChangeDestinationResult>;
  setTemperament(temperament: BotTemperament): Promise<RuntimeSetTemperamentResult>;
  setPersonality(
    mode: BotPersonalityMode,
    instruction: string,
  ): Promise<RuntimeSetPersonalityResult>;
}

export type DashboardCommandKey = 'P' | 'R' | 'M' | 'T' | 'Y' | 'S';

export interface DashboardCommandHint extends CliCommandDefinition {
  readonly key: DashboardCommandKey;
}

export type DashboardPrompt =
  | { kind: 'destination'; value: string; error?: string }
  | { kind: 'temperament' }
  | { kind: 'personality' }
  | { kind: 'personalityInstruction'; value: string; error?: string }
  | { kind: 'stopConfirmation' };

export type DashboardNoticeTone = 'pending' | 'success' | 'error' | 'info';

export interface DashboardNotice {
  readonly tone: DashboardNoticeTone;
  readonly message: string;
  readonly transient: boolean;
}

export interface DashboardCommandAvailability {
  connection: 'connecting' | 'connected' | 'disconnected' | 'stopped' | 'unsupported';
  state:
    | 'starting'
    | 'running'
    | 'paused'
    | 'changing'
    | 'stopping'
    | 'disconnected'
    | 'stopped';
  pending?: boolean;
  prompt?: DashboardPrompt;
  commandsEnabled?: boolean;
}

const COMMAND_KEYS: ReadonlyArray<{ key: DashboardCommandKey; name: string }> = [
  { key: 'P', name: 'pause' },
  { key: 'R', name: 'resume' },
  { key: 'M', name: 'changemsgUrl' },
  { key: 'T', name: 'setbottemp' },
  { key: 'Y', name: 'setpersonality' },
  { key: 'S', name: 'stop' },
];

const COMMAND_DEFINITIONS = new Map(
  RUNNING_ENGINE_COMMANDS.map(command => [command.name, command]),
);

function commandHint(name: string, key: DashboardCommandKey): DashboardCommandHint | undefined {
  const definition = COMMAND_DEFINITIONS.get(name);
  return definition === undefined ? undefined : { ...definition, key };
}

export function getDashboardCommandHints(
  view: DashboardCommandAvailability,
): DashboardCommandHint[] {
  if (
    view.connection !== 'connected' ||
    view.commandsEnabled === false ||
    view.pending === true ||
    view.prompt !== undefined
  ) {
    return [];
  }
  if (view.state !== 'running' && view.state !== 'paused') {
    return [];
  }

  const hints: DashboardCommandHint[] = [];
  for (const command of COMMAND_KEYS) {
    if (command.name === 'pause' && view.state !== 'running') {
      continue;
    }
    if (command.name === 'resume' && view.state !== 'paused') {
      continue;
    }
    const hint = commandHint(command.name, command.key);
    if (hint !== undefined) {
      hints.push(hint);
    }
  }
  return hints;
}

export function isDashboardCommandAvailable(
  view: DashboardCommandAvailability,
  key: string,
): boolean {
  return getDashboardCommandHints(view).some(hint => hint.key === key.toUpperCase());
}

const TEMPERAMENT_LABELS: Readonly<Record<BotTemperament, string>> = {
  quiet: 'Quiet',
  balanced: 'Balanced',
  talkative: 'Talkative',
};

const PERSONALITY_LABELS: Readonly<Record<BotPersonalityMode, string>> = {
  default: 'Default',
  custom: 'Custom',
};

export function temperamentLabel(temperament: BotTemperament): string {
  return TEMPERAMENT_LABELS[temperament];
}

export function personalityLabel(mode: BotPersonalityMode): string {
  return PERSONALITY_LABELS[mode];
}

export function temperamentForSelection(selection: string): BotTemperament | undefined {
  return BOT_TEMPERAMENTS[Number(selection) - 1];
}

export function personalityForSelection(selection: string): BotPersonalityMode | undefined {
  return BOT_PERSONALITY_MODES[Number(selection) - 1];
}

export function temperamentChoices(): string {
  return BOT_TEMPERAMENTS
    .map((temperament, index) => `[${index + 1}] ${TEMPERAMENT_LABELS[temperament]}`)
    .join('  ');
}

export function personalityChoices(): string {
  return BOT_PERSONALITY_MODES
    .map((mode, index) => `[${index + 1}] ${PERSONALITY_LABELS[mode]}`)
    .join('  ');
}

export function maximumPersonalityInstructionLength(): number {
  return MAX_PERSONALITY_INSTRUCTION_CHARS;
}

export type DestinationValidation =
  | { ok: true; value: string }
  | { ok: false; message: string };

export function validateDestinationInput(value: string): DestinationValidation {
  const destination = value.trim();
  if (destination.length === 0 || !isHttpOrHttpsUrl(destination)) {
    return {
      ok: false,
      message: 'Enter a valid HTTP or HTTPS URL.',
    };
  }
  return { ok: true, value: destination };
}

export interface PromptInputRender {
  readonly text: string;
  readonly cursorOffset: number;
}

function truncate(text: string, maximum: number): string {
  if (maximum <= 0) {
    return '';
  }
  if (text.length <= maximum) {
    return text;
  }
  if (maximum === 1) {
    return '…';
  }
  return `${text.slice(0, maximum - 1)}…`;
}

export function renderPromptInput(
  prefix: string,
  value: string,
  maximumWidth: number,
): PromptInputRender {
  const width = Math.max(0, Math.floor(maximumWidth));
  if (width === 0) {
    return { text: '', cursorOffset: 0 };
  }
  if (prefix.length >= width) {
    const text = truncate(prefix, width);
    return { text, cursorOffset: text.length };
  }

  const available = width - prefix.length;
  if (value.length <= available) {
    return {
      text: prefix + value,
      cursorOffset: prefix.length + value.length,
    };
  }
  if (available === 1) {
    return { text: prefix + '…', cursorOffset: width };
  }
  return {
    text: prefix + '…' + value.slice(-(available - 1)),
    cursorOffset: width,
  };
}
