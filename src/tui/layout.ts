import { RUNNING_ENGINE_COMMANDS, formatCliCommand } from '../cli-commands.js';
import type { RuntimeEngineState } from '../runtime-control.js';

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
}

export interface DashboardDimensions {
  columns: number;
  rows: number;
}

export const DASHBOARD_UNKNOWN_VALUE = 'Unknown';

export function createInitialDashboardView(): DashboardView {
  return {
    connection: 'connecting',
    state: 'starting',
    browser: DASHBOARD_UNKNOWN_VALUE,
    temperament: DASHBOARD_UNKNOWN_VALUE,
    personality: DASHBOARD_UNKNOWN_VALUE,
    messengerDestination: DASHBOARD_UNKNOWN_VALUE,
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

function bodyLines(view: DashboardView, width: number): string[] {
  const separator = '─'.repeat(width);
  return [
    'ENGINE',
    truncate(`State:       ${capitalize(view.state)}`, width),
    truncate(`Browser:     ${displayValue(view.browser)}`, width),
    truncate(`Temperament: ${capitalize(displayValue(view.temperament))}`, width),
    truncate(`Personality: ${capitalize(displayValue(view.personality))}`, width),
    truncate(`Destination: ${displayValue(view.messengerDestination)}`, width),
    separator,
    'COMMANDS',
    ...renderCommands(width),
    '[C] Close dashboard',
    separator,
    `Status: ${connectionLabel(view)}`,
  ];
}

function plainLines(view: DashboardView, width: number): string[] {
  return [
    center('IMPRACTICAL BOT', width),
    center(stateLabel(view), width),
    truncate(`State: ${capitalize(view.state)}`, width),
    truncate(`Browser: ${displayValue(view.browser)}`, width),
    truncate(`Temperament: ${capitalize(displayValue(view.temperament))}`, width),
    truncate(`Personality: ${capitalize(displayValue(view.personality))}`, width),
    truncate(`Destination: ${displayValue(view.messengerDestination)}`, width),
    'COMMANDS',
    ...renderCommands(width),
    '[C] Close dashboard',
    truncate(`Status: ${connectionLabel(view)}`, width),
  ];
}

function fitBody(lines: string[], available: number): string[] {
  if (available <= 0) {
    return [];
  }
  if (lines.length <= available) {
    const padding = available - lines.length;
    if (padding === 0) {
      return lines;
    }
    return [
      ...lines.slice(0, -1),
      ...Array<string>(padding).fill(''),
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
    return plainLines(view, columns).slice(0, rows);
  }

  const innerWidth = columns - 2;
  const body = fitBody(bodyLines(view, innerWidth), rows - 2);
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
