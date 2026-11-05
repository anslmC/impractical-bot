import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { format } from 'node:util';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  captureConsoleOutput,
  startDashboard,
  type DashboardLogEntry,
} from '../src/tui/index.js';
import {
  DASHBOARD_EMPTY_LOGS_MESSAGE,
  renderDashboardLines,
  type DashboardView,
} from '../src/tui/layout.js';
import {
  DashboardLogBuffer,
  formatDashboardLogLine,
  formatLogTimestamp,
  sanitizeLogText,
} from '../src/tui/logs.js';

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
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.writes.push(text);
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  timestamp = fixedTimestamp,
): DashboardLogEntry {
  return { timestamp, level, message };
}

test('console capture supports every production console method and formatting', () => {
  const entries: DashboardLogEntry[] = [];
  const capture = captureConsoleOutput(20, {
    now: () => fixedTimestamp,
    onEntry: entry => entries.push(entry),
  });
  try {
    console.log('count=%d', 2, { nested: true });
    console.info('info');
    console.warn('warn');
    console.error('error');
    console.debug('debug');
    console.trace('trace');

    assert.deepEqual(
      capture.getEntries().map(entry => entry.level),
      ['log', 'info', 'warn', 'error', 'debug', 'trace'],
    );
    assert.equal(capture.getLines()[0], 'count=2 { nested: true }');
    assert.deepEqual(entries.map(entry => entry.message), capture.getLines());
    assert.ok(capture.getEntries().every(entry =>
      entry.timestamp.getTime() === fixedTimestamp.getTime()));
  } finally {
    capture.restore();
  }
});

test('console capture never recurses when a log callback logs', () => {
  const entries: DashboardLogEntry[] = [];
  const capture = captureConsoleOutput(10, {
    onEntry: entry => {
      entries.push(entry);
      if (entry.message === 'outer') {
        console.log('nested');
      }
    },
  });
  try {
    console.log('outer');
    assert.deepEqual(entries.map(entry => entry.message), ['outer']);
  } finally {
    capture.restore();
  }
});

test('log buffer evicts the oldest entries and formats timestamps', () => {
  const buffer = new DashboardLogBuffer(3);
  for (const message of ['one', 'two', 'three', 'four', 'five']) {
    buffer.add(logEntry(message));
  }

  assert.equal(buffer.capacity, 3);
  assert.equal(buffer.size, 3);
  assert.deepEqual(buffer.getEntries().map(entry => entry.message), ['three', 'four', 'five']);
  assert.equal(formatLogTimestamp(fixedTimestamp), '03:04:05');
  assert.equal(formatLogTimestamp(new Date(Number.NaN)), '--:--:--');
});

test('captured logs strip ANSI, control characters, and secrets', () => {
  const capture = captureConsoleOutput(10, { now: () => fixedTimestamp });
  try {
    console.warn('\u001b[31mred warning\u001b[0m');
    console.error('apiKey=super-secret Authorization: Bearer another-secret');

    const entries = capture.getEntries();
    assert.equal(entries[0].message, 'red warning');
    assert.doesNotMatch(entries[0].message, /\u001b/);
    assert.match(entries[1].message, /apiKey=\[REDACTED\]/);
    assert.match(entries[1].message, /Authorization: \[REDACTED\]/);

    const rendered = formatDashboardLogLine(entries[0], 80);
    assert.doesNotMatch(rendered, /\u001b/);
    assert.match(rendered, /^\[03:04:05\] \[WARN\] red warning$/);
  } finally {
    capture.restore();
  }

  assert.equal(sanitizeLogText('\u001b[32mok\u001b[0m\tnext'), 'ok  next');
  assert.match(sanitizeLogText('password=hunter2'), /password=\[REDACTED\]/);
  assert.match(sanitizeLogText('Authorization: Bearer token-value'), /\[REDACTED\]/);
  assert.doesNotMatch(sanitizeLogText('Authorization: Bearer token-value'), /token-value/);
});

