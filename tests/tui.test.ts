import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  captureConsoleOutput,
  checkDashboardTerminal,
  startDashboard,
} from '../src/tui/index.js';
import {
  createInitialDashboardView,
  renderDashboard,
  renderDashboardLines,
  type DashboardView,
} from '../src/tui/layout.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  readableFlowing: boolean | null = null;
  resumed = false;
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
    this.resumed = true;
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

const connectedView: DashboardView = {
  connection: 'connected',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

const runningStatus: RuntimeStatusSnapshotResult = {
  status: 'running',
  instanceId: 'test-instance',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

test('dashboard layout renders every field within the requested dimensions', () => {
  const dimensions = { columns: 80, rows: 24 };
  const lines = renderDashboardLines(connectedView, dimensions);
  const rendered = lines.join('\n');

  assert.equal(lines.length, dimensions.rows);
  assert.ok(lines.every(line => line.length === dimensions.columns));
  assert.match(rendered, /Running/);
  assert.match(rendered, /Browser:\s+brave/);
  assert.match(rendered, /Temperament:\s+Balanced/);
  assert.match(rendered, /Personality:\s+Default/);
  assert.match(rendered, /1618007223454558/);
  assert.match(rendered, /COMMANDS/);
  assert.match(rendered, /\[C\] Close dashboard/);
  assert.doesNotMatch(rendered, /\[Q\]/);
  assert.doesNotMatch(rendered, /\[Esc\]/);
  assert.doesNotMatch(rendered, /start --tui/);
  assert.doesNotMatch(rendered, /\btui\b/);

  const commands = [
    ['P', 'pause', 'Pause Impractical Bot'],
    ['M', 'changemsgUrl', 'Change Messenger destination'],
    ['T', 'setbottemp', 'Set bot temperament'],
    ['Y', 'setpersonality', 'Set bot personality'],
    ['S', 'stop', 'Stop Impractical Bot'],
  ] as const;
  for (const [key, name, description] of commands) {
    assert.match(rendered, new RegExp(`\\[${key}\\] ${name}\\s+${description}`));
  }
  assert.doesNotMatch(rendered, /\[R\] resume/);

  const paused = renderDashboardLines(
    { ...connectedView, state: 'paused' },
    dimensions,
  ).join('\n');
  assert.match(paused, /\[R\] resume\s+Resume Impractical Bot/);
  assert.doesNotMatch(paused, /\[P\] pause/);
  assert.match(paused, /\[M\] changemsgUrl/);
  assert.match(paused, /\[S\] stop/);

  const excludedCommands = [
    'init',
    'config',
    'changebrowser',
    'updatekey',
    'start',
  ] as const;
  for (const name of excludedCommands) {
    assert.doesNotMatch(rendered, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(rendered, /Initialize Impractical Bot/);
  assert.doesNotMatch(rendered, /Configure Impractical Bot/);
  assert.doesNotMatch(rendered, /Change the configured browser/);
  assert.doesNotMatch(rendered, /Replace the NVIDIA API key/);
  assert.doesNotMatch(rendered, /Start Impractical Bot/);
});

test('dashboard layout truncates long values and handles tiny terminals', () => {
  const longDestination = 'https://www.facebook.com/messages/t/' + '9'.repeat(300);
  const lines = renderDashboardLines(
    { ...connectedView, messengerDestination: longDestination },
    { columns: 40, rows: 24 },
  );

  assert.ok(lines.every(line => line.length === 40));
  assert.match(lines.join('\n'), /…/);

  const tinyLines = renderDashboardLines(connectedView, { columns: 9, rows: 4 });
  assert.equal(tinyLines.length, 4);
  assert.ok(tinyLines.every(line => line.length <= 9));
  assert.equal(renderDashboard(connectedView, { columns: 0, rows: 24 }), '');
});

test('dashboard layout shows initial and disconnected states without stale values', () => {
  const initial = renderDashboardLines(createInitialDashboardView(), {
    columns: 60,
    rows: 24,
  }).join('\n');
  assert.match(initial, /Starting/);
  assert.match(initial, /Unknown/);

  const disconnected = renderDashboardLines(
    {
      connection: 'disconnected',
      state: 'disconnected',
      browser: 'Unknown',
      temperament: 'Unknown',
      personality: 'Unknown',
      messengerDestination: 'Unknown',
    },
    { columns: 60, rows: 24 },
  ).join('\n');
  assert.match(disconnected, /Disconnected/);
  assert.doesNotMatch(disconnected, /Running/);
});

test('dashboard terminal preflight requires TTY stdin, TTY stdout, and raw mode', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  assert.deepEqual(checkDashboardTerminal(streamInput(input), streamOutput(output)), { ok: true });

  input.isTTY = false;
  assert.equal(checkDashboardTerminal(streamInput(input), streamOutput(output)).ok, false);

  input.isTTY = true;
  output.isTTY = false;
  assert.equal(checkDashboardTerminal(streamInput(input), streamOutput(output)).ok, false);

  output.isTTY = true;
  input.setRawMode = undefined as unknown as FakeInput['setRawMode'];
  assert.equal(checkDashboardTerminal(streamInput(input), streamOutput(output)).ok, false);
});

test('dashboard restores the terminal for C and closes idempotently', async () => {
  for (const key of ['c', 'C']) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const session = await startDashboard({
      input: streamInput(input),
      output: streamOutput(output),
      pollIntervalMs: 60_000,
      requestStatus: async () => runningStatus,
    });

    assert.deepEqual(input.rawModes, [true]);
    assert.match(output.text(), /\u001b\[\?1049h/);
    assert.match(output.text(), /\u001b\[\?25l/);
    assert.match(output.text(), /Running/);

    input.emit('data', Buffer.from(key));
    await session.closed;
    await session.close();
    await session.close();

    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('error'), 0);
    assert.equal(output.listenerCount('resize'), 0);
    assert.equal(output.listenerCount('error'), 0);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.pauses, 1);
    assert.match(output.text(), /\u001b\[\?25h\u001b\[\?1049l$/);
  }
});

test('dashboard Ctrl+C delegates interruption and pauses resumed input when closed', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalLog = console.log;
  let interrupts = 0;

  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    onInterrupt: () => {
      interrupts += 1;
    },
  });

  try {
    assert.equal(input.readableFlowing, true);
    assert.notEqual(console.log, originalLog);

    input.emit('data', Buffer.from('\u0003'));
    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(interrupts, 1);
    assert.equal(input.listenerCount('data'), 1);
    assert.deepEqual(input.rawModes, [true]);
  } finally {
    await session.close();
  }

  assert.equal(input.readableFlowing, false);
  assert.equal(input.pauses, 1);
  assert.equal(input.listenerCount('data'), 0);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(console.log, originalLog);
});

test('dashboard preserves an input that was already flowing before it started', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.resume();

  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
  });
  await session.close();

  assert.equal(input.readableFlowing, true);
  assert.equal(input.pauses, 0);
  assert.equal(input.listenerCount('data'), 0);
});

