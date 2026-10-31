import { centerVisible, paint, renderLine, type DashboardTone } from './theme.js';

export const WORDMARK_TAGLINE = 'MESSENGER CONVERSATION ENGINE';

const GLYPH_HEIGHT = 5;
const WORDMARK_TEXT = 'IMPractical BOT';

type GlyphSet = Readonly<Record<string, readonly string[]>>;

const GLYPHS: GlyphSet = {
  I: ['▐█▌', ' █ ', ' █ ', ' █ ', '▐█▌'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  P: ['████', '█  █', '████', '█   ', '█   '],
  R: ['████', '█  █', '████', '█ █ ', '█  █'],
  A: [' ██ ', '█  █', '████', '█  █', '█  █'],
  C: [' ███', '█   ', '█   ', '█   ', ' ███'],
  T: ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
  L: ['█  ', '█  ', '█  ', '█  ', '███'],
  B: ['████', '█  █', '███▌', '█  █', '████'],
  O: [' ██ ', '█  █', '█  █', '█  █', ' ██ '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

const COMPACT_GLYPHS: GlyphSet = {
  I: ['▐█▌', ' █ ', ' █ ', ' █ ', '▐█▌'],
  M: ['█ █', '███', '█ █', '█ █', '█ █'],
  P: ['██ ', '█ █', '██ ', '█  ', '█  '],
  R: ['██ ', '█ █', '██ ', '█ █', '█ █'],
  A: [' █ ', '█ █', '███', '█ █', '█ █'],
  C: [' ██', '█  ', '█  ', '█  ', ' ██'],
  T: ['███', ' █ ', ' █ ', ' █ ', ' █ '],
  L: ['█  ', '█  ', '█  ', '█  ', '███'],
  B: ['██ ', '█ █', '██ ', '█ █', '██ '],
  O: [' █ ', '█ █', '█ █', '█ █', ' █ '],
  ' ': [' ', ' ', ' ', ' ', ' '],
};

const GRADIENT: readonly DashboardTone[] = [
  'brand',
  'info',
  'brandSoft',
  'accent',
  'accent',
];

function glyphRows(glyphs: GlyphSet, character: string): readonly string[] {
  const glyph = glyphs[character.toUpperCase()] ?? glyphs[' ']!;
  const width = Math.max(...glyph.map(row => row.length));
  return glyph.map(row => row.padEnd(width));
}

function glyphLines(glyphs: GlyphSet): string[] {
  const rows: string[] = [];
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    rows.push(
      [...WORDMARK_TEXT]
        .map(character => glyphRows(glyphs, character)[row])
        .join(' ')
        .replace(/\s+$/, ''),
    );
  }
  const width = Math.max(...rows.map(row => row.length));
  return rows.map(row => row.padEnd(width));
}

function paintRows(rows: readonly string[], color: boolean): string[] {
  const width = Math.max(...rows.map(row => row.length));
  return rows.map((row, index) =>
    paint(row.padEnd(width), GRADIENT[index] ?? 'accent', color),
  );
}

export function wordmarkArtLines(): string[] {
  return glyphLines(GLYPHS);
}

export function compactWordmarkLines(): string[] {
  return glyphLines(COMPACT_GLYPHS);
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
      { text: 'IMP', tone: 'brand' },
      { text: 'ractical', tone: 'brandSoft' },
      { text: ' BOT', tone: 'accent' },
    ],
    WORDMARK_PLAIN_WIDTH,
    color,
  ).trimEnd();
}

const WORDMARK_PLAIN_WIDTH = 'IMPractical BOT'.length;
