import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  DEBUG_EMPTY_LOGS_MESSAGE,
  DEBUG_QUIT_CONTROL,
  DEBUG_SCROLL_CONTROLS,
  DEBUG_SPINNER_FRAMES,
  DEBUG_VIEWPORT_SUBTITLE,
  DashboardTerminalError,
  formatDebugSpinnerMessage,
  renderDebugLines,
  startDashboard,
  startDebugView,
} from '../src/tui/index.js';
import {
  DashboardLogBuffer,
  captureConsoleOutput,
  formatDebugLogEntries,
  type DashboardLogEntry,
} from '../src/tui/logs.js';
import { stripAnsi, visibleWidth } from '../src/tui/theme.js';

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

function logEntry(message: string): DashboardLogEntry {
  return { timestamp: fixedTimestamp, level: 'log', message };
}

test('the debug viewport renders a compact branded header and every row in bounds', () => {
  for (const [columns, rows] of [[120, 40], [80, 24], [60, 20], [40, 12], [9, 4]] as const) {
    const lines = renderDebugLines(
      [logEntry('[engine] Runtime polling is active.')],
      { columns, rows },
    );

    assert.equal(lines.length, rows, `${columns}x${rows} fills the height`);
    assert.ok(
      lines.every(line => visibleWidth(line) === columns),
      `${columns}x${rows} keeps every line exactly ${columns} columns wide`,
    );
  }

  const rendered = renderDebugLines([], { columns: 80, rows: 24 }).map(stripAnsi).join('\n');
  assert.match(rendered, /IMPRACTICAL BOT/);
  assert.match(rendered, new RegExp(DEBUG_VIEWPORT_SUBTITLE));
  assert.match(rendered, /DEBUG LOGS/);
  assert.match(rendered, new RegExp(DEBUG_EMPTY_LOGS_MESSAGE.replace('.', '\\.')));
  assert.ok(rendered.includes(DEBUG_SCROLL_CONTROLS));
  assert.match(rendered, /● LIVE/);
});

test('the debug spinner rotates through its ASCII frames in the milestone format', () => {
  assert.deepEqual([...DEBUG_SPINNER_FRAMES], ['|', '/', '-', '\\']);
  for (const [index, frame] of DEBUG_SPINNER_FRAMES.entries()) {
    assert.equal(
      formatDebugSpinnerMessage(
        '[STARTUP] Verifying browser configuration.',
        DEBUG_SPINNER_FRAMES[index],
      ),
      `[STARTUP] ${frame} Verifying browser configuration.`,
    );
  }
  assert.equal(formatDebugSpinnerMessage('plain activity', '|'), '| plain activity');
});

test('debug activity animates one existing entry without adding log entries', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(20);
  const message = '[STARTUP] Verifying browser configuration.';
  buffer.add(logEntry(message));
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    spinnerIntervalMs: 10,
  });

  try {
    assert.equal(session.getEntries().length, 1);
    session.startActivity(message);
    await waitFor(() => DEBUG_SPINNER_FRAMES.every(
      frame => output.text().includes(`[STARTUP] ${frame} Verifying`),
    ));
    assert.equal(session.getEntries().length, 1);

    session.stopActivity();
    await new Promise(resolve => setTimeout(resolve, 20));
    const stopped = output.text();
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(output.text(), stopped, 'no spinner frames render after stopping');
    assert.equal(session.getEntries().length, 1);
    assert.equal(session.getEntries()[0].message, message);
    assert.match(
      stripAnsi(output.text()),
      /\[STARTUP\] Verifying browser configuration\./,
    );
  } finally {
    await session.close();
  }
});

test('closing the debug viewport clears an active animation timer', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(20);
  const message = '[STARTUP] Verifying browser configuration.';
  buffer.add(logEntry(message));
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    spinnerIntervalMs: 10,
  });

  session.startActivity(message);
  await waitFor(() => output.text().includes('[STARTUP] | Verifying'));
  await session.close();
  const closed = output.text();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(output.text(), closed);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
});

