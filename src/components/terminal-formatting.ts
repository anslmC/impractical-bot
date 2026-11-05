import { paint, type DashboardTone } from '../tui/theme.js';

export type TerminalStyle = 'bold' | 'dim' | 'cyan' | 'green' | 'yellow' | 'red';

export interface TerminalColorOptions {
  isTTY?: boolean;
  noColor?: boolean;
  term?: string;
}

const STYLE_TONES: Record<TerminalStyle, DashboardTone> = {
  bold: 'strong',
  dim: 'muted',
  cyan: 'brandSoft',
  green: 'violet',
  yellow: 'warning',
  red: 'danger',
};

export function formatTerminalText(
  text: string,
  style: TerminalStyle,
  options?: TerminalColorOptions,
): string {
  const isTTY = options?.isTTY ?? process.stdout.isTTY === true;
  const noColor = options?.noColor ?? process.env.NO_COLOR !== undefined;
  const term = options?.term ?? process.env.TERM;
  if (!isTTY || noColor || term === 'dumb') {
    return text;
  }
  return paint(text, STYLE_TONES[style], true);
}

export function formatTerminalMilestone(
  label: string,
  message: string,
  options?: TerminalColorOptions,
): string {
  return `\n${formatTerminalText(`[${label}]`, 'cyan', options)} ` +
    formatTerminalText(message, 'bold', options);
}

export function formatTerminalDiagnostic(
  message: string,
  options?: TerminalColorOptions,
): string {
  return `  ${formatTerminalText(message, 'dim', options)}`;
}

export function formatPollSummary(
  newMessageCount: number,
  mentionCount: number,
  options?: TerminalColorOptions,
): string {
  const hasActivity = newMessageCount > 0 || mentionCount > 0;
  const countStyle: TerminalStyle = hasActivity ? 'green' : 'dim';
  const mentionStyle: TerminalStyle = mentionCount > 0 ? 'yellow' : countStyle;
  const prefix = `${formatTerminalText('[poll]', 'cyan', options)} ` +
    formatTerminalText('Poll:', hasActivity ? 'bold' : 'dim', options);
  const messageCount = formatTerminalText(String(newMessageCount), countStyle, options);
  const detectedMentions = formatTerminalText(String(mentionCount), mentionStyle, options);
  const spacing = hasActivity ? '\n' : '  ';
  return `${spacing}${prefix} ${messageCount} new messages checked; ` +
    `${detectedMentions} mention detected.`;
}