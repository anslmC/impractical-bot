import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  DashboardLogBuffer,
  startDashboard,
  startDebugView,
  type DashboardLogEntry,
} from '../src/tui/index.js';
import {
  renderDashboardFrame,
  renderDashboardLines,
} from '../src/tui/layout.js';
import { formatDashboardLogEntries } from '../src/tui/logs.js';
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
  rows = 20;
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

function entries(count: number): DashboardLogEntry[] {
  return Array.from({ length: count }, (_, index) => logEntry(`entry-${index + 1}`));
}

function messageLine(id: string, content: string): string {
  return `  - id=${id}; text=${JSON.stringify(content)}`;
}

function contextStoreBlock(): DashboardLogEntry[] {
  const border = '='.repeat(80);
  const added = Array.from({ length: 10 }, (_, index) =>
    messageLine(`m${index}`, `recent message ${index}`));
  const retained = Array.from({ length: 12 }, (_, index) =>
    messageLine(`r${index}`, `retained message ${index}`));
  return [
    border,
    'CONTEXT STORE UPDATE',
    border,
    'Newly appended:       10',
    'Currently retained:   12',
    'Maximum capacity:     60',
    'New messages:',
    ...added,
    'Evicted this update (1):',
    messageLine('old', 'evicted message'),
    'Full retained store, in observation order:',
    ...retained,
    border,
  ].map(message => logEntry(message));
}

test('dashboard PageUp and PageDown scroll by visible rendered rows', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: entries(40),
  });

  try {
    const initial = session.getScrollState();
    assert.equal(initial.offset, 0);
    assert.equal(initial.pinned, true);
    assert.ok(initial.visibleLines > 0);

    const initialText = stripAnsi(output.text());
    assert.match(initialText, /\[PgUp\/PgDn\] Scroll/);
    assert.match(initialText, /\[L\] Latest/);
    assert.doesNotMatch(initialText, /SCROLLBACK/);

    input.emit('data', Buffer.from('\u001b[5~'));
    const scrolled = session.getScrollState();
    assert.equal(scrolled.offset, initial.visibleLines);
    assert.equal(scrolled.pinned, false);
    const scrolledText = stripAnsi(output.text());
    assert.match(scrolledText, /● SCROLLBACK/);
    assert.match(scrolledText, /\[L\] Latest/);

    input.emit('data', Buffer.from('\u001b[6~'));
    assert.equal(session.getScrollState().offset, 0);
    assert.equal(session.getScrollState().pinned, true);
  } finally {
    await session.close();
  }
});

test('dashboard navigation renders older, newer, and latest log rows', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const initial = Array.from({ length: 40 }, (_, index) =>
    logEntry(`row-${String(index + 1).padStart(2, '0')}`));
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: initial,
  });

  try {
    const newest = /row-40\b/;

    let mark = output.writes.length;
    input.emit('data', Buffer.from('\u001b[5~'));
    const olderDelta = stripAnsi(output.writes.slice(mark).join(''));
    assert.equal(session.getScrollState().offset, session.getScrollState().visibleLines);
    assert.doesNotMatch(olderDelta, newest);
    assert.match(olderDelta, /row-\d{2}/);

    mark = output.writes.length;
    input.emit('data', Buffer.from('\u001b[6~'));
    const newerDelta = stripAnsi(output.writes.slice(mark).join(''));
    assert.match(newerDelta, newest);
    assert.equal(session.getScrollState().pinned, true);

    input.emit('data', Buffer.from('\u001b[5~'));
    input.emit('data', Buffer.from('\u001b[5~'));
    assert.equal(session.getScrollState().pinned, false);

    mark = output.writes.length;
    input.emit('data', Buffer.from('l'));
    const latestDelta = stripAnsi(output.writes.slice(mark).join(''));
    assert.match(latestDelta, newest);
    assert.equal(session.getScrollState().pinned, true);
    assert.equal(session.getScrollState().unseenCount, 0);
  } finally {
    await session.close();
  }
});

