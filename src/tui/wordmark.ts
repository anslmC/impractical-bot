import { centerVisible, paint, renderLine, type DashboardTone } from './theme.js';

export const WORDMARK_TAGLINE = 'MESSENGER CONVERSATION ENGINE';

export const WORDMARK_GLYPH_HEIGHT = 5;
export const FULL_WORDMARK_ADVANCE = 4;
export const COMPACT_WORDMARK_ADVANCE = 3;
export const WORDMARK_TRACKING = 1;
export const FULL_WORDMARK_GAP = 5;
export const COMPACT_WORDMARK_GAP = 3;

const WORDMARK_TEXT = 'IMPractical BOT';
const WORDMARK_DISPLAY_TEXT = WORDMARK_TEXT.toUpperCase();
const WORDMARK_PLAIN_WIDTH = WORDMARK_DISPLAY_TEXT.length;

type GlyphSet = Readonly<Record<string, readonly string[]>>;

export const FULL_WORDMARK_GLYPHS: GlyphSet = {
  I: ['████', ' ██ ', ' ██ ', ' ██ ', '████'],
  M: ['█  █', '█▌▐█', '█▐▌█', '█  █', '█  █'],
  N: ['█  █', '██ █', '█ ██', '█  █', '█  █'],
  P: ['████', '█  █', '████', '█   ', '█   '],
  R: ['████', '█  █', '████', '█ █ ', '█  █'],
  A: [' ██ ', '█  █', '████', '█  █', '█  █'],
  C: [' ███', '█   ', '█   ', '█   ', ' ███'],
  T: ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
  L: ['█   ', '█   ', '█   ', '█   ', '████'],
  B: ['███ ', '█  █', '████', '█  █', '████'],
  O: [' ██ ', '█  █', '█  █', '█  █', ' ██ '],
  ' ': ['    ', '    ', '    ', '    ', '    '],
};

export const COMPACT_WORDMARK_GLYPHS: GlyphSet = {
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  M: ['█ █', '█▌█', '█▐█', '█▌█', '█▐█'],
  N: ['█ █', '███', '███', '█ █', '█ █'],
  P: ['██ ', '█ █', '██ ', '█  ', '█  '],
  R: ['██ ', '█ █', '██ ', '█ █', '█ █'],
  A: [' █ ', '█ █', '███', '█ █', '█ █'],
  C: [' ██', '█  ', '█  ', '█  ', ' ██'],
  T: ['███', ' █ ', ' █ ', ' █ ', ' █ '],
  L: ['█  ', '█  ', '█  ', '█  ', '███'],
  B: ['██▌', '█ █', '███', '█ █', '███'],
  O: [' █ ', '█ █', '█ █', '█ █', ' █ '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

const GRADIENT: readonly DashboardTone[] = [
  'brand',
  'info',
  'brandSoft',
  'violet',
  'accent',
];

interface GlyphMetrics {
  readonly advance: number;
  readonly wordGap: number;
}

const FULL_METRICS: GlyphMetrics = {
  advance: FULL_WORDMARK_ADVANCE,
  wordGap: FULL_WORDMARK_GAP,
};

const COMPACT_METRICS: GlyphMetrics = {
  advance: COMPACT_WORDMARK_ADVANCE,
  wordGap: COMPACT_WORDMARK_GAP,
};

function glyphRows(
  glyphs: GlyphSet,
  character: string,
  advance: number,
): readonly string[] {
  const glyph = glyphs[character.toUpperCase()] ?? glyphs[' ']!;
  return Array.from(
    { length: WORDMARK_GLYPH_HEIGHT },
    (_, row) => (glyph[row] ?? '').padEnd(advance),
  );
}

function glyphLines(glyphs: GlyphSet, metrics: GlyphMetrics): string[] {
  const words = WORDMARK_DISPLAY_TEXT
    .split(' ')
    .filter(word => word.length > 0);
  const laidOut = words.map(word =>
    [...word].map(character => glyphRows(glyphs, character, metrics.advance)),
  );
  return Array.from({ length: WORDMARK_GLYPH_HEIGHT }, (_, row) =>
    laidOut
      .map(word => word.map(glyph => glyph[row]).join(' '.repeat(WORDMARK_TRACKING)))
      .join(' '.repeat(WORDMARK_TRACKING + metrics.wordGap)),
  );
}

function paintRows(rows: readonly string[], color: boolean): string[] {
  const width = Math.max(...rows.map(row => row.length));
  return rows.map((row, index) =>
    paint(row.padEnd(width), GRADIENT[index] ?? 'accent', color),
  );
}

export function wordmarkArtLines(): string[] {
  return glyphLines(FULL_WORDMARK_GLYPHS, FULL_METRICS);
}

export function compactWordmarkLines(): string[] {
  return glyphLines(COMPACT_WORDMARK_GLYPHS, COMPACT_METRICS);
}

export const WORDMARK_WIDTH = Math.max(...wordmarkArtLines().map(row => row.length));
export const COMPACT_WORDMARK_WIDTH = Math.max(
  ...compactWordmarkLines().map(row => row.length),
);

export function renderWordmark({ color = true }: { color?: boolean } = {}): string[] {
  return paintRows(wordmarkArtLines(), color);
}

export function renderCompactWordmark({ color = true }: { color?: boolean } = {}): string[] {
  return paintRows(compactWordmarkLines(), color);
}

export function renderWordmarkForWidth(
  width: number,
  { color = true }: { color?: boolean } = {},
): string[] | undefined {
  const rows = width >= WORDMARK_WIDTH
    ? renderWordmark({ color })
    : width >= COMPACT_WORDMARK_WIDTH
      ? renderCompactWordmark({ color })
      : undefined;
  return rows?.map(line => centerVisible(line, width));
}

export function renderWordmarkCentered(
  width: number,
  { color = true }: { color?: boolean } = {},
): string[] {
  return renderWordmark({ color }).map(line => centerVisible(line, width));
}

export function renderPlainWordmark({ color = true }: { color?: boolean } = {}): string {
  return renderLine(
    [
      { text: WORDMARK_DISPLAY_TEXT.slice(0, 3), tone: 'brand' },
      { text: WORDMARK_DISPLAY_TEXT.slice(3, -4), tone: 'brandSoft' },
      { text: WORDMARK_DISPLAY_TEXT.slice(-4), tone: 'accent' },
    ],
    WORDMARK_PLAIN_WIDTH,
    color,
  ).trimEnd();
}
