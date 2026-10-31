import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboardLines, type DashboardView } from '../src/tui/layout.js';
import {
  formatDashboardLogEntries,
  formatDashboardLogLine,
  type DashboardLogEntry,
} from '../src/tui/logs.js';
import { stripAnsi, visibleWidth } from '../src/tui/theme.js';

const timestamp = new Date(2024, 0, 2, 3, 4, 5);
const border = '='.repeat(80);

const view: DashboardView = {
  connection: 'connected',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

function entry(message: string): DashboardLogEntry {
  return { timestamp, level: 'log', message };
}

function messageLine(id: string, content: string): string {
  return `  - id=${id}; text=${JSON.stringify(content)}`;
}

function senderMessageLine(id: string, sender: string, content: string): string {
  return `  - id=${id}; sender=${JSON.stringify(sender)}; text=${JSON.stringify(content)}`;
}

interface BlockOptions {
  added?: string[];
  retained?: string[];
  evicted?: string[];
  retainedValue?: string;
  deferred?: boolean;
  extra?: string[];
}

function contextBlock(options: BlockOptions = {}): DashboardLogEntry[] {
  const added = options.added ?? [];
  const retained = options.retained ?? added;
  const evicted = options.evicted ?? [];
  const lines = [
    border,
    'CONTEXT STORE UPDATE',
    border,
    `Newly appended:       ${added.length}`,
    `Currently retained:   ${options.retainedValue ?? String(retained.length)}`,
    'Maximum capacity:     60',
    'New messages:',
    ...(added.length > 0 ? added : ['  (none)']),
    ...(options.extra ?? []),
    ...(options.deferred
      ? ['Eviction details and aggregate contents skipped; packet work prevents safe reads.']
      : [
        `Evicted this update (${evicted.length}):`,
        ...(evicted.length > 0 ? evicted : ['  (none)']),
        'Full retained store, in observation order:',
        ...(retained.length > 0 ? retained : ['  (none)']),
      ]),
    border,
  ];
  return lines.map(entry);
}

function present(
  entries: readonly DashboardLogEntry[],
  width = 78,
  color = false,
): string[] {
  return formatDashboardLogEntries(entries, width, { color, categoryWidth: 8 });
}

test('context store blocks collapse into a compact structured summary', () => {
  const rows = present(contextBlock({ added: [messageLine('m1', 'hello')] }));
  const plain = rows.join('\n');

  assert.equal(rows[0], '[03:04:05] CONTEXT STORE');
  assert.match(plain, /^  Messages: 1 \/ 60$/m);
  assert.match(plain, /^  Added: 1$/m);
  assert.match(plain, /^  RECENT MESSAGES \(1\)$/m);
  assert.match(plain, /^  RETAINED STORE$/m);
  assert.equal(
    plain.split('hello').length - 1,
    1,
    'the recent message is not repeated in the retained store',
  );
  assert.doesNotMatch(plain, /^={8,}$/m, 'diagnostic borders are not shown');
  assert.doesNotMatch(plain, /CONTEXT STORE UPDATE/);
  assert.doesNotMatch(plain, /Newly appended:/);
  assert.doesNotMatch(plain, /Currently retained:/);
  assert.doesNotMatch(plain, /Maximum capacity:/);
  assert.match(plain, /^    \(none\)$/m, 'an empty section is stated explicitly');
  assert.equal(rows[3], '', 'the summary is separated from the messages');
});

test('multiple messages keep attribution, order, and subdued metadata', () => {
  const rows = present(
    contextBlock({
      added: [
        messageLine('m1', 'First participant says hello'),
        messageLine('m2', 'Second participant replies'),
      ],
    }),
    78,
    true,
  );
  const plain = rows.map(stripAnsi).join('\n');

  assert.match(plain, /^  RECENT MESSAGES \(2\)$/m);
  assert.match(plain, /^  ├─ First participant says hello  m1$/m);
  assert.match(plain, /^  └─ Second participant replies  m2$/m);
  assert.ok(
    plain.indexOf('First participant says hello') < plain.indexOf('Second participant replies'),
    'messages stay in chronological order',
  );
  assert.doesNotMatch(plain, /id=m1/);
  assert.doesNotMatch(plain, /text=/);
  assert.match(rows.join('\n'), /\u001b\[2m  m1\u001b\[0m$/m, 'ids are dim metadata');
});

test('sender-prefixed context store lines keep their message content', () => {
  const rows = present(contextBlock({
    added: [senderMessageLine('m3', 'Katsuyo', 'Yukinon do you hear anselmo?')],
    retained: [
      senderMessageLine('m1', 'Alex', 'older context'),
      senderMessageLine('m2', 'Blair', 'middle context'),
      senderMessageLine('m3', 'Katsuyo', 'Yukinon do you hear anselmo?'),
    ],
  }));
  const plain = rows.join('\n');

  assert.match(plain, /^  RECENT MESSAGES \(1\)$/m);
  assert.match(plain, /^  RETAINED STORE \(2\)$/m);
  assert.match(plain, /Yukinon do you hear anselmo\?/);
  assert.match(plain, /older context/);
  assert.match(plain, /middle context/);
  assert.doesNotMatch(plain, /sender=/);
});

test('retained and evicted sections follow the block order', () => {
  const rows = present(contextBlock({
    added: [messageLine('m3', 'newest')],
    evicted: [messageLine('m0', 'oldest evicted')],
    retained: [
      messageLine('m1', 'older context'),
      messageLine('m2', 'middle context'),
      messageLine('m3', 'newest'),
    ],
  }));
  const plain = rows.join('\n');

  const recent = plain.indexOf('RECENT MESSAGES');
  const evicted = plain.indexOf('EVICTED THIS UPDATE (1)');
  const retained = plain.indexOf('RETAINED STORE (2)');
  assert.ok(recent >= 0 && evicted > recent && retained > evicted);

  const older = plain.indexOf('older context');
  const middle = plain.indexOf('middle context');
  assert.ok(older < middle, 'retained messages keep observation order');
  assert.equal(plain.indexOf('newest', retained), -1, 'the recent message is not repeated');
});

test('retained messages are deduplicated by id, not by text', () => {
  const rows = present(contextBlock({
    added: [
      messageLine('m1', 'shared one'),
      messageLine('m2', 'shared two'),
      messageLine('m4', 'same text'),
    ],
    retained: [
      messageLine('m0', 'earlier'),
      messageLine('m1', 'shared one'),
      messageLine('m3', 'middle'),
      messageLine('m2', 'shared two'),
      messageLine('m4', 'same text'),
      messageLine('m5', 'same text'),
    ],
  }));
  const plain = rows.join('\n');
  const retained = plain.indexOf('RETAINED STORE');

  assert.match(plain, /^  RECENT MESSAGES \(3\)$/m);
  assert.match(plain, /^  RETAINED STORE \(3\)$/m);
  assert.match(plain, /^  Messages: 6 \/ 60$/m, 'the real retained count is unchanged');

  const earlier = plain.indexOf('earlier', retained);
  const middle = plain.indexOf('middle', retained);
  const sameText = plain.indexOf('same text', retained);
  assert.ok(earlier < middle && middle < sameText, 'remaining messages keep chronological order');

  assert.equal(plain.split('shared one').length - 1, 1, 'overlapping ids render once');
  assert.equal(plain.split('shared two').length - 1, 1, 'overlapping ids render once');
  assert.equal(
    plain.split('same text').length - 1,
    2,
    'identical text with different ids stays distinct',
  );
});

test('deduplication covers empty sections, full overlap, and missing ids', () => {
  const emptyRecent = present(contextBlock({
    added: [],
    retained: [messageLine('m1', 'only retained')],
  })).join('\n');
  assert.match(emptyRecent, /^  RECENT MESSAGES\n    \(none\)$/m);
  assert.match(emptyRecent, /^  RETAINED STORE \(1\)$/m);
  assert.match(emptyRecent, /only retained/);

  const emptyRetained = present(contextBlock({
    added: [messageLine('m1', 'only recent')],
    retained: [],
  })).join('\n');
  assert.match(emptyRetained, /^  RECENT MESSAGES \(1\)$/m);
  assert.match(emptyRetained, /^  RETAINED STORE\n    \(none\)$/m);
  assert.match(emptyRetained, /^  Messages: 0 \/ 60$/m);

  const fullOverlap = present(contextBlock({
    added: [messageLine('m1', 'alpha'), messageLine('m2', 'beta')],
    retained: [messageLine('m1', 'alpha'), messageLine('m2', 'beta')],
  })).join('\n');
  assert.match(fullOverlap, /^  RETAINED STORE\n    \(none\)$/m);
  assert.match(fullOverlap, /^  Messages: 2 \/ 60$/m);
  assert.equal(fullOverlap.split('alpha').length - 1, 1);
  assert.equal(fullOverlap.split('beta').length - 1, 1);

  const missingIds = present(contextBlock({
    added: [messageLine('m1', 'overlapping message')],
    retained: [
      '  - id=; text="missing id message"',
      '  - id=   ; text="blank id message"',
      messageLine('m1', 'overlapping message'),
    ],
  }), 100).join('\n');
  assert.match(missingIds, /^  RETAINED STORE \(2\)$/m);
  assert.match(missingIds, /missing id message/);
  assert.match(missingIds, /blank id message/);
  assert.equal(missingIds.split('overlapping message').length - 1, 1);
});

test('long retained stores keep their edges, count, and chronology', () => {
  const retained = Array.from({ length: 12 }, (_, index) =>
    messageLine(`m${index}`, `retained message ${index}`));
  const rows = present(contextBlock({
    added: [messageLine('m-new', 'newest message')],
    retained,
  }));
  const plain = rows.join('\n');
  const retainedHeading = plain.indexOf('RETAINED STORE (12)');

  assert.ok(retainedHeading >= 0);
  assert.match(plain, /^  Messages: 12 \/ 60$/m);
  assert.match(plain, /^  │  … 4 messages omitted$/m);

  for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) {
    assert.match(plain, new RegExp(`retained message ${index}(?!\\d)`));
  }
  for (const index of [4, 5, 6, 7]) {
    assert.doesNotMatch(plain, new RegExp(`retained message ${index}(?!\\d)`));
  }

  const first = plain.indexOf('retained message 0');
  const omitted = plain.indexOf('4 messages omitted');
  const last = plain.indexOf('retained message 11');
  assert.ok(first < omitted && omitted < last, 'chronology stays visible around the collapse');
});

test('short retained stores and singular omissions are not over-collapsed', () => {
  const short = present(contextBlock({
    added: [messageLine('m-new', 'newest message')],
    retained: Array.from({ length: 8 }, (_, index) =>
      messageLine(`m${index}`, `retained message ${index}`)),
  })).join('\n');
  assert.doesNotMatch(short, /omitted/);
  assert.match(short, /^  RETAINED STORE \(8\)$/m);

  const narrow = present(contextBlock({
    added: [messageLine('m-new', 'newest message')],
    retained: Array.from({ length: 9 }, (_, index) =>
      messageLine(`m${index}`, `retained message ${index}`)),
  })).join('\n');
  assert.match(narrow, /^  │  … 1 message omitted$/m);
  assert.match(narrow, /^  RETAINED STORE \(9\)$/m);
});

test('long message content truncates without losing its id or the panel width', () => {
  const rows = present(
    contextBlock({ added: [messageLine('long-id', 'x'.repeat(200))] }),
    40,
  );
  const messageRow = rows.find(row => /^  [├└]─ /u.test(row));

  assert.ok(messageRow);
  assert.equal(visibleWidth(messageRow), 40);
  assert.match(messageRow, /…  long-id$/);
});

test('deferred context output and empty stores stay readable', () => {
  const rows = present(contextBlock({
    added: [messageLine('m1', 'kept while deferred')],
    retainedValue: '(deferred)',
    deferred: true,
  }));
  const plain = rows.join('\n');

  assert.match(plain, /^  Messages: \(deferred\) \/ 60$/m);
  assert.match(plain, /^  Full contents deferred while packet work is active\.$/m);
  assert.match(plain, /^  RECENT MESSAGES \(1\)$/m);
  assert.match(plain, /kept while deferred/);
  assert.doesNotMatch(plain, /EVICTED THIS UPDATE/);
  assert.doesNotMatch(plain, /RETAINED STORE/);

  const empty = present(contextBlock({ added: [], retained: [] }));
  const emptyPlain = empty.join('\n');
  assert.match(emptyPlain, /^  Messages: 0 \/ 60$/m);
  assert.match(emptyPlain, /^  RECENT MESSAGES$/m);
  assert.match(emptyPlain, /^    \(none\)$/m);
});

test('unexpected in-block diagnostics are preserved in place', () => {
  const entries = contextBlock({
    added: [messageLine('m1', 'recognized message')],
    extra: ['Unexpected diagnostic line: keep me'],
  });
  const rows = present(entries);
  const plain = rows.join('\n');

  const message = plain.indexOf('recognized message');
  const unexpected = plain.indexOf('Unexpected diagnostic line: keep me');
  const evicted = plain.indexOf('EVICTED THIS UPDATE');
  assert.ok(message >= 0 && unexpected > message && evicted > unexpected);
  assert.match(plain, /\[03:04:05\] Unexpected diagnostic line: keep me/);
});

test('ordinary LIVE LOGS messages and incomplete markers are unchanged', () => {
  const ordinary = [
    entry('  [poll] Poll: 2 new messages checked; 1 mention detected.'),
    entry('      [rng] Roll: YES (50% chance)'),
    entry('poller checking for new messages'),
    entry('  - id=m1; text="standalone line"'),
    entry('CONTEXT STORE UPDATE'),
    entry(border),
  ];

  assert.deepEqual(
    present(ordinary, 80, true),
    ordinary.map(message => formatDashboardLogLine(message, 80, {
      color: true,
      categoryWidth: 8,
    })),
  );
});

test('dashboard LIVE LOGS renders Context Store output as a hierarchy', () => {
  const logs = [
    entry('  [poll] Poll: 1 new messages checked; 0 mention detected.'),
    ...contextBlock({
      added: [
        messageLine('m1', 'Anselmo content that must stay verbatim'),
        messageLine('m2', 'PleaseGetout Daily content that must stay verbatim'),
      ],
    }),
    entry('  [engine] Combustion resumed.'),
  ];
  const lines = renderDashboardLines(
    { ...view, logs },
    { columns: 80, rows: 40 },
    { color: true },
  );
  const plain = stripAnsi(lines.join('\n'));

  assert.match(plain, /CONTEXT STORE/);
  assert.match(plain, /Messages: 2 \/ 60/);
  assert.match(plain, /├─ Anselmo content that must stay verbatim  m1/);
  assert.match(plain, /└─ PleaseGetout Daily content that must stay verbatim  m2/);
  assert.doesNotMatch(plain, /^={8,}$/m);
  assert.match(plain, /\[engine\] Combustion resumed\./);
  assert.match(lines.join('\n'), /\u001b\[36m\[poll\]\u001b\[0m/, 'other categories keep their color');
  assert.ok(lines.every(line => visibleWidth(line) === 80));
});