test('dashboard keeps the visible log window anchored when new entries arrive', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(200);
  for (const entry of entries(40)) {
    buffer.add(entry);
  }
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    logBuffer: buffer,
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    input.emit('data', Buffer.from('\u001b[5~'));
    const before = session.getScrollState();
    assert.ok(before.offset > 0);

    const view = {
      connection: 'connected' as const,
      state: 'running' as const,
      browser: 'brave',
      temperament: 'balanced',
      personality: 'default',
      messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
    };
    const dimensions = { columns: 80, rows: 20 };
    const beforeLines = renderDashboardFrame(
      { ...view, logs: buffer.getEntries() },
      dimensions,
      { scrollOffset: before.offset },
    ).lines.map(stripAnsi);
    const headingIndex = beforeLines.findIndex(line => line.includes('LIVE LOGS'));
    const footerIndex = beforeLines.findIndex(line => line.includes('Status: Connected'));
    assert.ok(headingIndex >= 0);
    assert.ok(footerIndex > headingIndex);

    buffer.add(logEntry('fresh-entry'));
    const after = session.getScrollState();
    assert.equal(after.offset, before.offset + 1);
    assert.equal(after.unseenCount, 1);

    const afterLines = renderDashboardFrame(
      { ...view, logs: buffer.getEntries() },
      dimensions,
      { scrollOffset: after.offset },
    ).lines.map(stripAnsi);
    assert.deepEqual(
      afterLines.slice(headingIndex + 1, footerIndex),
      beforeLines.slice(headingIndex + 1, footerIndex),
    );
  } finally {
    await session.close();
  }
});

test('dashboard keeps the visible log window anchored across buffer eviction', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(40);
  for (const entry of entries(40)) {
    buffer.add(entry);
  }
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    logBuffer: buffer,
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    input.emit('data', Buffer.from('\u001b[5~'));
    const before = session.getScrollState();
    assert.ok(before.offset > 0);
    assert.equal(before.totalLines, 40);

    const view = {
      connection: 'connected' as const,
      state: 'running' as const,
      browser: 'brave',
      temperament: 'balanced',
      personality: 'default',
      messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
    };
    const dimensions = { columns: 80, rows: 20 };
    const beforeLines = renderDashboardFrame(
      { ...view, logs: buffer.getEntries() },
      dimensions,
      { scrollOffset: before.offset },
    ).lines.map(stripAnsi);
    const headingIndex = beforeLines.findIndex(line => line.includes('LIVE LOGS'));
    const footerIndex = beforeLines.findIndex(line => line.includes('Status: Connected'));
    assert.ok(headingIndex >= 0);
    assert.ok(footerIndex > headingIndex);

    buffer.add(logEntry('fresh-entry'));
    const after = session.getScrollState();
    assert.equal(after.totalLines, before.totalLines);
    assert.equal(after.offset, before.offset + 1);
    assert.equal(after.unseenCount, 1);

    const afterLines = renderDashboardFrame(
      { ...view, logs: buffer.getEntries() },
      dimensions,
      { scrollOffset: after.offset },
    ).lines.map(stripAnsi);
    assert.deepEqual(
      afterLines.slice(headingIndex + 1, footerIndex),
      beforeLines.slice(headingIndex + 1, footerIndex),
    );
  } finally {
    await session.close();
  }
});

test('dashboard arrow, Home, and End keys scroll as terminal fallbacks', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: entries(40),
  });

  try {
    input.emit('data', Buffer.from('\u001b[A'));
    assert.equal(session.getScrollState().offset, 1);
    input.emit('data', Buffer.from('\u001b[B'));
    assert.equal(session.getScrollState().offset, 0);
    assert.equal(session.getScrollState().pinned, true);

    input.emit('data', Buffer.from('\u001b[H'));
    const oldest = session.getScrollState();
    assert.equal(oldest.offset, oldest.maximumOffset);
    assert.equal(oldest.pinned, false);

    input.emit('data', Buffer.from('\u001b[F'));
    assert.equal(session.getScrollState().offset, 0);
    assert.equal(session.getScrollState().pinned, true);
  } finally {
    await session.close();
  }
});

