import { RUNNING_ENGINE_COMMANDS, formatCliCommand } from '../cli-commands.js';
import type { RuntimeEngineState } from '../runtime-control.js';
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

function renderCommands(width: number): string[] {
  return RUNNING_ENGINE_COMMANDS.map(command => truncate(formatCliCommand(command), width));
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
  const commandLines = [
    'COMMANDS',
    ...renderCommands(width),
    '[C] Close dashboard',
  ];
  const statusLine = `Status: ${connectionLabel(view)}`;
  const fixedLines = [
    ...engineLines,
    separator,
    ...commandLines,
    separator,
    statusLine,
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
      statusLine,
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
  const commandLines = [
    'COMMANDS',
    ...renderCommands(width),
    '[C] Close dashboard',
  ];
  const statusLine = truncate(`Status: ${connectionLabel(view)}`, width);
  const fixedLines = [
    center('IMPRACTICAL BOT', width),
    center(stateLabel(view), width),
    ...engineLines,
    ...commandLines,
    statusLine,
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
    statusLine,
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
