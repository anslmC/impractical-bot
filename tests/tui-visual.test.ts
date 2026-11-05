import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import { startDashboard } from '../src/tui/index.js';
import {
  DASHBOARD_EMPTY_LOGS_MESSAGE,
  getDashboardPromptCursor,
  renderDashboardLines,
  type DashboardView,
} from '../src/tui/layout.js';
import { formatDashboardLogLine, type DashboardLogEntry } from '../src/tui/logs.js';
import { stripAnsi, visibleWidth } from '../src/tui/theme.js';
import {
  COMPACT_WORDMARK_ADVANCE,
  COMPACT_WORDMARK_GAP,
  COMPACT_WORDMARK_GLYPHS,
  COMPACT_WORDMARK_WIDTH,
  FULL_WORDMARK_ADVANCE,
  FULL_WORDMARK_GAP,
  FULL_WORDMARK_GLYPHS,
  WORDMARK_GLYPH_HEIGHT,
  WORDMARK_TAGLINE,
  WORDMARK_TRACKING,
  WORDMARK_WIDTH,
  compactWordmarkLines,
  renderCompactWordmark,
  renderPlainWordmark,
  renderWordmark,
  renderWordmarkForWidth,
  wordmarkArtLines,
} from '../src/tui/wordmark.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  readableFlowing: boolean | null = null;
  pauses = 0;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }
  isPaused(): boolean {
    return this.readableFlowing === false;
  }
  pause(): this {
    this.readableFlowing = false;
    this.pauses += 1;
    return this;
  }
  resume(): this {
    this.readableFlowing = true;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }
  text(): string {
    return this.writes.join('');
  }
}

function streamInput(input: FakeInput): NodeJS.ReadStream {
  return input as unknown as NodeJS.ReadStream;
}

