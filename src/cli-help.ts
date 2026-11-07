import { CLI_COMMANDS, CLI_COMMAND_NAME_WIDTH } from './cli-commands.js';
import { centerVisible, paint, visibleWidth } from './tui/theme.js';
import {
  renderPlainWordmark,
  renderWordmarkForWidth,
  WORDMARK_TAGLINE,
} from './tui/wordmark.js';

export interface CliHelpOptions {
  readonly columns?: number;
  readonly color?: boolean;
}

export const CLI_HELP_DEFAULT_COLUMNS = 80;
export const CLI_HELP_MINIMUM_COLUMNS = 20;
export const CLI_HELP_HORIZONTAL_SHIFT = 5;

const INDENT = '  ';
const COLUMN_GAP = '  ';
const CONTINUATION_INDENT = `${INDENT}  `;
const MINIMUM_INLINE_DESCRIPTION = 12;

const OPTIONS = [
  { name: '-h, --help', description: 'Show this help' },
  { name: '-v, --version', description: 'Show the version' },
  { name: '--debug', description: 'Start in the debug log view' },
] as const;

const NAME_WIDTH = Math.max(
  CLI_COMMAND_NAME_WIDTH,
  ...CLI_COMMANDS.map(command => command.name.length),
  ...OPTIONS.map(option => option.name.length),
);
const DESCRIPTION_COLUMN = INDENT.length + NAME_WIDTH + COLUMN_GAP.length;

const COMPOSER_SLICER_SYNTAX = [
  'setcomposerslicer enabled <true|false> [--force]',
  'setcomposerslicer maxCharacters <positive-integer> [--force]',
  'setcomposerslicer status',
] as const;

function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const words = text.split(/\s+/).filter(word => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > limit) {
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += limit) {
        lines.push(word.slice(index, index + limit));
      }
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

function formatEntry(
  name: string,
  description: string,
  columns: number,
  color: boolean,
): string[] {
  const inlineWidth = columns - DESCRIPTION_COLUMN;
  if (inlineWidth >= MINIMUM_INLINE_DESCRIPTION) {
    const [first = '', ...rest] = wrapText(description, inlineWidth);
    return [
      `${INDENT}${paint(name.padEnd(NAME_WIDTH), 'strong', color)}` +
        `${COLUMN_GAP}${paint(first, 'muted', color)}`,
      ...rest.map(line => `${' '.repeat(DESCRIPTION_COLUMN)}${paint(line, 'muted', color)}`),
    ];
  }

  const stackedWidth = Math.max(1, columns - CONTINUATION_INDENT.length);
  return [
    `${INDENT}${paint(name, 'strong', color)}`,
    ...wrapText(description, stackedWidth).map(
      line => `${CONTINUATION_INDENT}${paint(line, 'muted', color)}`,
    ),
  ];
}

function formatSyntax(text: string, columns: number, color: boolean): string[] {
  const width = Math.max(1, columns - INDENT.length);
  return wrapText(text, width).map((line, index) => {
    if (index > 0) {
      return `${INDENT}${paint(line, 'muted', color)}`;
    }
    const separator = line.indexOf(' ');
    if (separator <= 0) {
      return `${INDENT}${paint(line, 'strong', color)}`;
    }
    return `${INDENT}${paint(line.slice(0, separator), 'strong', color)} ` +
      paint(line.slice(separator + 1), 'muted', color);
  });
}

function formatHeading(text: string, color: boolean): string {
  return paint(text, 'muted', color);
}

function formatUsageLine(color: boolean): string {
  return `${INDENT}${paint('impbot', 'strong', color)} ${paint('<command>', 'muted', color)}`;
}

const TRAILING_STYLE_RUN = /(?:[ \t]|\u001b\[[0-9;]*m)+$/;

function trimTrailingStylePadding(line: string): string {
  const match = line.match(TRAILING_STYLE_RUN);
  if (match === null || !/[ \t]/.test(match[0])) {
    return line;
  }
  return line.slice(0, line.length - match[0].length) +
    match[0].replace(/[ \t]+/g, '');
}

function formatBranding(columns: number, color: boolean): string[] {
  const art = renderWordmarkForWidth(columns, { color });
  const lines = art !== undefined
    ? art.map(trimTrailingStylePadding)
    : [trimTrailingStylePadding(centerVisible(renderPlainWordmark({ color }), columns))];

  if (columns >= WORDMARK_TAGLINE.length) {
    lines.push(trimTrailingStylePadding(
      centerVisible(paint(WORDMARK_TAGLINE, 'muted', color), columns),
    ));
  }
  return lines;
}

function centerContentBlock(lines: readonly string[], columns: number): string[] {
  const blockWidth = Math.max(0, ...lines.map(visibleWidth));
  const padding = Math.max(0, Math.floor((columns - blockWidth) / 2));
  if (padding === 0) {
    return [...lines];
  }
  const indent = ' '.repeat(padding);
  return lines.map(line => line.length === 0 ? '' : `${indent}${line}`);
}

function shiftCompositionLeft(lines: readonly string[]): string[] {
  const shift = lines.reduce(
    (current, line) => line.length === 0
      ? current
      : Math.min(current, line.length - line.trimStart().length),
    CLI_HELP_HORIZONTAL_SHIFT,
  );
  if (shift === 0) {
    return [...lines];
  }
  return lines.map(line => line.length === 0 ? '' : line.slice(shift));
}

export function formatCliHelp(options: CliHelpOptions = {}): string {
  const columns = Math.max(
    CLI_HELP_MINIMUM_COLUMNS,
    Math.floor(options.columns ?? CLI_HELP_DEFAULT_COLUMNS),
  );
  const color = options.color === true;
  const contentWidth = Math.min(columns, CLI_HELP_DEFAULT_COLUMNS);
  const content: string[] = [
    formatHeading('Usage', color),
    formatUsageLine(color),
    '',
    formatHeading('Commands', color),
  ];

  for (const command of CLI_COMMANDS) {
    content.push(...formatEntry(command.name, command.description, contentWidth, color));
  }

  content.push('', formatHeading('Composer Slicer', color));
  for (const syntax of COMPOSER_SLICER_SYNTAX) {
    content.push(...formatSyntax(syntax, contentWidth, color));
  }

  content.push('', formatHeading('Options', color));
  for (const option of OPTIONS) {
    content.push(...formatEntry(option.name, option.description, contentWidth, color));
  }

  return shiftCompositionLeft([
    ...formatBranding(columns, color),
    '',
    ...centerContentBlock(content, columns),
  ]).join('\n');
}