test('the debug viewport scrolls, pins new output, and reports unseen entries', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const initial = Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`));
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    initialEntries: initial,
    maximumLogEntries: 200,
    captureConsoleOutput: true,
    now: () => fixedTimestamp,
  });

  try {
    assert.equal(session.getScrollState().pinned, true);
    const initialLines = renderDebugLines(initial, { columns: 80, rows: 12 }).map(stripAnsi);
    assert.match(initialLines.join('\n'), /entry-40/);
    assert.doesNotMatch(initialLines.join('\n'), /entry-1\]/);

    input.emit('data', Buffer.from('\u001b[5~'));
    await waitFor(() => session.getScrollState().offset > 0);
    assert.equal(session.getScrollState().pinned, false);

    console.log('arrived while scrolled');
    await waitFor(() => session.getScrollState().unseenCount > 0);
    assert.ok(session.getScrollState().unseenCount >= 1);
    await waitFor(() => /new entr/.test(output.text()));

    input.emit('data', Buffer.from('\u001b[6~'));
    session.scrollToEnd();
    assert.equal(session.getScrollState().pinned, true);
    assert.equal(session.getScrollState().unseenCount, 0);

    console.log('arrived while pinned');
    await waitFor(() => output.text().includes('arrived while pinned'));
  } finally {
    await session.close();
  }
});

test('D is inert in the debug viewport and does not request the dashboard', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
  });
  let closed = false;
  void session.closed.then(() => {
    closed = true;
  });

  input.emit('data', Buffer.from('d'));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(closed, false);
  assert.equal(input.listenerCount('data'), 1);
  assert.doesNotMatch(output.text(), /\[D\] Dashboard/);
  await session.close();
});

test('debug console capture feeds the shared buffer and restores the console', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalLog = console.log;
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    captureConsoleOutput: true,
    now: () => fixedTimestamp,
  });

  try {
    console.log('captured debug output');
    await waitFor(() =>
      session.getEntries().some(entry => entry.message === 'captured debug output'));
    assert.notEqual(console.log, originalLog);
  } finally {
    await session.close();
  }
  assert.equal(console.log, originalLog);
});

test('D on the dashboard requests debug mode without releasing the terminal itself', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let debugRequests = 0;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    onDebug: () => {
      debugRequests += 1;
    },
  });

  input.emit('data', Buffer.from('d'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(debugRequests, 1);
  assert.equal(input.listenerCount('data'), 1);
  assert.equal(input.isRaw, true);

  await session.close();
  assert.equal(input.listenerCount('data'), 0);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
});

test('the debug viewport requires an interactive terminal', async () => {
  const input = new FakeInput();
  input.isTTY = false;
  await assert.rejects(
    startDebugView({
      input: streamInput(input),
      output: streamOutput(new FakeOutput()),
    }),
    DashboardTerminalError,
  );
});

test('split escape sequences drive PageUp and PageDown, and L returns to latest', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const entries = Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`));
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    initialEntries: entries,
    maximumLogEntries: 200,
  });

  try {
    const initial = session.getScrollState();
    assert.equal(initial.offset, 0);
    assert.equal(initial.visibleLines, 7);

    input.emit('data', Buffer.from('\u001b['));
    input.emit('data', Buffer.from('5~'));
    const pageUp = session.getScrollState();
    assert.equal(pageUp.offset, initial.visibleLines);
    assert.equal(pageUp.pinned, false);

    input.emit('data', Buffer.from('\u001b'));
    input.emit('data', Buffer.from('[6~'));
    assert.equal(session.getScrollState().offset, 0);
    assert.equal(session.getScrollState().pinned, true);

    input.emit('data', Buffer.from('l'));
    const latest = session.getScrollState();
    assert.equal(latest.offset, 0);
    assert.equal(latest.pinned, true);
    assert.equal(latest.unseenCount, 0);
  } finally {
    await session.close();
  }
});

test('L jumps to latest logs, clears unseen entries, and resumes following new output', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const buffer = new DashboardLogBuffer(200);
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    initialEntries: Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`)),
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    assert.equal(session.getScrollState().pinned, false);

    buffer.add(logEntry('arrived-before-latest'));
    assert.ok(session.getScrollState().unseenCount >= 1);
    assert.equal(session.getScrollState().pinned, false);

    input.emit('data', Buffer.from('L'));
    const latest = session.getScrollState();
    assert.equal(latest.offset, 0);
    assert.equal(latest.pinned, true);
    assert.equal(latest.unseenCount, 0);
    await waitFor(() => output.text().includes('arrived-before-latest'));

    buffer.add(logEntry('arrived-after-latest'));
    await waitFor(() => output.text().includes('arrived-after-latest'));
    assert.equal(session.getScrollState().pinned, true);
    assert.equal(session.getScrollState().unseenCount, 0);
  } finally {
    await session.close();
  }
});

test('scroll offsets clamp at both boundaries and follow-newest is explicit', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    initialEntries: Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`)),
  });

  try {
    session.scrollTo(Number.MAX_SAFE_INTEGER);
    const oldest = session.getScrollState();
    assert.equal(oldest.offset, oldest.maximumOffset);
    session.scrollBy(1_000);
    assert.equal(session.getScrollState().offset, oldest.maximumOffset);

    session.scrollToEnd();
    assert.equal(session.getScrollState().offset, 0);
    assert.equal(session.getScrollState().pinned, true);
    session.scrollBy(-1_000);
    assert.equal(session.getScrollState().offset, 0);
  } finally {
    await session.close();
  }

  const emptyInput = new FakeInput();
  const emptyOutput = new FakeOutput();
  const empty = await startDebugView({
    input: streamInput(emptyInput),
    output: streamOutput(emptyOutput),
  });
  try {
    assert.equal(empty.getScrollState().totalLines, 1);
    empty.scrollToStart();
    assert.equal(empty.getScrollState().pinned, true);
    empty.scrollToEnd();
    assert.equal(empty.getScrollState().pinned, true);
  } finally {
    await empty.close();
  }
});

