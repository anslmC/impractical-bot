import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  RuntimeAlreadyRunningError,
  RuntimeControlEndpointError,
  RuntimeControlTimeoutError,
} from '../src/runtime-control.js';
import {
  formatTuiErrorMessage,
  reportTuiDestinationFailure,
  reportTuiError,
  reportTuiStatusPollingFailure,
} from '../src/tui/errors.js';
import {
  captureConsoleOutput,
  DashboardTerminalError,
  startDashboard,
  type DashboardCommandApi,
} from '../src/tui/index.js';

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

async function flush(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const runningStatus: RuntimeStatusSnapshotResult = {
  status: 'running',
  instanceId: 'test-instance',
  state: 'running',
  browser: 'brave',
  temperament: 'balanced',
  personality: 'default',
  messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
};

function commandApi(overrides: Partial<DashboardCommandApi> = {}): DashboardCommandApi {
  return {
    pause: async () => ({ status: 'paused', instanceId: 'test-instance' }),
    resume: async () => ({ status: 'resumed', instanceId: 'test-instance' }),
    stop: async () => ({ status: 'stopped', instanceId: 'test-instance' }),
    changeDestination: async () => ({
      status: 'changed',
      instanceId: 'test-instance',
      resumed: true,
    }),
    setTemperament: async temperament => ({
      status: 'changed',
      instanceId: 'test-instance',
      temperament,
    }),
    setPersonality: async (mode, instruction) => ({
      status: 'changed',
      instanceId: 'test-instance',
      mode,
      instruction,
    }),
    ...overrides,
  };
}

test('TUI error formatting maps known failures to concise category-specific messages', () => {
  assert.equal(
    formatTuiErrorMessage('pause', new RuntimeControlTimeoutError('Timed out waiting.')),
    'Pause timed out. Try again.',
  );
  assert.equal(
    formatTuiErrorMessage(
      'runtime',
      new RuntimeControlEndpointError('The runtime-control endpoint is not owned by an engine.'),
    ),
    'Command failed. Connection lost.',
  );
  assert.equal(
    formatTuiErrorMessage('runtime', new RuntimeAlreadyRunningError()),
    'Engine is already running.',
  );
  assert.equal(
    formatTuiErrorMessage('destination', 'A destination change is already in progress.'),
    'Destination change already in progress.',
  );
  assert.equal(
    formatTuiErrorMessage(
      'destination',
      new Error('A destination change is already in progress.'),
    ),
    'Destination change already in progress.',
  );
  assert.equal(
    formatTuiErrorMessage(
      'destination',
      'The requested destination could not be opened or verified. Timeout.',
    ),
    'Destination unavailable. Previous destination restored.',
  );
  assert.equal(
    formatTuiErrorMessage('destination', 'The previous destination could not be restored.'),
    'Destination change failed. Rollback incomplete.',
  );
  assert.equal(
    formatTuiErrorMessage(
      'temperament',
      'The temperament could not be saved. Configuration is malformed.',
    ),
    'Configuration update failed. See the logs.',
  );
  assert.equal(
    formatTuiErrorMessage('personality', 'The personality update failed.'),
    'Personality change failed. See the logs.',
  );
  assert.equal(
    formatTuiErrorMessage('status', 'unexpected status response'),
    'Engine status unavailable.',
  );
  assert.equal(
    formatTuiErrorMessage('browser', 'Browser interaction failed.'),
    'Browser interaction failed. See the logs.',
  );
  assert.equal(
    formatTuiErrorMessage('runtime', new Error('unexpected command failure')),
    'Command failed. See the logs.',
  );

  for (const message of [
    formatTuiErrorMessage('pause', new Error('unexpected failure')),
    formatTuiErrorMessage('destination', new Error('unexpected failure')),
    formatTuiErrorMessage('temperament', new Error('unexpected failure')),
    formatTuiErrorMessage('personality', new Error('unexpected failure')),
  ]) {
    assert.ok(message.split(/\s+/).length <= 10, `${message} should stay concise`);
  }
});

test('diagnostics are logged with redaction before a concise message is returned', () => {
  const capture = captureConsoleOutput(20, { now: () => new Date(2024, 0, 2, 3, 4, 5) });
  try {
    const message = reportTuiError(
      'pause',
      new Error('pause failed apiKey=super-secret Authorization: Bearer another-secret'),
    );
    assert.equal(message, 'Pause failed. See the logs.');

    const logs = capture.getLines().join('\n');
    assert.match(logs, /\[dashboard\] Pause failed: pause failed/);
    assert.match(logs, /apiKey=\[REDACTED\]/);
    assert.match(logs, /Authorization: \[REDACTED\]/);
    assert.doesNotMatch(logs, /super-secret|another-secret/);
    assert.doesNotMatch(message, /super-secret|another-secret/);

    const destination = reportTuiDestinationFailure(
      'rejected',
      'The requested destination could not be opened or verified. apiKey=super-secret',
      true,
    );
    assert.equal(
      destination,
      'Destination unavailable. Previous destination restored. Engine resumed.',
    );
    assert.match(capture.getLines().join('\n'), /Destination change rejected:/);
    assert.match(capture.getLines().join('\n'), /apiKey=\[REDACTED\]/);

    reportTuiStatusPollingFailure(new Error('status probe failed Authorization: Bearer token-value'));
    const statusLog = capture.getLines().at(-1) ?? '';
    assert.match(statusLog, /\[dashboard\] Status polling failed: status probe failed/);
    assert.match(statusLog, /Authorization: \[REDACTED\]/);
    assert.doesNotMatch(statusLog, /token-value/);
  } finally {
    capture.restore();
  }
});

test('dashboard logs full errors to LIVE LOGS while the footer stays concise', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 200;
  output.rows = 30;
  const rawDetail = `The engine rejected the pause request (BUSY). ${'detail '.repeat(8)}END-OF-DETAIL`;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    commands: commandApi({
      pause: async () => {
        throw new Error(rawDetail);
      },
    }),
  });

  try {
    await waitFor(() => output.text().includes('Running'));
    input.emit('data', Buffer.from('p'));

    await waitFor(() => output.text().includes('Error: Pause failed. See the logs.'));
    await waitFor(() => output.text().includes('[dashboard] Pause failed:'));
    assert.match(output.text(), /engine rejected the pause request/);
    assert.match(output.text(), /END-OF-DETAIL/);
    assert.doesNotMatch(output.text(), /Error: The engine rejected the pause request/);
  } finally {
    await session.close();
  }
});

