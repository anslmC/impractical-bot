import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { MAX_PERSONALITY_INSTRUCTION_CHARS } from '../src/config/configuration.js';
import type { RuntimeStatusSnapshotResult } from '../src/runtime-control.js';
import {
  startDashboard,
  type DashboardCommandApi,
} from '../src/tui/index.js';
import {
  getDashboardPromptCursor,
  renderDashboardLines,
  type DashboardView,
} from '../src/tui/layout.js';

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
  writesSince(index: number): string {
    return this.writes.slice(index).join('');
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

function runningStatus(state: 'running' | 'paused' = 'running'): RuntimeStatusSnapshotResult {
  return {
    status: 'running',
    instanceId: 'test-instance',
    state,
    browser: 'brave',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: 'https://www.facebook.com/messages/t/1618007223454558',
  };
}

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

async function startHarness(
  commands: DashboardCommandApi,
  options: {
    status?: () => RuntimeStatusSnapshotResult;
    captureConsoleOutput?: boolean;
    now?: () => Date;
  } = {},
): Promise<{
  input: FakeInput;
  output: FakeOutput;
  session: Awaited<ReturnType<typeof startDashboard>>;
  statusRequests: () => number;
}> {
  const input = new FakeInput();
  const output = new FakeOutput();
  let statusRequests = 0;
  const status = options.status ?? (() => runningStatus());
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => {
      statusRequests += 1;
      return status();
    },
    commands,
    captureConsoleOutput: options.captureConsoleOutput,
    now: options.now,
  });
  await waitFor(() => output.text().includes('Running'));
  return { input, output, session, statusRequests: () => statusRequests };
}

test('P pauses and R resumes through the injected command API', async () => {
  const events: string[] = [];
  let state: 'running' | 'paused' = 'running';
  const { input, output, session, statusRequests } = await startHarness(commandApi({
    pause: async () => {
      events.push('pause');
      state = 'paused';
      return { status: 'paused', instanceId: 'test-instance' };
    },
    resume: async () => {
      events.push('resume');
      state = 'running';
      return { status: 'resumed', instanceId: 'test-instance' };
    },
  }), { status: () => runningStatus(state) });

  try {
    const initialRequests = statusRequests();
    input.emit('data', Buffer.from('p'));
    await waitFor(() => output.text().includes('Engine paused.'));
    await waitFor(() => statusRequests() > initialRequests);
    assert.deepEqual(events, ['pause']);
    await waitFor(() => output.text().includes('● Paused'));

    input.emit('data', Buffer.from('r'));
    await waitFor(() => output.text().includes('Engine resumed.'));
    assert.deepEqual(events, ['pause', 'resume']);
    await waitFor(() => output.text().includes('● Running'));
  } finally {
    await session.close();
  }
});

test('pending operations ignore duplicate mutation keys', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let calls = 0;
  let resolvePause!: (value: { status: 'paused'; instanceId: string }) => void;
  const pause = new Promise<{ status: 'paused'; instanceId: string }>(resolve => {
    resolvePause = resolve;
  });
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus(),
    commands: commandApi({
      pause: async () => {
        calls += 1;
        return pause;
      },
    }),
  });
  try {
    await waitFor(() => output.text().includes('Running'));
    input.emit('data', Buffer.from('p'));
    await waitFor(() => output.text().includes('Pausing...'));
    input.emit('data', Buffer.from('p'));
    input.emit('data', Buffer.from('m'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.doesNotMatch(output.text(), /Destination URL:/);

    resolvePause({ status: 'paused', instanceId: 'test-instance' });
    await waitFor(() => output.text().includes('Engine paused.'));
  } finally {
    await session.close();
  }
});

test('M validates, edits, and submits a Messenger destination', async () => {
  const destinations: string[] = [];
  const { input, output, session } = await startHarness(commandApi({
    changeDestination: async destination => {
      destinations.push(destination);
      return { status: 'changed', instanceId: 'test-instance', resumed: true };
    },
  }));

  try {
    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));
    assert.match(output.text(), /\u001b\[\?25h/);

    input.emit('data', Buffer.from('https://example.com/ab'));
    input.emit('data', Buffer.from('\u001b[3~'));
    input.emit('data', Buffer.from('\u007f'));
    input.emit('data', Buffer.from('cd'));
    await waitFor(() => output.text().includes('Destination URL: https://example.com/cd'));

    input.emit('data', Buffer.from('\r'));
    await waitFor(() => destinations.length === 1);
    assert.deepEqual(destinations, ['https://example.com/cd']);
    await waitFor(() => output.text().includes('Messenger destination changed'));
  } finally {
    await session.close();
  }
});