test('dashboard ignores Q and Escape until C closes it', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
  });

  for (const key of ['q', 'Q', '\u001b']) {
    input.emit('data', Buffer.from(key));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(input.listenerCount('data'), 1);
    assert.deepEqual(input.rawModes, [true]);
  }

  input.emit('data', Buffer.from('c'));
  await session.closed;
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
});

test('dashboard polling never overlaps and recovers after a disconnected result', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let requests = 0;
  let resolveFirst!: (result: RuntimeStatusSnapshotResult) => void;
  const firstRequest = new Promise<RuntimeStatusSnapshotResult>(resolve => {
    resolveFirst = resolve;
  });
  let shouldThrow = false;

  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => {
      requests += 1;
      if (requests === 1) {
        return firstRequest;
      }
      if (shouldThrow) {
        throw new Error('engine dropped');
      }
      return runningStatus;
    },
  });

  await waitFor(() => requests === 1);
  await session.refresh();
  await session.refresh();
  assert.equal(requests, 1);

  resolveFirst(runningStatus);
  await waitFor(() => output.text().includes('Running'));
  await session.refresh();
  assert.equal(requests, 2);

  shouldThrow = true;
  await session.refresh();
  assert.equal(requests, 3);
  await waitFor(() => output.text().includes('Disconnected'));
  assert.doesNotMatch(output.text().split('\u001b[2K').at(-1) ?? '', /Running/);

  shouldThrow = false;
  await session.refresh();
  assert.equal(requests, 4);
  await waitFor(() => output.text().split('\u001b[2K').at(-1)?.includes('Connected') === true);

  await session.close();
});

test('dashboard renders stopped and unsupported engine results without assuming running', async () => {
  const cases: Array<[RuntimeStatusSnapshotResult, RegExp]> = [
    [{ status: 'not-running' }, /Stopped/],
    [{ status: 'unsupported', instanceId: 'old-instance' }, /Status unavailable/],
  ];

  for (const [result, expected] of cases) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const session = await startDashboard({
      input: streamInput(input),
      output: streamOutput(output),
      pollIntervalMs: 60_000,
      requestStatus: async () => result,
    });

    await waitFor(() => expected.test(output.text()));
    assert.doesNotMatch(output.text(), /Running/);
    await session.close();
  }
});

test('dashboard console capture is bounded and restores the original console', async () => {
  const originalLog = console.log;
  const capture = captureConsoleOutput(2);
  try {
    console.log('one');
    console.log('two');
    console.log('three');
    assert.deepEqual(capture.getLines(), ['two', 'three']);
    capture.restore();
    assert.equal(console.log, originalLog);
  } finally {
    capture.restore();
  }

  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
  });
  assert.notEqual(console.log, originalLog);
  await session.close();
  assert.equal(console.log, originalLog);
});
