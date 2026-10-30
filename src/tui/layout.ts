import { formatCliCommand } from '../cli-commands.js';
import type { RuntimeEngineState } from '../runtime-control.js';
import {
  getDashboardCommandHints,
  personalityChoices,
  renderPromptInput,
  temperamentChoices,
  type DashboardNotice,
  type DashboardPrompt,
} from './commands.js';
import {
  formatDashboardLogLine,
  type DashboardLogEntry,
} from './logs.js';

export type DashboardConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'stopped'
  | 'unsupported';

export type DashboardEngineState = RuntimeEngineState | 'disconnected' | 'stopped';

export interface DashboardView {
  connection: DashboardConnectionState;
  state: DashboardEngineState;
  browser: string;
  temperament: string;
  personality: string;
  messengerDestination: string;
  logs?: readonly DashboardLogEntry[];
  prompt?: DashboardPrompt;
  notice?: DashboardNotice;
  pending?: boolean;
  commandsEnabled?: boolean;
}

export interface DashboardDimensions {
  columns: number;
  rows: number;
}

export const DASHBOARD_UNKNOWN_VALUE = 'Unknown';
export const DASHBOARD_EMPTY_LOGS_MESSAGE = 'Waiting for engine output...';

export function createInitialDashboardView(): DashboardView {
  return {
    connection: 'connecting',
    state: 'starting',
    browser: DASHBOARD_UNKNOWN_VALUE,
    temperament: DASHBOARD_UNKNOWN_VALUE,
    personality: DASHBOARD_UNKNOWN_VALUE,
    messengerDestination: DASHBOARD_UNKNOWN_VALUE,
    logs: [],
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function displayValue(value: string): string {
  return value.length > 0 ? value : DASHBOARD_UNKNOWN_VALUE;
}

function connectionLabel(view: DashboardView): string {
  switch (view.connection) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'stopped':
      return 'Stopped';
    case 'unsupported':
      return 'Status unavailable';
    case 'disconnected':
      return 'Disconnected';
  }
}

function stateLabel(view: DashboardView): string {
  if (view.connection === 'connected') {
    return capitalize(view.state);
  }
  if (view.connection === 'connecting') {
    return 'Starting';
  }
  return connectionLabel(view);
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

function pad(text: string, width: number): string {
  const bounded = truncate(text, width);
  return bounded + ' '.repeat(Math.max(0, width - bounded.length));
}

function center(text: string, width: number): string {
  const bounded = truncate(text, width);
  const left = Math.max(0, Math.floor((width - bounded.length) / 2));
  return ' '.repeat(left) + bounded + ' '.repeat(Math.max(0, width - bounded.length - left));
}

function borderTitle(title: string, width: number): string {
  const label = ` ${title} `;
  if (width <= label.length) {
    return `┌${'─'.repeat(Math.max(0, width - 2))}┐`;
  }
  const remaining = width - label.length - 2;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `┌${'─'.repeat(left)}${label}${'─'.repeat(right)}┐`;
}

function boxedLine(content: string, width: number): string {
  return `│${pad(content, width)}│`;
}

function renderCommands(view: DashboardView, width: number): string[] {
  const lines = ['COMMANDS'];
  for (const hint of getDashboardCommandHints(view)) {
    lines.push(truncate(`[${hint.key}] ${formatCliCommand(hint)}`, width));
  }
  if (view.prompt === undefined) {
    lines.push('[C] Close dashboard');
  }
  return lines;
}

function noticePrefix(notice: DashboardNotice): string {
  switch (notice.tone) {
    case 'pending':
      return 'Pending: ';
    case 'success':
      return '';
    case 'error':
      return 'Error: ';
    case 'info':
      return '';
  }
}

function promptErrorLines(prompt: DashboardPrompt, width: number): string[] {
  if (!('error' in prompt) || prompt.error === undefined) {
    return [];
  }
  return [truncate(`Error: ${prompt.error}`, width)];
}

function promptFooterLines(prompt: DashboardPrompt, width: number): string[] {
  switch (prompt.kind) {
    case 'destination':
      return [
        truncate(renderPromptInput('Destination URL: ', prompt.value, width).text, width),
        truncate('[Enter] Apply  [Esc] Cancel', width),
        ...promptErrorLines(prompt, width),
      ];
    case 'temperament':
      return [
        'Select temperament:',
        truncate(temperamentChoices(), width),
        truncate('[Esc] Cancel', width),
      ];
    case 'personality':
      return [
        'Select personality:',
        truncate(personalityChoices(), width),
        truncate('[Esc] Cancel', width),
      ];
    case 'personalityInstruction':
      return [
        truncate(
          renderPromptInput('Personality instruction: ', prompt.value, width).text,
          width,
        ),
        truncate('[Enter] Apply  [Esc] Cancel', width),
        ...promptErrorLines(prompt, width),
      ];
    case 'stopConfirmation':
      return [
        'Stop Impractical Bot?',
        truncate('[Y] Confirm  [Esc/N] Cancel', width),
      ];
  }
}

function footerLines(view: DashboardView, width: number): string[] {
  if (view.prompt !== undefined) {
    return promptFooterLines(view.prompt, width)
      .map(line => truncate(line, width));
  }
  const status = `Status: ${connectionLabel(view)}`;
  if (view.notice === undefined) {
    return [truncate(status, width)];
  }
  return [truncate(`${status}  |  ${noticePrefix(view.notice)}${view.notice.message}`, width)];
}

function renderLogLines(
  entries: readonly DashboardLogEntry[],
  width: number,
  capacity: number,
): string[] {
  if (capacity <= 0) {
    return [];
  }
  const lines = entries.length === 0
    ? [truncate(DASHBOARD_EMPTY_LOGS_MESSAGE, width)]
    : entries
      .slice(-capacity)
      .map(entry => formatDashboardLogLine(entry, width));
  while (lines.length < capacity) {
    lines.push('');
  }
  return lines.slice(0, capacity);
}

function bodyLines(view: DashboardView, width: number, available: number): string[] {
  const separator = '─'.repeat(width);
  const engineLines = [
    'ENGINE',
    truncate(`State:       ${capitalize(view.state)}`, width),
    truncate(`Browser:     ${displayValue(view.browser)}`, width),
    truncate(`Temperament: ${capitalize(displayValue(view.temperament))}`, width),
    truncate(`Personality: ${capitalize(displayValue(view.personality))}`, width),
    truncate(`Destination: ${displayValue(view.messengerDestination)}`, width),
  ];
  const commandLines = renderCommands(view, width);
  const footer = footerLines(view, width);
  const fixedLines = [
    ...engineLines,
    separator,
    ...commandLines,
    separator,
    ...footer,
  ];

  const logCapacity = available - fixedLines.length - 2;
  if (logCapacity >= 1) {
    return [
      ...engineLines,
      separator,
      ...commandLines,
      separator,
      'LIVE LOGS',
      ...renderLogLines(view.logs ?? [], width, logCapacity),
      separator,
      ...footer,
    ];
  }

  return fitBody(fixedLines, available);
}

function plainLines(view: DashboardView, width: number, rows: number): string[] {
  const engineLines = [
    truncate(`State: ${capitalize(view.state)}`, width),
    truncate(`Browser: ${displayValue(view.browser)}`, width),
    truncate(`Temperament: ${capitalize(view.temperament)}`, width),
    truncate(`Personality: ${capitalize(view.personality)}`, width),
    truncate(`Destination: ${displayValue(view.messengerDestination)}`, width),
  ];
  const commandLines = renderCommands(view, width);
  const footer = footerLines(view, width);
  const fixedLines = [
    center('IMPRACTICAL BOT', width),
    center(stateLabel(view), width),
    ...engineLines,
    ...commandLines,
    ...footer,
  ];
  const logCapacity = rows - fixedLines.length - 1;
  if (logCapacity < 1) {
    return fixedLines.slice(0, Math.max(0, rows));
  }
  const lines = [
    center('IMPRACTICAL BOT', width),
    center(stateLabel(view), width),
    ...engineLines,
    ...commandLines,
    'LIVE LOGS',
    ...renderLogLines(view.logs ?? [], width, logCapacity),
    ...footer,
  ];
  return lines.slice(0, Math.max(0, rows));
}

function fitBody(lines: string[], available: number): string[] {
  if (available <= 0) {
    return [];
  }
  if (lines.length === available) {
    return lines;
  }
  if (lines.length < available) {
    if (available === 1) {
      return [lines[0]];
    }
    return [
      ...lines.slice(0, -1),
      ...Array<string>(available - lines.length).fill(''),
      lines[lines.length - 1],
    ];
  }
  if (available === 1) {
    return [lines[0]];
  }
  const status = lines[lines.length - 1];
  return [...lines.slice(0, available - 1), status];
}

export interface DashboardCursorPosition {
  readonly row: number;
  readonly column: number;
}

function promptInput(
  prompt: DashboardPrompt,
): { prefix: string; value: string } | undefined {
  switch (prompt.kind) {
    case 'destination':
      return { prefix: 'Destination URL: ', value: prompt.value };
    case 'personalityInstruction':
      return { prefix: 'Personality instruction: ', value: prompt.value };
    default:
      return undefined;
  }
}

export function getDashboardPromptCursor(
  view: DashboardView,
  dimensions: DashboardDimensions,
): DashboardCursorPosition | undefined {
  if (view.prompt === undefined) {
    return undefined;
  }
  const input = promptInput(view.prompt);
  if (input === undefined) {
    return undefined;
  }

  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return undefined;
  }

  const plain = columns < 12 || rows < 6;
  const contentWidth = plain ? columns : columns - 2;
  const footer = footerLines(view, contentWidth);
  const promptLineIndex = 0;
  const rendered = renderPromptInput(input.prefix, input.value, contentWidth);

  if (plain) {
    return {
      row: Math.max(1, rows - footer.length + promptLineIndex + 1),
      column: Math.min(columns, Math.max(1, 1 + rendered.cursorOffset)),
    };
  }
  return {
    row: Math.max(1, rows - footer.length + promptLineIndex),
    column: Math.min(columns, Math.max(2, 2 + rendered.cursorOffset)),
  };
}

export function renderDashboardLines(
  view: DashboardView,
  dimensions: DashboardDimensions,
): string[] {
  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return [];
  }

  if (columns < 12 || rows < 6) {
    return plainLines(view, columns, rows);
  }

  const innerWidth = columns - 2;
  const body = bodyLines(view, innerWidth, rows - 2);
  return [
    borderTitle('IMPRACTICAL BOT', columns),
    ...body.map(line => boxedLine(line, innerWidth)),
    `└${'─'.repeat(innerWidth)}┘`,
  ];
}

export function renderDashboard(
  view: DashboardView,
  dimensions: DashboardDimensions,
): string {
  return renderDashboardLines(view, dimensions).join('\n');
}