test('new log entries never reset a manually selected scroll position', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const buffer = new DashboardLogBuffer(200);
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    initialEntries: Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`)),
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    const scrolled = session.getScrollState();
    assert.equal(scrolled.pinned, false);
    const offset = scrolled.offset;

    buffer.add(logEntry('arrived-while-scrolled'));
    const after = session.getScrollState();
    assert.equal(after.pinned, false);
    assert.ok(after.offset > offset, 'the viewport stays anchored while new lines arrive');
    assert.equal(after.unseenCount, 1);

    buffer.add(logEntry('arrived-again'));
    assert.equal(session.getScrollState().pinned, false);
    assert.equal(session.getScrollState().unseenCount, 2);

    session.scrollToEnd();
    buffer.add(logEntry('arrived-while-pinned'));
    await waitFor(() => session.getScrollState().pinned);
    assert.equal(session.getScrollState().unseenCount, 0);
    await waitFor(() => output.text().includes('arrived-while-pinned'));
  } finally {
    await session.close();
  }
});

test('multiline entries are counted and rendered as separate rows', () => {
  const entries = [logEntry('first line\nsecond line\nthird line')];
  const rows = renderDebugLines(entries, { columns: 40, rows: 12 });
  const plain = rows.map(stripAnsi).join('\n');

  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => visibleWidth(row) === 40));
  assert.match(plain, /first line/);
  assert.match(plain, /second line/);
  assert.match(plain, /third line/);
});

test('multiline entries participate in debug scroll accounting', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    initialEntries: [logEntry('alpha\nbeta\ngamma')],
  });

  try {
    assert.equal(session.getScrollState().totalLines, 3);
    assert.equal(session.getScrollState().visibleLines, 3);
    session.scrollToStart();
    assert.equal(session.getScrollState().offset, 0);
  } finally {
    await session.close();
  }
});

test('terminal resize recalculates the viewport without resetting scrollback', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    initialEntries: Array.from({ length: 40 }, (_, index) => logEntry(`entry-${index + 1}`)),
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    const before = session.getScrollState();
    assert.equal(before.visibleLines, 7);

    output.rows = 18;
    output.emit('resize');
    const after = session.getScrollState();
    assert.equal(after.visibleLines, 13);
    assert.equal(after.totalLines, before.totalLines);
    assert.equal(after.pinned, false);
    assert.ok(after.offset > 0);
  } finally {
    await session.close();
  }
});

test('the dashboard hands terminal ownership to debug without pausing or resetting raw mode', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 12;
  const buffer = new DashboardLogBuffer(200);
  for (let index = 0; index < 40; index += 1) {
    buffer.add(logEntry(`entry-${index + 1}`));
  }
  const expectedEntries = buffer.getEntries().length;
  let debugRequests = 0;
  const dashboard = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    logBuffer: buffer,
    onDebug: () => {
      debugRequests += 1;
    },
  });

  input.emit('data', Buffer.from('d'));
  await waitFor(() => debugRequests === 1);
  assert.equal(input.listenerCount('data'), 1);
  assert.equal(input.readableFlowing, true);
  assert.equal(input.isRaw, true);
  assert.deepEqual(input.rawModes, [true]);

  const handoff = await dashboard.closeForHandoff?.();
  assert.ok(handoff);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.readableFlowing, true);
  assert.equal(input.isRaw, true);
  assert.deepEqual(input.rawModes, [true]);

  let interrupts = 0;
  const debug = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    handoff,
    onInterrupt: () => {
      interrupts += 1;
    },
  });

  assert.equal(debug.getEntries().length, expectedEntries);
  assert.equal(input.listenerCount('data'), 1);
  assert.equal(input.readableFlowing, true);
  assert.equal(input.isRaw, true);
  assert.deepEqual(input.rawModes, [true]);
  assert.equal(input.pauses, 0);

  input.emit('data', Buffer.from('\u001b[5~'));
  assert.ok(debug.getScrollState().offset > 0);
  input.emit('data', Buffer.from('\u001b[6~'));
  assert.equal(debug.getScrollState().offset, 0);
  input.emit('data', Buffer.from('\u001b[5~'));
  input.emit('data', Buffer.from('l'));
  assert.equal(debug.getScrollState().pinned, true);

  input.emit('data', Buffer.from('d'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(input.listenerCount('data'), 1);
  assert.equal(interrupts, 0);
  assert.doesNotMatch(output.text(), /\[D\] Dashboard/);

  input.emit('data', Buffer.from('\u0003'));
  await debug.closed;

  assert.equal(interrupts, 1);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.pauses, 1);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
  assert.equal(buffer.getEntries().length, expectedEntries);
});

test('console capture ownership remains singular across nested captures', async () => {
  const originalLog = console.log;
  const manual = captureConsoleOutput(10);
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    captureConsoleOutput: true,
    now: () => fixedTimestamp,
  });

  try {
    console.log('shared capture line');
    await waitFor(() => session.getEntries().some(entry => entry.message === 'shared capture line'));
    assert.ok(manual.getLines().includes('shared capture line'));
  } finally {
    await session.close();
  }
  assert.notEqual(console.log, originalLog);
  manual.restore();
  assert.equal(console.log, originalLog);
});

test('debug Ctrl+C signals shutdown and restores the terminal', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let interrupts = 0;
  const session = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    onInterrupt: () => {
      interrupts += 1;
    },
  });

  input.emit('data', Buffer.from('\u0003'));
  await session.closed;

  assert.equal(interrupts, 1);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(input.readableFlowing, false);
  assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
});

test('debug startup failures restore listeners, raw mode, and console capture', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalLog = console.log;
  output.write = () => {
    throw new Error('output unavailable');
  };

  await assert.rejects(
    startDebugView({
      input: streamInput(input),
      output: streamOutput(output),
      captureConsoleOutput: true,
    }),
    /output unavailable/,
  );

  assert.equal(console.log, originalLog);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(output.listenerCount('error'), 0);
  assert.deepEqual(input.rawModes, []);
});

test('debug footer displays exactly the supported controls in the requested order', () => {
  const rendered = renderDebugLines([], { columns: 80, rows: 24 })
    .map(stripAnsi)
    .join('\n');
  assert.ok(rendered.includes(
    `${DEBUG_SCROLL_CONTROLS}  ${DEBUG_QUIT_CONTROL}`,
  ));
  assert.doesNotMatch(rendered, /Home\/End/);
  assert.doesNotMatch(rendered, /\[D\] Dashboard/);
  assert.doesNotMatch(rendered, /\[Q\]/);
});

test('debug rendering preserves complete Context Store diagnostics', () => {
  const border = '='.repeat(80);
  const added = [
    '  - id=m1; sender="Katsuyo"; text="recent full content"',
    '  - id=m2; sender="Alex"; text="line one\nline two"',
  ];
  const retained = Array.from({ length: 12 }, (_, index) =>
    index === 11
      ? `  - id=r11; sender="Sender 11"; text="retained message 11 NARROW-ALPHA-${'x'.repeat(80)}-NARROW-OMEGA"`
      : `  - id=r${index}; sender="Sender ${index}"; text="retained message ${index}"`);
  const entries = [
    border,
    'CONTEXT STORE UPDATE',
    border,
    'Newly appended:       2',
    'Currently retained:   12',
    'Maximum capacity:     60',
    'New messages:',
    ...added,
    'Evicted this update (1):',
    '  - id=old; sender="Old Sender"; text="evicted message"',
    'Full retained store, in observation order:',
    ...retained,
    border,
  ].map(message => logEntry(message));

  const rows = formatDebugLogEntries(entries, 100);
  const plain = rows.join('\n');

  assert.match(plain, /CONTEXT STORE UPDATE/);
  assert.match(plain, /Newly appended:\s+2/);
  assert.match(plain, /Currently retained:\s+12/);
  assert.match(plain, /Maximum capacity:\s+60/);
  assert.match(plain, /New messages:/);
  assert.match(plain, /sender="Katsuyo"/);
  assert.match(plain, /sender="Alex"/);
  assert.match(plain, /recent full content/);
  assert.match(plain, /line one/);
  assert.match(plain, /line two/);
  assert.match(plain, /evicted message/);
  assert.match(plain, /Full retained store, in observation order:/);
  assert.match(plain, /\[03:04:05\]/);
  for (let index = 0; index < 12; index += 1) {
    assert.match(plain, new RegExp(`retained message ${index}(?!\\d)`));
  }
  assert.doesNotMatch(plain, /…/, 'debug Context Store content is wrapped, not truncated');
  assert.ok(rows.every(row => visibleWidth(row) === 100));

  const narrowRows = formatDebugLogEntries(entries, 40);
  const narrow = narrowRows.map(row => row.replace(/\s+/g, '')).join('');
  assert.doesNotMatch(narrowRows.join('\n'), /…/, 'narrow terminals keep every Context Store byte');
  assert.match(narrow, /recentfullcontent/);
  assert.match(narrow, /NARROW-ALPHA/);
  assert.match(narrow, /NARROW-OMEGA/);
  assert.ok(narrowRows.every(row => visibleWidth(row) === 40));
});
