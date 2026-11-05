export const ANSI_RESET = '\u001b[0m';

export const THEME_COLORS = {
  white: '\u001b[97m',
  brightWhite: '\u001b[1;97m',
  lightGray: '\u001b[37m',
  boldLightGray: '\u001b[1;37m',
  mediumGray: '\u001b[90m',
  mutedGray: '\u001b[2;90m',
  dim: '\u001b[2m',
  red: '\u001b[1;31m',
} as const;

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
  brand: THEME_COLORS.brightWhite,
  brandSoft: THEME_COLORS.lightGray,
  accent: THEME_COLORS.mutedGray,
  violet: THEME_COLORS.mediumGray,
  magenta: THEME_COLORS.lightGray,
  heading: THEME_COLORS.boldLightGray,
  info: THEME_COLORS.white,
  cyanMuted: THEME_COLORS.mediumGray,
  value: THEME_COLORS.white,
  muted: THEME_COLORS.dim,
  strong: THEME_COLORS.brightWhite,
  success: THEME_COLORS.lightGray,
  warning: THEME_COLORS.mutedGray,
  danger: THEME_COLORS.red,
  cliCyan: THEME_COLORS.lightGray,
  cliGreen: THEME_COLORS.lightGray,
  cliYellow: THEME_COLORS.mutedGray,
  cliRed: THEME_COLORS.red,
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