function streamOutput(output: FakeOutput): NodeJS.WriteStream {
  return output as unknown as NodeJS.WriteStream;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

const fixedTimestamp = new Date(2024, 0, 2, 3, 4, 5);

const runningStatus: RuntimeStatusSnapshotResult = {
  status: 'running',
  instanceId: 'test-instance',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

const connectedView: DashboardView = {
  connection: 'connected',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

function logEntry(
  message: string,
  level: DashboardLogEntry['level'] = 'log',
): DashboardLogEntry {
  return { timestamp: fixedTimestamp, level, message };
}

function escapeCodes(text: string): string[] {
  return text.match(/\u001b\[[0-9;]*m/g) ?? [];
}

test('the wordmark is block-drawn, aligned, and sized for a standard terminal', () => {
  const art = wordmarkArtLines();

  assert.equal(art.length, 5, 'the wordmark is five rows tall');
  assert.equal(new Set(art.map(row => row.length)).size, 1, 'every row shares one width');
  assert.equal(WORDMARK_WIDTH, 74);
  assert.equal(WORDMARK_WIDTH, art[0]?.length);
  assert.ok(WORDMARK_WIDTH <= 78, 'the artwork fits the 80-column dashboard body');
  assert.ok(WORDMARK_WIDTH > 40, 'the artwork is the visual centerpiece');
  assert.ok(art.every(row => /[█▀▄▌▐]/.test(row)), 'the artwork uses block characters');
  assert.doesNotMatch(art.join('\n'), /[A-Za-z]/, 'no ordinary lettering inside the artwork');

  const rendered = renderDashboardLines(connectedView, { columns: 80, rows: 24 });
  const plain = rendered.map(stripAnsi).join('\n');
  assert.match(plain, /[█▌▐]/, 'the block wordmark is displayed at 80 columns');
  assert.match(plain, new RegExp(WORDMARK_TAGLINE));
  assert.ok(
    rendered.some(line => escapeCodes(line).length === 0),
    'the layout still renders unstyled lines by default',
  );
});

test('full and compact atlases use five-row fixed-width cells', () => {
  assert.equal(WORDMARK_GLYPH_HEIGHT, 5);
  assert.equal(FULL_WORDMARK_ADVANCE, 4);
  assert.equal(COMPACT_WORDMARK_ADVANCE, 3);

  const atlases: Array<[string, Readonly<Record<string, readonly string[]>>, number]> = [
    ['full', FULL_WORDMARK_GLYPHS, FULL_WORDMARK_ADVANCE],
    ['compact', COMPACT_WORDMARK_GLYPHS, COMPACT_WORDMARK_ADVANCE],
  ];

  for (const [name, glyphs, advance] of atlases) {
    for (const [character, rows] of Object.entries(glyphs)) {
      assert.equal(
        rows.length,
        WORDMARK_GLYPH_HEIGHT,
        `${name} ${character} has exactly ${WORDMARK_GLYPH_HEIGHT} rows`,
      );
      assert.ok(
        rows.every(row => row.length === advance),
        `${name} ${character} occupies its full ${advance}-column cell`,
      );
      if (character === ' ') {
        assert.ok(rows.every(row => row.trim().length === 0), `${name} space is blank`);
        continue;
      }
      assert.ok(rows[0]!.trim().length > 0, `${name} ${character} reaches the cap line`);
      assert.ok(
        rows[WORDMARK_GLYPH_HEIGHT - 1]!.trim().length > 0,
        `${name} ${character} reaches the baseline`,
      );
    }

    for (const character of ['I', 'L']) {
      const rows = glyphs[character]!;
      assert.equal(
        rows[WORDMARK_GLYPH_HEIGHT - 1]!.trimEnd().length,
        advance,
        `${name} ${character} has a full-width baseline`,
      );
    }
  }
});

test('M uses inward diagonals and differs from H and N in both atlases', () => {
  const atlases: Array<[string, Readonly<Record<string, readonly string[]>>, number]> = [
    ['full', FULL_WORDMARK_GLYPHS, FULL_WORDMARK_ADVANCE],
    ['compact', COMPACT_WORDMARK_GLYPHS, COMPACT_WORDMARK_ADVANCE],
  ];
  const hGlyphs: Readonly<Record<string, readonly string[]>> = {
    full: ['█  █', '████', '█  █', '█  █', '█  █'],
    compact: ['█ █', '███', '█ █', '█ █', '█ █'],
  };

  for (const [name, glyphs, advance] of atlases) {
    const m = glyphs.M!;
    const h = hGlyphs[name]!;
    const n = glyphs.N!;

    assert.notDeepEqual(m, h, `${name} M and H are distinct glyphs`);
    assert.notDeepEqual(m, n, `${name} M and N are distinct glyphs`);
    assert.equal(m.length, WORDMARK_GLYPH_HEIGHT, `${name} M has five rows`);
    assert.ok(m.every(row => row.length === advance), `${name} M keeps its fixed advance`);
    assert.ok(
      m.every(row => row[0] === '█' && row[advance - 1] === '█'),
      `${name} M keeps both outer vertical stems`,
    );
    assert.ok(
      m.slice(1).some(row => /[▌▐]/.test(row)),
      `${name} M uses half-blocks for its inward diagonals`,
    );
    assert.ok(
      m.every(row => row !== '█'.repeat(advance)),
      `${name} M has no horizontal middle crossbar`,
    );
    assert.notEqual(n[2], m[2], `${name} N does not share M's central valley`);
  }
});

test('B has an asymmetrical lower bowl in both atlases', () => {
  const atlases = [
    ['full', FULL_WORDMARK_GLYPHS, FULL_WORDMARK_ADVANCE],
    ['compact', COMPACT_WORDMARK_GLYPHS, COMPACT_WORDMARK_ADVANCE],
  ] as const;

  for (const [name, glyphs, advance] of atlases) {
    const b = glyphs.B!;

    assert.notDeepEqual(b, glyphs.O, `${name} B and O are distinct glyphs`);
    assert.equal(b.length, WORDMARK_GLYPH_HEIGHT, `${name} B has five rows`);
    assert.ok(b.every(row => row.length === advance), `${name} B keeps its fixed advance`);
    assert.notEqual(b[0], b[4], `${name} B upper and lower bowls are asymmetric`);
    assert.ok(
      b.every(row => row[0] === '█'),
      `${name} B keeps a continuous left spine`,
    );
  }
});

test('wordmark dimensions and spacing follow fixed metrics', () => {
  const letters = 14;
  const internalGaps = 12;
  const fullWidth =
    letters * FULL_WORDMARK_ADVANCE +
    internalGaps * WORDMARK_TRACKING +
    (WORDMARK_TRACKING + FULL_WORDMARK_GAP);
  const compactWidth =
    letters * COMPACT_WORDMARK_ADVANCE +
    internalGaps * WORDMARK_TRACKING +
    (WORDMARK_TRACKING + COMPACT_WORDMARK_GAP);

  assert.equal(WORDMARK_TRACKING, 1);
  assert.equal(FULL_WORDMARK_GAP, 5);
  assert.equal(COMPACT_WORDMARK_GAP, 3);
  assert.equal(WORDMARK_WIDTH, fullWidth);
  assert.equal(COMPACT_WORDMARK_WIDTH, compactWidth);
  assert.equal(WORDMARK_WIDTH, 74);
  assert.equal(COMPACT_WORDMARK_WIDTH, 58);

  const full = wordmarkArtLines();
  const compact = compactWordmarkLines();
  assert.ok(full.every(row => row.length === fullWidth));
  assert.ok(compact.every(row => row.length === compactWidth));
  assert.match(full[4]!, /████ {6}████/, 'full words have five extra gap columns');
  assert.match(compact[4]!, /███ {4}███ /, 'compact words have three extra gap columns');
});

test('the wordmark paints a bright-white to gray gradient', () => {
  const colored = renderWordmark({ color: true });
  const tones = ['1;97', '97', '37', '90', '2;90'];

  colored.forEach((row, index) => {
    assert.ok(
      row.includes(`\u001b[${tones[index]}m`),
      `row ${index + 1} uses the ${tones[index]} gradient tone`,
    );
  });
  assert.equal(new Set(tones).size, 5, 'the gradient uses five distinct tones');
  assert.equal(new Set(colored.map(visibleWidth)).size, 1, 'coloring keeps the art aligned');
  assert.deepEqual(renderWordmark({ color: false }), wordmarkArtLines());
});

test('medium terminals use the compact block wordmark', () => {
  const compact = compactWordmarkLines();

  assert.equal(compact.length, 5, 'the compact wordmark is five rows tall');
  assert.equal(new Set(compact.map(row => row.length)).size, 1, 'compact rows share one width');
  assert.equal(COMPACT_WORDMARK_WIDTH, compact[0]?.length);
  assert.equal(COMPACT_WORDMARK_WIDTH, 58);
  assert.ok(COMPACT_WORDMARK_WIDTH < WORDMARK_WIDTH, 'the compact tier is narrower');
  assert.ok(COMPACT_WORDMARK_WIDTH <= 58, 'the compact art fits a 60-column terminal body');
  assert.ok(compact.every(row => /[█▀▄▌▐]/.test(row)), 'the compact art is block-drawn');
  assert.doesNotMatch(compact.join('\n'), /[A-Za-z]/, 'no ordinary lettering inside the compact art');

  const tones = ['1;97', '97', '37', '90', '2;90'];
  renderCompactWordmark({ color: true }).forEach((row, index) => {
    assert.ok(row.includes(`\u001b[${tones[index]}m`), `compact row ${index + 1} keeps the gradient`);
  });
  assert.deepEqual(renderCompactWordmark({ color: false }), compact);
  assert.equal(
    new Set(renderCompactWordmark({ color: true }).map(visibleWidth)).size,
    1,
    'coloring keeps the compact art aligned',
  );

  for (const columns of [60, 66, 72]) {
    const lines = renderDashboardLines(connectedView, { columns, rows: 24 });
    const plain = lines.map(stripAnsi).join('\n');
    assert.equal(lines.length, 24, `${columns} columns fills the height`);
    assert.ok(
      lines.every(line => visibleWidth(line) === columns),
      `${columns} columns keeps every line in bounds`,
    );
    assert.match(plain, /[█▌▐]/, `${columns} columns shows the compact art`);
    assert.match(plain, new RegExp(WORDMARK_TAGLINE), `${columns} columns keeps the tagline`);
  }
});

test('the artwork tier follows the available width', () => {
  assert.deepEqual(
    renderWordmarkForWidth(WORDMARK_WIDTH, { color: false })?.map(line => line.trimEnd()),
    wordmarkArtLines().map(line => line.trimEnd()),
    'the full art is used when it fits',
  );
  assert.deepEqual(
    renderWordmarkForWidth(COMPACT_WORDMARK_WIDTH, { color: false }),
    compactWordmarkLines(),
    'the compact art is used at its exact width',
  );

  const centered = renderWordmarkForWidth(COMPACT_WORDMARK_WIDTH + 12, { color: false });
  assert.ok(centered !== undefined);
  assert.ok(
    centered.every(line => visibleWidth(line) === COMPACT_WORDMARK_WIDTH + 12),
    'the compact art is centered in the wider body',
  );
  assert.equal(
    renderWordmarkForWidth(COMPACT_WORDMARK_WIDTH - 1, { color: false }),
    undefined,
    'too narrow for any tier',
  );
});

test('the wordmark centers at odd and even widths', () => {
  const widths: Array<[number, number]> = [
    [WORDMARK_WIDTH, WORDMARK_WIDTH],
    [WORDMARK_WIDTH + 1, WORDMARK_WIDTH],
    [78, WORDMARK_WIDTH],
    [79, WORDMARK_WIDTH],
    [80, WORDMARK_WIDTH],
    [81, WORDMARK_WIDTH],
    [COMPACT_WORDMARK_WIDTH, COMPACT_WORDMARK_WIDTH],
    [COMPACT_WORDMARK_WIDTH + 1, COMPACT_WORDMARK_WIDTH],
    [60, COMPACT_WORDMARK_WIDTH],
    [61, COMPACT_WORDMARK_WIDTH],
  ];

  for (const [container, artWidth] of widths) {
    const lines = renderWordmarkForWidth(container, { color: false });
    assert.ok(lines !== undefined, `${container}-column container uses block art`);
    assert.ok(lines.every(line => visibleWidth(line) === container));
    const first = lines[0]!;
    const left = first.length - first.trimStart().length;
    const right = container - left - artWidth;
    assert.equal(left, Math.floor((container - artWidth) / 2), `${container} left padding`);
    assert.ok(Math.abs(left - right) <= 1, `${container} is visually centered`);
  }
});

test('narrow terminals fall back to the plain wordmark without overflowing', () => {
  for (const columns of [40, 56]) {
    const lines = renderDashboardLines(connectedView, { columns, rows: 24 });
    const plain = lines.map(stripAnsi).join('\n');

    assert.equal(lines.length, 24);
    assert.ok(lines.every(line => visibleWidth(line) === columns), `${columns} columns`);
    assert.match(plain, /IMPRACTICAL BOT/);
    assert.doesNotMatch(plain, /[█▌▐]/, 'the artwork is dropped when it cannot fit');
  }
});

test('the plain fallback matches the block wordmark capitalization', () => {
  assert.equal(renderPlainWordmark({ color: false }), 'IMPRACTICAL BOT');
  assert.equal(stripAnsi(renderPlainWordmark({ color: true })), 'IMPRACTICAL BOT');
});

test('the dashboard fills every supported dimension without horizontal overflow', () => {
  const dimensions: Array<[number, number]> = [
    [120, 40],
    [100, 30],
    [80, 24],
    [73, 24],
    [60, 24],
    [40, 24],
    [20, 10],
    [12, 6],
    [9, 4],
  ];

  for (const [columns, rows] of dimensions) {
    for (const color of [false, true]) {
      const lines = renderDashboardLines(
        { ...connectedView, logs: [logEntry('[poll] Poll: 1 new messages checked; 0 mention detected.')] },
        { columns, rows },
        { color },
      );
      assert.equal(lines.length, rows, `${columns}x${rows} color=${color}`);
      assert.ok(
        lines.every(line => visibleWidth(line) === columns),
        `${columns}x${rows} color=${color} keeps every line exactly ${columns} columns wide`,
      );
    }
  }

  const empty = renderDashboardLines(
    { ...connectedView, logs: [] },
    { columns: 80, rows: 24 },
    { color: true },
  ).join('\n');
  assert.match(stripAnsi(empty), new RegExp(DASHBOARD_EMPTY_LOGS_MESSAGE));
});

test('status states are compact pills with monochrome emphasis', () => {
  const cases: Array<[Partial<DashboardView>, string, string]> = [
    [{ state: 'running' }, 'Running', '37'],
    [{ state: 'paused' }, 'Paused', '1;37'],
    [{ connection: 'connecting', state: 'starting' }, 'Starting', '1;37'],
    [{ state: 'stopping' }, 'Stopping', '1;97'],
    [{ connection: 'disconnected', state: 'disconnected' }, 'Disconnected', '1;97'],
  ];

  for (const [overrides, label, code] of cases) {
    const rendered = renderDashboardLines(
      { ...connectedView, ...overrides },
      { columns: 80, rows: 24 },
      { color: true },
    ).join('\n');
    assert.match(
      rendered,
      new RegExp(`\u001b\\[${code}m ● ${label} ──`),
      `${label} uses the expected monochrome emphasis`,
    );
    assert.match(stripAnsi(rendered), new RegExp(`● ${label}`));
  }
});

test('engine state stays visible when the label cannot fit the status heading', () => {
  const cases: Array<[Partial<DashboardView>, string]> = [
    [{ state: 'paused' }, 'Paused'],
    [
      {
        connection: 'disconnected',
        state: 'disconnected',
        browser: 'Unknown',
        temperament: 'Unknown',
        personality: 'Unknown',
        messengerDestination: 'Unknown',
      },
      'Disconnected',
    ],
  ];

  for (const columns of [48, 40, 36, 32, 24, 20]) {
    for (const [overrides, label] of cases) {
      const lines = renderDashboardLines(
        { ...connectedView, ...overrides },
        { columns, rows: 20 },
        { color: true },
      );
      assert.equal(lines.length, 20, `${columns} columns fills the height`);
      assert.ok(
        lines.every(line => visibleWidth(line) <= columns),
        `${columns} columns stays inside the terminal`,
      );
      assert.ok(
        lines.some(line => stripAnsi(line).includes(`● ${label}`)),
        `${label} stays visible at ${columns} columns`,
      );
    }
  }
});

test('timestamps, categories, and metadata use a monochrome hierarchy', () => {
  const poll = formatDashboardLogLine(
    logEntry('[poll] Poll: 1 new messages checked; 1 mention detected.'),
    80,
    { color: true },
  );
  assert.match(poll, /^\u001b\[2m\[03:04:05\] \u001b\[0m/, 'timestamps are dim');
  assert.match(poll, /\u001b\[37m\[poll\]\u001b\[0m/, 'poll output uses a light-gray label');
  assert.equal(
    stripAnsi(poll),
    formatDashboardLogLine(logEntry('[poll] Poll: 1 new messages checked; 1 mention detected.'), 80),
    'styling never changes the captured text',
  );

  const timing = formatDashboardLogLine(
    logEntry('[timing] packet=packet-001 hold=4ms queue=0ms'),
    80,
    { color: true },
  );
  assert.match(timing, /\u001b\[37m\[timing\]\u001b\[0m/, 'timing labels use a light-gray label');
  assert.match(timing, /\u001b\[2mhold=\u001b\[0m/, 'secondary metadata keys are muted');

  const rng = formatDashboardLogLine(
    logEntry('[rng] Cooldown ended'),
    80,
    { color: true },
  );
  assert.match(rng, /\u001b\[37m\[rng\]\u001b\[0m/, 'rng activity uses a light-gray label');
});

test('log severity uses monochrome emphasis for warnings and errors', () => {
  const warning = formatDashboardLogLine(
    logEntry('[engine] connector stalled', 'warn'),
    80,
    { color: true },
  );
  assert.match(warning, /\u001b\[1;37m\[WARN\] \u001b\[0m/);
  assert.match(warning, /\u001b\[1;37mconnector stalled\u001b\[0m/);

  const error = formatDashboardLogLine(
    logEntry('[compose] stage=click-failed error=timeout', 'error'),
    80,
    { color: true },
  );
  assert.match(error, /\u001b\[1;97m\[ERROR\] \u001b\[0m/);
  assert.match(error, /\u001b\[1;97mclick-failed\u001b\[0m/);

  const debug = formatDashboardLogLine(
    logEntry('[identity] merged duplicate rendered record', 'debug'),
    80,
    { color: true },
  );
  assert.match(debug, /\u001b\[2m\[DEBUG\] \u001b\[0m/);

  const success = formatDashboardLogLine(
    logEntry('[packet packet-001] stage=complete status=sent delivery=unconfirmed'),
    80,
    { color: true },
  );
  assert.match(success, /\u001b\[37msent\u001b\[0m/, 'successful values use light-gray emphasis');
  assert.match(success, /\u001b\[1;37munconfirmed\u001b\[0m/, 'unconfirmed delivery is bold gray');
  assert.match(success, /\u001b\[37m\[packet packet-001\]\u001b\[0m/);
});

test('long log messages are truncated inside the panel and stay well formed', () => {
  const long = formatDashboardLogLine(
    logEntry('[engine] ' + 'x'.repeat(300)),
    40,
    { color: true },
  );
  assert.equal(visibleWidth(long), 40);
  assert.match(stripAnsi(long), /…$/);

  const lines = renderDashboardLines(
    { ...connectedView, logs: [logEntry('[engine] ' + 'x'.repeat(300))] },
    { columns: 40, rows: 24 },
    { color: true },
  );
  assert.ok(lines.every(line => visibleWidth(line) === 40));
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /\u001b(?!\[[0-9;]*m)/, 'only complete SGR sequences are emitted');

  const injected = formatDashboardLogLine(
    logEntry('\u001b[31mred\u001b[0m \u001b[1;2Hclear'),
    80,
    { color: true },
  );
  assert.doesNotMatch(injected, /\[1;2H/, 'cursor controls from captured output are removed');
  assert.match(stripAnsi(injected), /red clear/);
  assert.equal(
    escapeCodes(injected).every(code => code.startsWith('\u001b[')),
    true,
  );
});

test('command chips and prompts render in the styled layout', () => {
  const normal = renderDashboardLines(
    connectedView,
    { columns: 80, rows: 24 },
    { color: true },
  ).join('\n');
  assert.match(stripAnsi(normal), /\[P\] pause/);
  assert.match(stripAnsi(normal), /\[M\] changemsgUrl/);
  assert.match(stripAnsi(normal), /\[D\] Enter debug/);
  assert.match(normal, /\u001b\[90mBrowser: \u001b\[0m/, 'dashboard labels use medium gray');
  assert.match(normal, /\u001b\[1;37mENGINE STATUS\u001b\[0m/, 'section headings use bold light gray');
  assert.match(normal, /\u001b\[37m\[P\]\u001b\[0m/, 'command keys use the light-gray brand tone');

  const promptView: DashboardView = {
    ...connectedView,
    prompt: { kind: 'destination', value: 'https://example.com/messages/t/1' },
  };
  const prompt = renderDashboardLines(
    promptView,
    { columns: 80, rows: 24 },
    { color: true },
  );
  const plainPrompt = prompt.map(stripAnsi).join('\n');
  assert.match(plainPrompt, /Destination URL: https:\/\/example\.com\/messages\/t\/1/);
  assert.doesNotMatch(plainPrompt, /\[D\] Enter debug/);

  const cursor = getDashboardPromptCursor(promptView, { columns: 80, rows: 24 });
  assert.ok(cursor);
  assert.ok(cursor.row >= 1 && cursor.row <= 24);
  assert.ok(cursor.column >= 1 && cursor.column <= 80);
});

test('rapid styled log updates keep the panel intact and restore the terminal', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    color: true,
    now: () => fixedTimestamp,
  });

  try {
    await waitFor(() => output.text().includes('LIVE LOGS'));
    for (let index = 0; index < 60; index += 1) {
      console.log(`[poll] update ${index}`);
    }
    output.emit('resize');
    const lastFrame = (): string => {
      const text = output.text();
      const start = text.lastIndexOf('\u001b[2J');
      return start === -1 ? text : text.slice(start);
    };
    await waitFor(() => stripAnsi(lastFrame()).includes('update 59'));

    const frame = lastFrame();
    const plain = stripAnsi(frame);
    assert.match(plain, /LIVE LOGS/);
    assert.match(plain, /\[poll\] update 59/);
    assert.doesNotMatch(plain, /update 0\b/, 'older log lines have scrolled out of the panel');
    assert.match(frame, /\u001b\[2m\[03:04:05\] \u001b\[0m/);
    assert.match(frame, /\u001b\[37m\[poll\]\u001b\[0m/);
  } finally {
    input.emit('data', Buffer.from('d'));
    await session.closed;
  }

  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.readableFlowing, false);
  assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
});
