export const ANSI_RESET = '\u001b[0m';

export type DashboardTone =
  | 'brand'
  | 'brandSoft'
  | 'accent'
  | 'violet'
  | 'magenta'
  | 'heading'
  | 'info'
  | 'cyanMuted'
  | 'value'
  | 'muted'
  | 'strong'
  | 'success'
  | 'warning'
  | 'danger'
  | 'cliCyan'
  | 'cliGreen'
  | 'cliYellow'
  | 'cliRed';

const TONE_CODES: Record<DashboardTone, string> = {
  brand: '\u001b[1m\u001b[38;5;51m',
  brandSoft: '\u001b[38;5;39m',
  accent: '\u001b[38;5;141m',
  violet: '\u001b[38;5;105m',
  magenta: '\u001b[38;5;171m',
  heading: '\u001b[1m\u001b[38;5;45m',
  info: '\u001b[38;5;45m',
  cyanMuted: '\u001b[38;5;44m',
  value: '\u001b[38;5;255m',
  muted: '\u001b[2m',
  strong: '\u001b[1m',
  success: '\u001b[38;5;114m',
  warning: '\u001b[38;5;221m',
  danger: '\u001b[38;5;203m',
  cliCyan: '\u001b[36m',
  cliGreen: '\u001b[32m',
  cliYellow: '\u001b[33m',
  cliRed: '\u001b[31m',
};

const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_PATTERN = /\u001b[@-_]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SINGLE_PATTERN, '');
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function paint(
  text: string,
  tone: DashboardTone | undefined,
  color: boolean,
): string {
  if (!color || tone === undefined || text.length === 0) {
    return text;
  }
  return `${TONE_CODES[tone]}${text}${ANSI_RESET}`;
}

export function truncateVisible(text: string, maximum: number): string {
  const limit = Math.max(0, Math.floor(maximum));
  if (limit === 0) {
    return '';
  }
  const plain = stripAnsi(text);
  if (plain.length <= limit) {
    return text;
  }
  if (limit === 1) {
    return '…';
  }
  return `${plain.slice(0, limit - 1)}…`;
}

export function padVisible(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return text + ' '.repeat(padding);
}

export function centerVisible(text: string, width: number): string {
  const bounded = truncateVisible(text, width);
  const left = Math.max(0, Math.floor((width - visibleWidth(bounded)) / 2));
  return padVisible(`${' '.repeat(left)}${bounded}`, width);
}

export interface StyledSegment {
  readonly text: string;
  readonly tone?: DashboardTone;
}

export function renderSegments(
  segments: readonly StyledSegment[],
  width: number,
  color: boolean,
): string {
  const maximum = Math.max(0, Math.floor(width));
  if (maximum === 0) {
    return '';
  }
  let remaining = maximum;
  let output = '';
  for (const segment of segments) {
    if (remaining <= 0) {
      break;
    }
    const plain = stripAnsi(segment.text);
    if (plain.length === 0) {
      continue;
    }
    if (plain.length <= remaining) {
      output += paint(plain, segment.tone, color);
      remaining -= plain.length;
      continue;
    }
    if (remaining === 1) {
      output += paint('…', segment.tone, color);
      break;
    }
    output += paint(`${plain.slice(0, remaining - 1)}…`, segment.tone, color);
    break;
  }
  return output;
}

export function renderLine(
  segments: readonly StyledSegment[],
  width: number,
  color: boolean,
): string {
  return padVisible(renderSegments(segments, width, color), width);
}
