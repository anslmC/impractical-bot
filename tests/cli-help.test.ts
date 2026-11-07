import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_COMMANDS } from '../src/cli-commands.js';
import { CLI_HELP_HORIZONTAL_SHIFT, formatCliHelp } from '../src/cli-help.js';
import { stripAnsi, visibleWidth } from '../src/tui/theme.js';
import { renderWordmarkForWidth, WORDMARK_TAGLINE } from '../src/tui/wordmark.js';

const OPTION_NAMES = ['-h, --help', '-v, --version', '--debug'] as const;
const DESCRIPTION_COLUMN = 22;

test('help renders the branded wordmark and aligned command reference', () => {
  const help = formatCliHelp({ columns: 80, color: false });
  const lines = help.split('\n');
  const art = renderWordmarkForWidth(80, { color: false });

  assert.ok(art !== undefined);
  const centeredArtLine = art[0] ?? '';
  const shiftedArtLine = lines[0] ?? '';
  const shift = (centeredArtLine.length - centeredArtLine.trimStart().length) -
    (shiftedArtLine.length - shiftedArtLine.trimStart().length);
  assert.ok(shift >= 0 && shift <= CLI_HELP_HORIZONTAL_SHIFT);
  assert.deepEqual(
    lines.slice(0, art.length),
    art.map(line => line.trimEnd().slice(shift)),
  );
  assert.equal(lines[art.length]?.trim(), WORDMARK_TAGLINE);
  assert.doesNotMatch(help, /IMPractical BOT/);
  assert.doesNotMatch(help, /IMPRACTICAL BOT/);
  assert.doesNotMatch(help, /\u001b\[/);

  const usageIndex = lines.findIndex(line => line.trim() === 'Usage');
  assert.ok(usageIndex > art.length);
  const usageLine = lines[usageIndex] ?? '';
  const padding = usageLine.length - usageLine.trimStart().length;
  assert.equal(lines[usageIndex + 1], `${' '.repeat(padding)}  impbot <command>`);
  assert.ok(lines.some(line => line.trim() === 'Commands'));
  assert.ok(lines.some(line => line.trim() === 'Composer Slicer'));
  assert.ok(lines.some(line => line.trim() === 'Options'));

  for (const name of [...CLI_COMMANDS.map(command => command.name), ...OPTION_NAMES]) {
    const line = lines.find(candidate => candidate.trimStart().startsWith(`${name} `));
    assert.ok(line, `missing help entry for ${name}`);
    const rest = line.slice(padding + 2 + name.length);
    const spaces = rest.length - rest.trimStart().length;
    assert.equal(2 + name.length + spaces, DESCRIPTION_COLUMN, name);
  }

  for (const syntax of [
    'setcomposerslicer enabled <true|false> [--force]',
    'setcomposerslicer maxCharacters <positive-integer> [--force]',
    'setcomposerslicer status',
  ]) {
    assert.ok(lines.some(line => line.trim() === syntax), syntax);
  }
});

test('help shifts the content block left while keeping it aligned beneath the wordmark', () => {
  for (const columns of [62, 63, 64, 65, 70, 80, 100, 120]) {
    const help = formatCliHelp({ columns, color: false });
    const lines = help.split('\n');
    const centeredArt = renderWordmarkForWidth(columns, { color: false });
    assert.ok(centeredArt !== undefined);
    const centeredArtLine = centeredArt[0] ?? '';
    const shiftedArtLine = lines[0] ?? '';
    const shift = (centeredArtLine.length - centeredArtLine.trimStart().length) -
      (shiftedArtLine.length - shiftedArtLine.trimStart().length);
    assert.ok(shift >= 0 && shift <= CLI_HELP_HORIZONTAL_SHIFT, `columns=${columns}`);

    const usageIndex = lines.findIndex(line => line.trim() === 'Usage');
    assert.ok(usageIndex > 0);
    const content = lines.slice(usageIndex).filter(line => line.length > 0);
    const usageLine = content[0] ?? '';
    const padding = usageLine.length - usageLine.trimStart().length;
    const indent = ' '.repeat(padding);
    const blockWidth = Math.max(
      ...content.map(line => visibleWidth(line.slice(padding))),
    );

    assert.equal(
      padding,
      Math.max(0, Math.floor((columns - blockWidth) / 2) - shift),
      `columns=${columns}`,
    );
    for (const line of content) {
      assert.ok(line.startsWith(indent), `columns=${columns} line=${JSON.stringify(line)}`);
      assert.ok(
        visibleWidth(line) <= columns,
        `columns=${columns} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test('help shifts the composition five columns left when the terminal has room', () => {
  for (const columns of [100, 120]) {
    const help = formatCliHelp({ columns, color: false });
    const lines = help.split('\n');
    const centeredArt = renderWordmarkForWidth(columns, { color: false });
    assert.ok(centeredArt !== undefined);
    const centeredArtLine = centeredArt[0] ?? '';
    const shiftedArtLine = lines[0] ?? '';
    const shift = (centeredArtLine.length - centeredArtLine.trimStart().length) -
      (shiftedArtLine.length - shiftedArtLine.trimStart().length);
    assert.equal(shift, CLI_HELP_HORIZONTAL_SHIFT, `columns=${columns}`);

    const taglineIndex = lines.findIndex(line => line.trim() === WORDMARK_TAGLINE);
    assert.ok(taglineIndex > 0);
    const tagline = lines[taglineIndex] ?? '';
    const taglinePadding = tagline.length - tagline.trimStart().length;
    assert.equal(
      taglinePadding,
      Math.floor((columns - WORDMARK_TAGLINE.length) / 2) - CLI_HELP_HORIZONTAL_SHIFT,
      `columns=${columns}`,
    );
  }
});

test('help clamps the composition shift when the terminal has no room', () => {
  for (const columns of [20, 40]) {
    const help = formatCliHelp({ columns, color: false });
    const lines = help.split('\n');
    const usageLine = lines.find(line => line.trim() === 'Usage') ?? '';
    assert.equal(
      usageLine.length - usageLine.trimStart().length,
      0,
      `columns=${columns}`,
    );
  }
});

test('help wraps without exceeding the available terminal width', () => {
  for (const columns of [20, 24, 32, 40, 57, 58, 60, 63, 64, 65, 74, 80, 100, 120]) {
    const help = formatCliHelp({ columns, color: false });
    for (const line of help.split('\n')) {
      assert.ok(
        visibleWidth(line) <= columns,
        `columns=${columns} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test('narrow help falls back to the plain wordmark without overflowing', () => {
  const narrow = formatCliHelp({ columns: 20, color: false });
  assert.match(narrow, /IMPRACTICAL BOT/);
  assert.doesNotMatch(narrow, /[█▀▄▌▐]/);
  assert.doesNotMatch(narrow, new RegExp(WORDMARK_TAGLINE));

  const medium = formatCliHelp({ columns: 40, color: false });
  assert.match(medium, /IMPRACTICAL BOT/);
  assert.match(medium, new RegExp(WORDMARK_TAGLINE));
});

test('help styling stays monochrome and leaves plain output unchanged', () => {
  const colored = formatCliHelp({ columns: 80, color: true });
  const plain = formatCliHelp({ columns: 80, color: false });

  assert.match(colored, /\u001b\[1;97m/);
  assert.match(colored, /\u001b\[2;90m/);
  assert.match(colored, /\u001b\[2mUsage\u001b\[0m/);
  assert.match(colored, new RegExp(`\\u001b\\[2m${WORDMARK_TAGLINE}\\u001b\\[0m`));
  assert.match(colored, /\u001b\[1;97minit\s+\u001b\[0m/);
  assert.match(colored, /\u001b\[2mInitialize Impractical Bot\u001b\[0m/);

  const allowedSgr = new Set([
    '\u001b[0m',
    '\u001b[1;97m',
    '\u001b[97m',
    '\u001b[37m',
    '\u001b[90m',
    '\u001b[2;90m',
    '\u001b[2m',
  ]);
  for (const code of colored.match(/\u001b\[[0-9;]*m/g) ?? []) {
    assert.ok(allowedSgr.has(code), `unexpected SGR sequence ${JSON.stringify(code)}`);
  }

  assert.equal(stripAnsi(colored), plain);
});