test('dashboard scroll controls leave the fixed chrome in place at VS Code dimensions', () => {
  const logs = Array.from({ length: 34 }, (_, index) =>
    logEntry(`layout-entry-${String(index + 1).padStart(2, '0')}`));
  const view = {
    connection: 'connected' as const,
    state: 'running' as const,
    browser: 'brave',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
    logs,
  };
  const dimensions = { columns: 190, rows: 41 };
  const pinned = renderDashboardFrame(view, dimensions);
  const pinnedLines = pinned.lines.map(stripAnsi);
  const headingIndex = pinnedLines.findIndex(line => line.includes('LIVE LOGS'));
  const pinnedFooter = pinnedLines.at(-1) ?? '';

  assert.ok(pinned.state.maximumOffset > 0);
  assert.ok(headingIndex > 0);
  assert.match(pinnedFooter, /Status: Connected/);
  assert.match(pinnedFooter, /\[PgUp\/PgDn\] Scroll/);
  assert.match(pinnedFooter, /\[L\] Latest/);
  assert.doesNotMatch(pinnedFooter, /SCROLLBACK/);
  assert.ok(pinnedLines.some(line => line.includes('layout-entry-34')));
  assert.ok(!pinnedLines.some(line => line.includes('layout-entry-01')));

  const scrolled = renderDashboardFrame(view, dimensions, {
    scrollOffset: pinned.state.maximumOffset,
    unseenCount: 2,
  });
  const scrolledLines = scrolled.lines.map(stripAnsi);
  const scrolledFooter = scrolledLines.at(-1) ?? '';

  assert.deepEqual(
    scrolledLines.slice(0, headingIndex + 1),
    pinnedLines.slice(0, headingIndex + 1),
  );
  assert.equal(scrolledLines.length, pinnedLines.length);
  assert.ok(scrolledLines.some(line => line.includes('layout-entry-01')));
  assert.ok(!scrolledLines.some(line => line.includes('layout-entry-34')));
  assert.match(scrolledFooter, /Status: Connected/);
  assert.match(scrolledFooter, /● SCROLLBACK/);
  assert.match(scrolledFooter, /2 new entries/);
  assert.match(scrolledFooter, /\[L\] Latest/);
  assert.ok(scrolled.lines.every(line => visibleWidth(line) === dimensions.columns));

  const narrow = renderDashboardFrame(view, { columns: 80, rows: 20 }, {
    scrollOffset: 5,
    unseenCount: 2,
  });
  const narrowFooter = stripAnsi(narrow.lines.at(-1) ?? '');
  assert.match(narrowFooter, /● SCROLLBACK/);
  assert.match(narrowFooter, /2 new entries/);
  assert.match(narrowFooter, /\[PgUp\/PgDn\] Scroll/);
  assert.match(narrowFooter, /\[L\] Latest/);
  assert.equal(visibleWidth(narrowFooter), 80);
});

test('dashboard L jumps to latest and resumes following new output', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(200);
  for (const entry of entries(40)) {
    buffer.add(entry);
  }
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    logBuffer: buffer,
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    const before = session.getScrollState();
    assert.equal(before.pinned, false);

    buffer.add(logEntry('arrived-while-scrolled'));
    const first = session.getScrollState();
    assert.equal(first.pinned, false);
    assert.equal(first.offset, before.offset + 1);
    assert.equal(first.unseenCount, 1);

    buffer.add(logEntry('arrived-again'));
    const second = session.getScrollState();
    assert.equal(second.pinned, false);
    assert.equal(second.offset, before.offset + 2);
    assert.equal(second.unseenCount, 2);

    input.emit('data', Buffer.from('L'));
    const latest = session.getScrollState();
    assert.equal(latest.offset, 0);
    assert.equal(latest.pinned, true);
    assert.equal(latest.unseenCount, 0);

    buffer.add(logEntry('arrived-after-latest'));
    await waitFor(() => output.text().includes('arrived-after-latest'));
    assert.equal(session.getScrollState().pinned, true);
    assert.equal(session.getScrollState().unseenCount, 0);
  } finally {
    await session.close();
  }
});

test('dashboard scroll accounting uses rendered multiline rows', async () => {
  const multiline = Array.from({ length: 10 }, (_, index) =>
    logEntry(`entry-${index + 1}\ncontinued-${index + 1}`));

  const frame = renderDashboardFrame(
    {
      connection: 'connected',
      state: 'running',
      browser: 'brave',
      temperament: 'balanced',
      personality: 'default',
      messengerDestination: 'https://www.facebook.com/messages/t/1',
      logs: multiline,
    },
    { columns: 80, rows: 20 },
  );
  assert.equal(frame.state.totalLines, 20);

  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: multiline,
  });

  try {
    assert.equal(session.getScrollState().totalLines, 20);
    input.emit('data', Buffer.from('\u001b[5~'));
    assert.equal(session.getScrollState().offset, session.getScrollState().visibleLines);
    assert.equal(session.getScrollState().pinned, false);
  } finally {
    await session.close();
  }
});