test('invalid and empty destinations are rejected locally without calling the runtime', async () => {
  let calls = 0;
  const { input, output, session } = await startHarness(commandApi({
    changeDestination: async () => {
      calls += 1;
      return { status: 'changed', instanceId: 'test-instance', resumed: true };
    },
  }));

  try {
    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));
    input.emit('data', Buffer.from('ftp://example.com'));
    input.emit('data', Buffer.from('\r'));
    await waitFor(() => output.text().includes('Enter a valid HTTP or HTTPS URL.'));
    assert.equal(calls, 0);

    input.emit('data', Buffer.from('\u001b'));
    await new Promise(resolve => setTimeout(resolve, 50));
    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));
    const beforeSubmit = output.writes.length;
    input.emit('data', Buffer.from('\r'));
    await waitFor(() =>
      output.writesSince(beforeSubmit).includes('Enter a valid HTTP or HTTPS URL.'));
    assert.equal(calls, 0);
  } finally {
    await session.close();
  }
});

test('T selects a temperament with numeric input', async () => {
  const selected: string[] = [];
  const { input, output, session } = await startHarness(commandApi({
    setTemperament: async temperament => {
      selected.push(temperament);
      return { status: 'changed', instanceId: 'test-instance', temperament };
    },
  }));

  try {
    input.emit('data', Buffer.from('t'));
    await waitFor(() => output.text().includes('Select temperament:'));
    assert.match(output.text(), /\[1\] Quiet  \[2\] Balanced  \[3\] Talkative/);
    input.emit('data', Buffer.from('2'));
    await waitFor(() => selected.length === 1);
    assert.deepEqual(selected, ['balanced']);
    await waitFor(() => output.text().includes('Temperament set to Balanced.'));
  } finally {
    await session.close();
  }
});

test('Y supports default and custom personality flows', async () => {
  const selections: Array<[string, string]> = [];
  const { input, output, session } = await startHarness(commandApi({
    setPersonality: async (mode, instruction) => {
      selections.push([mode, instruction]);
      return { status: 'changed', instanceId: 'test-instance', mode, instruction };
    },
  }));

  try {
    input.emit('data', Buffer.from('y'));
    await waitFor(() => output.text().includes('Select personality:'));
    input.emit('data', Buffer.from('1'));
    await waitFor(() => selections.length === 1);
    assert.deepEqual(selections, [['default', '']]);
    await waitFor(() => output.text().includes('Personality set to Default.'));

    input.emit('data', Buffer.from('y'));
    await waitFor(() => output.text().includes('Select personality:'));
    input.emit('data', Buffer.from('2'));
    await waitFor(() => output.text().includes('Personality instruction:'));
    input.emit('data', Buffer.from('deadpan and concise'));
    input.emit('data', Buffer.from('\r'));
    await waitFor(() => selections.length === 2);
    assert.deepEqual(selections[1], ['custom', 'deadpan and concise']);
    await waitFor(() => output.text().includes('Personality set to Custom.'));
  } finally {
    await session.close();
  }
});

test('empty and oversized custom personality instructions are not submitted', async () => {
  let calls = 0;
  const { input, output, session } = await startHarness(commandApi({
    setPersonality: async (mode, instruction) => {
      calls += 1;
      return { status: 'changed', instanceId: 'test-instance', mode, instruction };
    },
  }));

  try {
    input.emit('data', Buffer.from('y2'));
    await waitFor(() => output.text().includes('Personality instruction:'));
    input.emit('data', Buffer.from('\r'));
    await waitFor(() => output.text().includes('Enter a personality instruction.'));
    assert.equal(calls, 0);

    input.emit('data', Buffer.from('a'.repeat(MAX_PERSONALITY_INSTRUCTION_CHARS + 5)));
    await waitFor(() =>
      output.text().includes(`Instruction too long (max ${MAX_PERSONALITY_INSTRUCTION_CHARS} characters).`));
    assert.equal(calls, 0);
  } finally {
    await session.close();
  }
});

test('Escape cancels prompts and fragmented CSI sequences are ignored', async () => {
  let calls = 0;
  const { input, output, session } = await startHarness(commandApi({
    changeDestination: async () => {
      calls += 1;
      return { status: 'changed', instanceId: 'test-instance', resumed: true };
    },
  }));

  try {
    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));

    input.emit('data', Buffer.from('\u001b'));
    input.emit('data', Buffer.from('['));
    input.emit('data', Buffer.from('A'));
    await new Promise(resolve => setTimeout(resolve, 40));
    input.emit('data', Buffer.from('c'));
    await waitFor(() => output.text().includes('Destination URL: c'));
    assert.equal(calls, 0);

    input.emit('data', Buffer.from('\u001b'));
    await waitFor(() => output.text().endsWith('\u001b[?25l'));
    assert.equal(calls, 0);

    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));
    input.emit('data', Buffer.from('\u001b'));
    await waitFor(() => output.text().endsWith('\u001b[?25l'));
  } finally {
    await session.close();
  }
});