test('dashboard renders the latest bounded logs and an empty waiting message', () => {
  const logs = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
    .map(message => logEntry(message));
  const lines = renderDashboardLines(
    { ...connectedView, logs },
    { columns: 80, rows: 24 },
  );
  const rendered = lines.join('\n');

  assert.equal(lines.length, 24);
  assert.ok(lines.every(line => line.length === 80));
  assert.match(rendered, /LIVE LOGS/);
  assert.match(rendered, /\[03:04:05\] five/);
  assert.match(rendered, /\[03:04:05\] six/);
  assert.match(rendered, /\[03:04:05\] seven/);
  assert.match(rendered, /\[03:04:05\] eight/);
  assert.match(rendered, /\[03:04:05\] nine/);
  assert.doesNotMatch(rendered, /\[03:04:05\] one/);
  assert.doesNotMatch(rendered, /\[03:04:05\] two/);
  assert.doesNotMatch(rendered, /\[03:04:05\] three/);
  assert.doesNotMatch(rendered, /\[03:04:05\] four/);
  assert.match(rendered, /Status: Connected/);

  const empty = renderDashboardLines(
    { ...connectedView, logs: [] },
    { columns: 80, rows: 24 },
  ).join('\n');
  assert.match(empty, new RegExp(DASHBOARD_EMPTY_LOGS_MESSAGE.replace('.', '\\.')));
});

test('dashboard truncates long and ANSI-styled log lines safely', () => {
  const long = logEntry('\u001b[31m' + 'x'.repeat(200) + '\u001b[0m');
  const lines = renderDashboardLines(
    { ...connectedView, logs: [long] },
    { columns: 40, rows: 24 },
  );
  const logLine = lines.find(line => line.includes('[03:04:05]'));

  assert.ok(logLine);
  assert.equal(logLine.length, 40);
  assert.match(logLine, /\u2026/);
  assert.doesNotMatch(lines.join('\n'), /\u001b/);

  const tiny = renderDashboardLines(
    { ...connectedView, logs: [long] },
    { columns: 9, rows: 4 },
  );
  assert.equal(tiny.length, 4);
  assert.ok(tiny.every(line => line.length <= 9));
});

test('dashboard log updates and STATUS polling coexist without losing logs', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalLog = console.log;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    now: () => fixedTimestamp,
  });

  try {
    await waitFor(() => output.text().includes('Running'));
    console.log('poller checking for new messages');

    await waitFor(() => output.text().includes('poller checking for new messages'));
    assert.match(output.text(), /\[03:04:05\] poller checking for new messages/);

    await session.refresh();
    assert.match(output.text(), /poller checking for new messages/);
    assert.match(output.text(), /Running/);
    assert.match(output.text(), /LIVE LOGS/);
  } finally {
    await session.close();
    assert.equal(console.log, originalLog);
  }
});

test('dashboard closure restores console output and remains idempotent', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalLog = console.log;
  const directOutput: string[] = [];
  console.log = (...args: unknown[]) => {
    directOutput.push(format(...args));
  };

  try {
    const session = await startDashboard({
      input: streamInput(input),
      output: streamOutput(output),
      pollIntervalMs: 60_000,
      requestStatus: async () => runningStatus,
      captureConsoleOutput: true,
      now: () => fixedTimestamp,
    });

    console.log('during dashboard');
    await waitFor(() => output.text().includes('during dashboard'));
    assert.deepEqual(directOutput, []);

    await session.close();
    await session.close();
    console.log('after dashboard');

    assert.deepEqual(directOutput, ['after dashboard']);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.pauses, 1);
    assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
  } finally {
    console.log = originalLog;
  }
});

test('dashboard initialization and disposal failures restore console methods', async () => {
  const originalLog = console.log;
  const input = new FakeInput();
  const failingOutput = new FakeOutput();
  failingOutput.write = () => {
    throw new Error('output unavailable');
  };

  await assert.rejects(
    startDashboard({
      input: streamInput(input),
      output: streamOutput(failingOutput),
      pollIntervalMs: 60_000,
      requestStatus: async () => runningStatus,
      captureConsoleOutput: true,
    }),
    /output unavailable/,
  );
  assert.equal(console.log, originalLog);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.pauses, 1);

  const disposalInput = new FakeInput();
  const disposalOutput = new FakeOutput();
  const originalWrite = disposalOutput.write.bind(disposalOutput);
  disposalOutput.write = (chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('\u001b[?1049l')) {
      throw new Error('terminal already gone');
    }
    return originalWrite(chunk);
  };

  const session = await startDashboard({
    input: streamInput(disposalInput),
    output: streamOutput(disposalOutput),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
  });
  await assert.doesNotReject(session.close());
  assert.equal(console.log, originalLog);
  assert.deepEqual(disposalInput.rawModes, [true, false]);
});