test('expanded Context Store rows participate in dashboard scrolling', async () => {
  const storeEntries = contextStoreBlock();
  const expectedRows = formatDashboardLogEntries(storeEntries, 80).length;

  const storeView = {
    connection: 'connected' as const,
    state: 'running' as const,
    browser: 'brave',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: 'https://www.facebook.com/messages/t/1',
    logs: storeEntries,
  };
  const pure = renderDashboardFrame(
    storeView,
    { columns: 80, rows: 20 },
  );
  assert.equal(pure.state.totalLines, expectedRows);
  assert.ok(pure.state.totalLines > pure.state.visibleLines);
  assert.ok(expectedRows > 15, 'the compact Context Store still expands into many rows');

  const plain = renderDashboardLines(
    storeView,
    { columns: 80, rows: 20 },
    { scrollOffset: pure.state.maximumOffset },
  ).map(stripAnsi).join('\n');
  assert.match(plain, /CONTEXT STORE/);
  assert.match(plain, /Messages: 12 \/ 60/);
  assert.doesNotMatch(plain, /sender=/);
  assert.doesNotMatch(plain, /^={8,}$/m);

  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: storeEntries,
  });

  try {
    assert.equal(session.getScrollState().totalLines, expectedRows);
    input.emit('data', Buffer.from('\u001b[5~'));
    assert.equal(session.getScrollState().offset, session.getScrollState().visibleLines);
    session.scrollToStart();
    assert.equal(
      session.getScrollState().offset,
      session.getScrollState().maximumOffset,
    );
    session.scrollToEnd();
    assert.equal(session.getScrollState().pinned, true);
  } finally {
    await session.close();
  }
});

test('dashboard scroll offsets clamp at both boundaries', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: entries(40),
  });

  try {
    session.scrollToStart();
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
  const empty = await startDashboard({
    input: streamInput(emptyInput),
    output: streamOutput(emptyOutput),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
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

test('dashboard terminal resize recalculates the viewport and keeps scrollback', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 20;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: entries(40),
  });

  try {
    input.emit('data', Buffer.from('\u001b[5~'));
    const before = session.getScrollState();
    assert.ok(before.offset > 0);
    assert.equal(before.pinned, false);

    output.rows = 30;
    output.emit('resize');
    const after = session.getScrollState();
    assert.equal(after.totalLines, before.totalLines);
    assert.ok(after.visibleLines > before.visibleLines);
    assert.ok(after.offset > 0);
    assert.equal(after.pinned, false);

    const lines = renderDashboardLines(
      {
        connection: 'connected',
        state: 'running',
        browser: 'brave',
        temperament: 'balanced',
        personality: 'default',
        messengerDestination: 'https://www.facebook.com/messages/t/1',
        logs: entries(40),
      },
      { columns: 80, rows: 30 },
      { scrollOffset: after.offset },
    );
    assert.equal(lines.length, 30);
    assert.ok(lines.every(line => visibleWidth(line) === 80));
  } finally {
    await session.close();
  }
});

test('D still hands the dashboard terminal to the debug viewport', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const buffer = new DashboardLogBuffer(200);
  for (const entry of entries(40)) {
    buffer.add(entry);
  }
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

  input.emit('data', Buffer.from('\u001b[5~'));
  assert.equal(dashboard.getScrollState().pinned, false);
  input.emit('data', Buffer.from('d'));
  await waitFor(() => debugRequests === 1);
  assert.equal(input.listenerCount('data'), 1);
  assert.equal(input.isRaw, true);
  assert.deepEqual(input.rawModes, [true]);

  const handoff = await dashboard.closeForHandoff();
  assert.ok(handoff);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.isRaw, true);

  const debug = await startDebugView({
    input: streamInput(input),
    output: streamOutput(output),
    logBuffer: buffer,
    handoff,
  });
  try {
    assert.equal(input.listenerCount('data'), 1);
    assert.equal(input.isRaw, true);
    assert.equal(debug.getEntries().length, buffer.getEntries().length);
  } finally {
    input.emit('data', Buffer.from('\u0003'));
    await debug.closed;
  }
  assert.deepEqual(input.rawModes, [true, false]);
});

test('dashboard Ctrl+C shuts down while scrolled', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let interrupts = 0;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    initialEntries: entries(40),
    onInterrupt: () => {
      interrupts += 1;
    },
  });

  input.emit('data', Buffer.from('\u001b[5~'));
  assert.equal(session.getScrollState().pinned, false);

  input.emit('data', Buffer.from('\u0003'));
  await session.closed;

  assert.equal(interrupts, 1);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.pauses, 1);
  assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
});