test('stop requires confirmation and tolerates settling after dashboard closure', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let stops = 0;
  let resolveStop!: (value: { status: 'stopped'; instanceId: string }) => void;
  const stop = new Promise<{ status: 'stopped'; instanceId: string }>(resolve => {
    resolveStop = resolve;
  });
  const session = await startDashboard({
    input: streamInput(input),
    output: streamOutput(output),
    pollIntervalMs: 60_000,
    requestStatus: async () => runningStatus(),
    commands: commandApi({
      stop: async () => {
        stops += 1;
        return stop;
      },
    }),
  });

  await waitFor(() => output.text().includes('Running'));
  input.emit('data', Buffer.from('s'));
  await waitFor(() => output.text().includes('Stop Impractical Bot?'));
  input.emit('data', Buffer.from('n'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stops, 0);

  input.emit('data', Buffer.from('s'));
  await waitFor(() => output.text().includes('Stop Impractical Bot?'));
  input.emit('data', Buffer.from('y'));
  await waitFor(() => stops === 1);
  await waitFor(() => output.text().includes('Stopping engine...'));

  await session.close();
  resolveStop({ status: 'stopped', instanceId: 'test-instance' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(input.listenerCount('data'), 0);
});

test('runtime failures are shown as concise footer errors and do not crash the dashboard', async () => {
  const { input, output, session } = await startHarness(commandApi({
    pause: async () => {
      throw new Error('The engine rejected the pause request (BUSY).');
    },
  }), { captureConsoleOutput: true });

  try {
    input.emit('data', Buffer.from('p'));
    await waitFor(() => output.text().includes('Error: Pause failed. See the logs.'));

    const beforeEscape = output.writes.length;
    input.emit('data', Buffer.from('\u001b'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.doesNotMatch(output.writesSince(beforeEscape), /Error:/);
    input.emit('data', Buffer.from('p'));
    await waitFor(() => output.text().includes('Pausing...'));
  } finally {
    await session.close();
  }
});

test('command feedback never enters LIVE LOGS and prompts survive polling, logging, and resize', async () => {
  const { input, output, session } = await startHarness(
    commandApi({
      pause: async () => ({ status: 'paused', instanceId: 'test-instance' }),
    }),
    {
      captureConsoleOutput: true,
      now: () => new Date(2024, 0, 2, 3, 4, 5),
    },
  );

  try {
    input.emit('data', Buffer.from('p'));
    await waitFor(() => output.text().includes('Engine paused.'));
    assert.doesNotMatch(output.text(), /\[\d{2}:\d{2}:\d{2}\] Engine paused\./);

    input.emit('data', Buffer.from('m'));
    await waitFor(() => output.text().includes('Destination URL:'));
    input.emit('data', Buffer.from('abc'));

    const beforePoll = output.writes.length;
    await session.refresh();
    await new Promise(resolve => setTimeout(resolve, 10));
    console.log('engine log during prompt');
    await waitFor(() => output.text().includes('engine log during prompt'));
    assert.match(output.writesSince(beforePoll), /\u001b\[\d+;\d+H/);

    output.columns = 60;
    const beforeResize = output.writes.length;
    output.emit('resize');
    await waitFor(() => output.writesSince(beforeResize).includes('Destination URL: abc'));
  } finally {
    await session.close();
  }
});

test('long prompt input scrolls horizontally and keeps the cursor on screen', async () => {
  const view: DashboardView = {
    connection: 'connected',
    state: 'running',
    browser: 'brave',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: 'https://example.com',
    prompt: {
      kind: 'destination',
      value: 'https://example.com/messages/' + '9'.repeat(200),
    },
  };
  const dimensions = { columns: 48, rows: 24 };
  const rendered = renderDashboardLines(view, dimensions).join('\n');
  assert.match(rendered, /…/);
  assert.match(rendered, /9999/);
  assert.doesNotMatch(rendered, /https:\/\/example\.com\/messages\/$/);

  const cursor = getDashboardPromptCursor(view, dimensions);
  assert.ok(cursor);
  assert.ok(cursor.row >= 1 && cursor.row <= dimensions.rows);
  assert.ok(cursor.column >= 1 && cursor.column <= dimensions.columns);
});

test('prompt and pending states hide unavailable commands but keep D in normal mode', () => {
  const view: DashboardView = {
    connection: 'connected',
    state: 'running',
    browser: 'brave',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: 'https://example.com',
  };
  const normal = renderDashboardLines(view, { columns: 80, rows: 24 }).join('\n');
  assert.match(normal, /\[D\] Enter debug/);
  assert.match(normal, /\[P\] pause/);
  assert.doesNotMatch(normal, /\[R\] resume/);

  const prompt = renderDashboardLines(
    { ...view, prompt: { kind: 'temperament' } },
    { columns: 80, rows: 24 },
  ).join('\n');
  assert.doesNotMatch(prompt, /\[D\] Enter debug/);
  assert.doesNotMatch(prompt, /\[P\] pause/);
  assert.match(prompt, /Select temperament:/);

  const pending = renderDashboardLines(
    { ...view, pending: true, notice: { tone: 'pending', message: 'Pausing...', transient: false } },
    { columns: 80, rows: 24 },
  ).join('\n');
  assert.match(pending, /\[D\] Enter debug/);
  assert.doesNotMatch(pending, /\[P\] pause/);
  assert.match(pending, /Pausing\.\.\./);
});
