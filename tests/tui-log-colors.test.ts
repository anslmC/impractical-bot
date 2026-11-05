import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboardLines, type DashboardView } from '../src/tui/layout.js';
import {
  formatDashboardLogLine,
  type DashboardLogEntry,
  type DashboardLogLevel,
} from '../src/tui/logs.js';
import { stripAnsi, visibleWidth } from '../src/tui/theme.js';

const timestamp = new Date(2024, 0, 2, 3, 4, 5);

// Shared log roles: light-gray labels, muted warnings, dim secondary text,
// and red errors.
const TONE = {
  label: '37',
  dim: '2',
  bold: '1',
  success: '37',
  warning: '2;90',
  danger: '1;31',
} as const;

const view: DashboardView = {
  connection: 'connected',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

function entry(message: string, level: DashboardLogLevel = 'log'): DashboardLogEntry {
  return { timestamp, level, message };
}

function styled(message: string, level: DashboardLogLevel = 'log', width = 100): string {
  return formatDashboardLogLine(entry(message, level), width, {
    color: true,
    categoryWidth: 8,
  });
}

function plain(message: string, level: DashboardLogLevel = 'log', width = 100): string {
  return formatDashboardLogLine(entry(message, level), width);
}

function plainAligned(message: string, level: DashboardLogLevel = 'log', width = 100): string {
  return formatDashboardLogLine(entry(message, level), width, { categoryWidth: 8 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenTone(line: string, token: string): string | undefined {
  const pattern = new RegExp(
    `((?:\\u001b\\[[0-9;]+m)+)${escapeRegExp(token)}\\u001b\\[0m`,
  );
  const match = pattern.exec(line);
  if (match === null) {
    return undefined;
  }
  const codes = [...match[1].matchAll(/\u001b\[([0-9;]+)m/g)].map(code => code[1]);
  return codes.at(-1);
}

function isUncolored(line: string, text: string): boolean {
  return !new RegExp(`\\u001b\\[(?!0m)[0-9;]+m${escapeRegExp(text)}`).test(line);
}

test('every production log category uses a light-gray label tone', () => {
  const cases: Array<[string, string]> = [
    ['  [poll] Poll: 0 new messages checked; 0 mention detected.', '[poll]'],
    ['      [rng] Roll: YES (50% chance)', '[rng]'],
    ['      [RNG] Roll: NO (50% chance)', '[RNG]'],
    ['  [poller] Active; sampling every 1500 ms.', '[poller]'],
    ['    [idle] Timer reset (120s).', '[idle]'],
    ['[packet packet-001] stage=start messages=2', '[packet packet-001]'],
    ['   [compose] stage=fill-start chars=12', '[compose]'],
    ['[engine] Combustion resumed.', '[engine]'],
    ['[reply] removed speaker label: "Anselmo:"', '[reply]'],
    ['[browser] Brave connected', '[browser]'],
    ['[mention] packet opened', '[mention]'],
    ['[COMBUSTION] Starting Combustion for group', '[COMBUSTION]'],
    ['[timing] packet=packet-001 hold=4ms', '[timing]'],
  ];

  for (const [message, chip] of cases) {
    assert.equal(tokenTone(styled(message), chip), TONE.label, message);
  }
});

test('ordinary informational messages keep the normal foreground color', () => {
  const resumed = styled('[engine] Combustion resumed.');
  assert.equal(tokenTone(resumed, '[engine]'), TONE.label);
  assert.ok(isUncolored(resumed, 'Combustion resumed.'), 'message stays uncolored');

  const info = styled('[engine] Combustion resumed.', 'info');
  assert.ok(isUncolored(info, '[INFO] '), '[INFO] does not add an accent');
  assert.ok(isUncolored(info, 'Combustion resumed.'), 'info text stays uncolored');

  const unclassified = styled('poller checking for new messages');
  assert.ok(isUncolored(unclassified, 'poller checking for new messages'));
  assert.equal(stripAnsi(unclassified), plain('poller checking for new messages'));
});

test('timestamps stay dim, aligned, and separate from the message', () => {
  const line = styled('  [poll] Poll: 0 new messages checked; 0 mention detected.');

  assert.match(line, /^\u001b\[2m\[03:04:05\] \u001b\[0m/);
  assert.equal(stripAnsi(line).slice(0, 11), '[03:04:05] ');
  assert.equal(tokenTone(line, '[03:04:05] '), TONE.dim);
});

test('warnings and errors are prominent without flooding the line', () => {
  const warning = styled('[engine] connector stalled', 'warn');
  assert.equal(tokenTone(warning, '[WARN] '), TONE.warning);
  assert.match(warning, new RegExp(`\\u001b\\[${TONE.warning}mconnector stalled\\u001b\\[0m`));

  const error = styled('[engine] destination rejected', 'error');
  assert.equal(tokenTone(error, '[ERROR] '), TONE.danger);
  assert.match(error, new RegExp(`\\u001b\\[${TONE.danger}mrejected\\u001b\\[0m`));
  assert.match(stripAnsi(error), /destination rejected/);
});

test('successful operations use light-gray emphasis', () => {
  assert.match(
    styled('      [rng] Roll: YES (50% chance)'),
    new RegExp(`\\u001b\\[${TONE.success}mRoll: YES\\u001b\\[0m`),
  );
  assert.match(
    styled('      [rng] Cooldown ended'),
    new RegExp(`\\u001b\\[${TONE.success}mCooldown ended\\u001b\\[0m`),
  );
  assert.match(
    styled('      [rng] Processing completed: rng-packet-012 (success)'),
    new RegExp(`\\u001b\\[${TONE.success}mProcessing completed\\u001b\\[0m`),
  );
  assert.match(
    styled('[packet packet-001] stage=complete status=sent'),
    new RegExp(`\\u001b\\[${TONE.success}msent\\u001b\\[0m`),
  );
  assert.match(styled('      [rng] Roll: NO (50% chance)'), /\u001b\[2mRoll: NO\u001b\[0m/);
});

test('debug output and secondary detail stay subdued', () => {
  const debug = styled(
    '[identity] merged duplicate rendered record: observed=1 canonical=2',
    'debug',
  );
  assert.equal(tokenTone(debug, '[DEBUG] '), TONE.dim);
  assert.match(debug, /\u001b\[2mmerged duplicate rendered record:\u001b\[0m/);

  const rng = styled('      [rng] Cooldown started: 15s (reply sent)');
  assert.match(rng, /\u001b\[1;97mCooldown started:\u001b\[0m/, 'labels use bright-white emphasis');
  assert.match(rng, /\u001b\[2m\(reply sent\)\u001b\[0m/);

  const poll = styled('  [poll] Poll: 2 new messages checked; 1 mention detected.');
  assert.match(poll, /\u001b\[1;97mPoll:\u001b\[0m/);
  assert.match(poll, new RegExp(`\\u001b\\[${TONE.success}m2\\u001b\\[0m`));
  assert.match(poll, new RegExp(`\\u001b\\[${TONE.success}m1\\u001b\\[0m`));

  const zero = styled('  [poll] Poll: 0 new messages checked; 0 mention detected.');
  assert.match(zero, /\u001b\[2m0\u001b\[0m/);

  const timing = styled('[timing] packet=packet-001 hold=4ms');
  assert.match(timing, /\u001b\[2mhold=\u001b\[0m/);

  const baseline = styled('Baseline recorded: 1 unique message IDs.');
  assert.match(baseline, /\u001b\[1;97mBaseline recorded:\u001b\[0m/);
});

test('unknown categories keep the light-gray label tone and plain text', () => {
  const line = styled('[whatever] something happened');

  assert.equal(tokenTone(line, '[whatever]'), TONE.label);
  assert.match(stripAnsi(line), /\[whatever\] something happened/);
  assert.ok(isUncolored(line, 'something happened'), 'unknown text keeps normal foreground');
  assert.equal(stripAnsi(line), plain('[whatever] something happened'));
});

test('ANSI styling resets between segments and sanitization is preserved', () => {
  const line = styled('\u001b[31m[engine] apiKey=secret \u001b[1;2Hdone\u001b[0m');

  assert.doesNotMatch(line, /\u001b(?!\[[0-9;]*m)/, 'only complete SGR sequences are emitted');
  assert.doesNotMatch(line, /secret/);
  assert.match(stripAnsi(line), /\[engine\] apiKey=\[REDACTED\] done/);
  assert.doesNotMatch(line, /\u001b\[0m\u001b\[0m/, 'resets are never duplicated');
  const codes = line.match(/\u001b\[[0-9;]*m/g) ?? [];
  assert.equal(codes.at(-1), '\u001b[0m', 'no style stays open at the end of the line');

  for (const message of [
    '  [poll] Poll: 1 new messages checked; 1 mention detected.',
    '      [rng] Roll: YES (50% chance)',
    '[packet packet-001] stage=complete status=sent',
    'Baseline recorded: 1 unique message IDs.',
  ]) {
    assert.equal(stripAnsi(styled(message)), plainAligned(message), message);
  }
});

test('colored log lines stay inside the panel at every width', () => {
  const long = styled('  [engine] ' + 'x'.repeat(300), 'log', 48);
  assert.equal(visibleWidth(long), 48);
  assert.match(stripAnsi(long), /…$/);

  for (const columns of [80, 60, 40, 24]) {
    const lines = renderDashboardLines(
      {
        ...view,
        logs: [
          entry('  [poll] Poll: 2 new messages checked; 1 mention detected.'),
          entry('      [rng] Cooldown started: 15s (reply sent)'),
          entry('[engine] ' + 'y'.repeat(200)),
        ],
      },
      { columns, rows: 20 },
      { color: true },
    );
    assert.equal(lines.length, 20);
    assert.ok(lines.every(line => visibleWidth(line) === columns), `${columns} columns`);
  }
});

test('rapid log updates keep category tones and FIFO ordering', () => {
  const logs = Array.from({ length: 40 }, (_, index) =>
    entry(`      [rng] Cooldown started: ${index}s`));

  const lines = renderDashboardLines(
    { ...view, logs },
    { columns: 80, rows: 24 },
    { color: true },
  );
  assert.equal(lines.length, 24);

  const visibleLogs = lines.filter(line => line.includes('[rng]'));
  assert.ok(visibleLogs.length >= 1);
  assert.ok(
    visibleLogs.every(line => line.includes(`\u001b[${TONE.label}m[rng]\u001b[0m`)),
    'every rendered rng line keeps the light-gray label tone',
  );
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /Cooldown started: 39s/);
  assert.doesNotMatch(text, /Cooldown started: 0s/);
});
