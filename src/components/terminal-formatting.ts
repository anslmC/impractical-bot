export type TerminalStyle = 'bold' | 'dim' | 'cyan' | 'green' | 'yellow' | 'red';

export interface TerminalColorOptions {
  isTTY?: boolean;
  noColor?: boolean;
  term?: string;
}

const ANSI_RESET = '\u001b[0m';
const ANSI_STYLE_CODES: Record<TerminalStyle, string> = {
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
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
  return `${ANSI_STYLE_CODES[style]}${text}${ANSI_RESET}`;
}

export function formatTerminalMilestone(label: string, message: string): string {
  return `\n${formatTerminalText(`[${label}]`, 'cyan')} ` +
    formatTerminalText(message, 'bold');
}

export function formatTerminalDiagnostic(message: string): string {
  return `  ${formatTerminalText(message, 'dim')}`;
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