test('dashboard startup failures stay concise while retaining terminal diagnostics', async () => {
  const input = new FakeInput();
  input.isTTY = false;
  const output = new FakeOutput();
  let detail = '';

  await assert.rejects(
    startDashboard({
      input: streamInput(input),
      output: streamOutput(output),
      requestStatus: async () => runningStatus,
    }),
    error => {
      assert.ok(error instanceof DashboardTerminalError);
      assert.equal(error.message, 'Dashboard requires an interactive terminal.');
      detail = error.detail;
      return true;
    },
  );
  assert.match(detail, /stdin is not an interactive terminal/);
});

test('status polling failures are logged once per identical detail without flooding', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => {
      throw new Error('engine dropped');
    },
    captureConsoleOutput: true,
  });

  try {
    await waitFor(() => output.text().includes('Status polling failed: engine dropped'));
    assert.match(output.text(), /Disconnected/);

    await session.refresh();
    await session.refresh();
    await session.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));

    const occurrences =
      output.text().match(/Status polling failed: engine dropped/g) ?? [];
    assert.equal(occurrences.length, 1);
  } finally {
    await session.close();
  }
});

test('error notices dismiss after six seconds without clearing status or diagnostics', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 200;
  output.rows = 30;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    commands: commandApi({
      pause: async () => {
        throw new Error('pause detail remains in the logs');
      },
    }),
  });

  try {
    await flush();
    input.emit('data', Buffer.from('p'));
    await flush();

    assert.match(output.text(), /Error: Pause failed\. See the logs\./);
    assert.match(output.text(), /\[dashboard\] Pause failed: pause detail remains in the logs/);

    const beforeTimeout = output.writes.length;
    context.mock.timers.tick(5_999);
    await flush();
    assert.equal(output.writes.length, beforeTimeout);

    context.mock.timers.tick(1);
    await flush();
    const dismissedWrites = output.writes.slice(beforeTimeout).join('');
    assert.doesNotMatch(dismissedWrites, /Pause failed/);
    assert.match(dismissedWrites, /Status: Connected/);

    assert.match(output.text(), /Running/);
    assert.match(output.text(), /\[dashboard\] Pause failed: pause detail remains in the logs/);
  } finally {
    await session.close();
    context.mock.timers.reset();
  }
});

test('a newer error replaces the previous notice and survives the older timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 200;
  output.rows = 30;
  let pauseAttempts = 0;
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    commands: commandApi({
      pause: async () => {
        pauseAttempts += 1;
        if (pauseAttempts === 1) {
          throw new RuntimeControlTimeoutError('old pause detail');
        }
        throw new RuntimeControlEndpointError(
          'The runtime-control endpoint is not owned by an engine.',
        );
      },
    }),
  });

  try {
    await flush();
    input.emit('data', Buffer.from('p'));
    await flush();
    assert.match(output.text(), /Error: Pause timed out\. Try again\./);

    const afterFirst = output.writes.length;
    context.mock.timers.tick(5_000);
    await flush();

    input.emit('data', Buffer.from('p'));
    await flush();
    const secondWrites = output.writes.slice(afterFirst).join('');
    assert.match(secondWrites, /Pause failed\. Connection lost\./);
    assert.doesNotMatch(secondWrites, /Pause timed out/);

    const afterSecond = output.writes.length;
    context.mock.timers.tick(1_000);
    await flush();
    assert.equal(output.writes.length, afterSecond);

    context.mock.timers.tick(4_999);
    await flush();
    assert.equal(output.writes.length, afterSecond);

    context.mock.timers.tick(1);
    await flush();
    const dismissedWrites = output.writes.slice(afterSecond).join('');
    assert.doesNotMatch(dismissedWrites, /Pause failed/);
    assert.match(dismissedWrites, /Status: Connected/);
  } finally {
    await session.close();
    context.mock.timers.reset();
  }
});

test('closing the dashboard cancels a pending error dismissal timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new FakeInput();
  const output = new FakeOutput();
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus,
    captureConsoleOutput: true,
    commands: commandApi({
      pause: async () => {
        throw new Error('pause detail');
      },
    }),
  });

  try {
    await flush();
    input.emit('data', Buffer.from('p'));
    await flush();
    assert.match(output.text(), /Error: Pause failed\. See the logs\./);

    const originalClearTimeout = global.clearTimeout;
    let clearedTimers = 0;
    global.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      clearedTimers += 1;
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;

    try {
      await session.close();
    } finally {
      global.clearTimeout = originalClearTimeout;
    }

    assert.ok(clearedTimers > 0);
    const afterClose = output.writes.length;
    context.mock.timers.tick(6_000);
    await flush();
    assert.equal(output.writes.length, afterClose);
    await session.closed;
  } finally {
    await session.close();
    context.mock.timers.reset();
  }
});
