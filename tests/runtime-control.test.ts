import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import {
  createRuntimeControl,
  getRuntimeControlEndpoint,
  requestRuntimeChangeDestination,
  requestRuntimePause,
  requestRuntimeResume,
  requestRuntimeSetTemperament,
  requestRuntimeSetPersonality,
  requestRuntimeStatus,
  requestRuntimeStatusSnapshot,
  requestRuntimeStop,
  waitForRuntimeShutdown,
  RuntimeAlreadyRunningError,
  RuntimeControlEndpointError,
  RuntimeControlTimeoutError,
  type RuntimeStatusDetails,
} from '../src/runtime-control.js';

function readPipeLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        resolve(buffered.slice(0, newline));
      }
    };
    const onError = (error: Error): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function sendRuntimeCommand(
  configurationPath: string,
  command: string,
): Promise<string> {
  const socket = createConnection(getRuntimeControlEndpoint(configurationPath));
  try {
    const greeting = await readPipeLine(socket);
    const instanceId = greeting.split(' ')[1];
    socket.write(`${command} ${instanceId}\n`);
    return await readPipeLine(socket);
  } finally {
    socket.destroy();
  }
}

function encodeProtocolText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function sendPersonalityCommand(
  configurationPath: string,
  modeToken: string,
  instructionToken?: string,
): Promise<string> {
  const socket = createConnection(getRuntimeControlEndpoint(configurationPath));
  try {
    const greeting = await readPipeLine(socket);
    const instanceId = greeting.split(' ')[1];
    const payload = instructionToken === undefined
      ? `PERSONALITY ${instanceId} ${modeToken}`
      : `PERSONALITY ${instanceId} ${modeToken} ${instructionToken}`;
    socket.write(`${payload}\n`);
    return await readPipeLine(socket);
  } finally {
    socket.destroy();
  }
}

function temporaryConfigurationPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-control-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'config.json');
}

test('runtime control waits for the owner completion result before reporting stop success', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let shutdownRequested = false;
  let resolveShutdownRequested!: () => void;
  const shutdownRequest = new Promise<void>(resolve => {
    resolveShutdownRequested = resolve;
  });
  const control = await createRuntimeControl(configurationPath, () => {
    shutdownRequested = true;
    resolveShutdownRequested();
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });

  const stop = requestRuntimeStop(configurationPath);
  await shutdownRequest;
  assert.equal(shutdownRequested, true);
  control.complete(0);
  const result = await stop;
  assert.equal(result.status, 'stopped');
  if (result.status === 'stopped') {
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/i);
  }
  await control.close();
});

test('runtime control rejects a duplicate owner and can be acquired after cleanup', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, () => undefined);
  context.after(async () => {
    control.complete(1);
    await control.close();
  });

  await assert.rejects(
    createRuntimeControl(configurationPath, () => undefined),
    RuntimeAlreadyRunningError,
  );
  control.complete(0);
  await control.close();

  const replacement = await createRuntimeControl(configurationPath, () => undefined);
  replacement.complete(0);
  await replacement.close();
});

test('runtime control refuses to send stop to an unrelated pipe listener', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  let receivedData = false;
  const unrelatedServer = createServer(socket => {
    socket.write('UNRELATED/1\n');
    socket.on('data', () => {
      receivedData = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    unrelatedServer.once('error', reject);
    unrelatedServer.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => unrelatedServer.close(() => resolve()));
  });

  await assert.rejects(requestRuntimeStop(configurationPath), RuntimeControlEndpointError);
  assert.equal(receivedData, false);
  await assert.rejects(
    createRuntimeControl(configurationPath, () => undefined),
    RuntimeControlEndpointError,
  );
});

test('runtime control validates the handshake before every request', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  let receivedData = false;
  const unrelatedServer = createServer(socket => {
    socket.write('IMPBOT_RUNTIME/1 not-an-instance-id\n');
    socket.on('data', () => {
      receivedData = true;
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    unrelatedServer.once('error', reject);
    unrelatedServer.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => unrelatedServer.close(() => resolve()));
  });

  const expectations: Array<[() => Promise<unknown>, string]> = [
    [
      () => requestRuntimePause(configurationPath),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no pause request was sent.',
    ],
    [
      () => requestRuntimeResume(configurationPath),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no resume request was sent.',
    ],
    [
      () => requestRuntimeChangeDestination(
        configurationPath,
        'https://www.facebook.com/messages/t/987654321',
      ),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no destination change request was sent.',
    ],
    [
      () => requestRuntimeSetTemperament(configurationPath, 'quiet'),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no temperament change request was sent.',
    ],
    [
      () => requestRuntimeSetPersonality(configurationPath, 'custom', 'deadpan'),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no personality change request was sent.',
    ],
    [
      () => requestRuntimeStatusSnapshot(configurationPath),
      'The runtime-control endpoint is not owned by an impractical-bot engine; no status request was sent.',
    ],
    [
      () => requestRuntimeStatus(configurationPath),
      'The runtime-control endpoint is not owned by an impractical-bot engine.',
    ],
  ];

  for (const [request, message] of expectations) {
    await assert.rejects(request(), (error: unknown) => {
      assert.ok(error instanceof RuntimeControlEndpointError);
      assert.equal(error.message, message);
      return true;
    });
  }
  assert.equal(receivedData, false);
});

test('runtime control reports operation-specific invalid response errors', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  const instanceId = '11111111-1111-1111-1111-111111111111';
  const server = createServer(socket => {
    socket.on('error', () => undefined);
    socket.write(`IMPBOT_RUNTIME/1 ${instanceId}\n`);
    socket.once('data', () => socket.end('BOGUS\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(
    requestRuntimePause(configurationPath),
    /The engine returned an invalid pause response\./,
  );
  await assert.rejects(
    requestRuntimeResume(configurationPath),
    /The engine returned an invalid resume response\./,
  );
  await assert.rejects(
    requestRuntimeChangeDestination(
      configurationPath,
      'https://www.facebook.com/messages/t/987654321',
    ),
    /The engine returned an invalid destination change response\./,
  );
  await assert.rejects(
    requestRuntimeSetTemperament(configurationPath, 'quiet'),
    /The engine returned an invalid temperament change response\./,
  );
  await assert.rejects(
    requestRuntimeSetPersonality(configurationPath, 'custom', 'deadpan'),
    /The engine returned an invalid personality change response\./,
  );
  await assert.rejects(
    requestRuntimeStatusSnapshot(configurationPath),
    /The engine returned an invalid status response\./,
  );
  await assert.rejects(
    requestRuntimeStop(configurationPath, { responseTimeoutMs: 5_000 }),
    /The engine returned an invalid stop response\./,
  );
});

test('runtime control preserves engine rejection reasons per operation', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  const instanceId = '11111111-1111-1111-1111-111111111111';
  const server = createServer(socket => {
    socket.on('error', () => undefined);
    socket.write(`IMPBOT_RUNTIME/1 ${instanceId}\n`);
    socket.once('data', () => socket.end(`ERROR ${instanceId} DENIED\n`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(
    requestRuntimePause(configurationPath),
    /The engine rejected the pause request \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeResume(configurationPath),
    /The engine rejected the resume request \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeChangeDestination(
      configurationPath,
      'https://www.facebook.com/messages/t/987654321',
    ),
    /The engine rejected the destination change request \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeSetTemperament(configurationPath, 'quiet'),
    /The engine rejected the temperament change request \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeSetPersonality(configurationPath, 'custom', 'deadpan'),
    /The engine rejected the personality change request \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeStatusSnapshot(configurationPath),
    /The engine could not provide its runtime status \(DENIED\)\./,
  );
  await assert.rejects(
    requestRuntimeStop(configurationPath, { responseTimeoutMs: 5_000 }),
    /The engine returned an invalid stop response\./,
  );
});

test('runtime stop, pause, and resume report not-running when no owner exists', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  assert.deepEqual(await requestRuntimeStop(configurationPath), { status: 'not-running' });
  assert.deepEqual(await requestRuntimePause(configurationPath), { status: 'not-running' });
  assert.deepEqual(await requestRuntimeResume(configurationPath), { status: 'not-running' });
  assert.deepEqual(await requestRuntimeStatus(configurationPath), { status: 'not-running' });
  assert.deepEqual(
    await requestRuntimeStatusSnapshot(configurationPath),
    { status: 'not-running' },
  );
  assert.deepEqual(
    await requestRuntimeChangeDestination(
      configurationPath,
      'https://www.facebook.com/messages/t/987654321',
    ),
    { status: 'not-running' },
  );
  assert.deepEqual(
    await requestRuntimeSetTemperament(configurationPath, 'quiet'),
    { status: 'not-running' },
  );
  assert.deepEqual(
    await requestRuntimeSetPersonality(configurationPath, 'custom', 'deadpan'),
    { status: 'not-running' },
  );
});

test('runtime control pauses and resumes the engine and treats repeated commands as safe', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let pauseRequests = 0;
  let resumeRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestResume: () => {
      resumeRequests += 1;
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);

  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /^RESUMED /);
  assert.equal(resumeRequests, 1);
  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /^RESUMED /);
  assert.equal(resumeRequests, 1);
});

test('runtime control reports pause and resume handler failures without changing state', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const pauseControl = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: async () => {
      throw new Error('pause failed');
    },
  });
  pauseControl.setState('running');
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /PAUSE_FAILED$/);
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /PAUSE_FAILED$/);
  pauseControl.complete(0);
  await pauseControl.close();

  const resumeControl = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => undefined,
    requestResume: async () => {
      throw new Error('resume failed');
    },
  });
  context.after(async () => {
    resumeControl.complete(1);
    await resumeControl.close();
  });
  resumeControl.setState('running');
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /RESUME_FAILED$/);
  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /RESUME_FAILED$/);
});

test('runtime control changes a destination and resumes the engine when it was running', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const destination = 'https://www.facebook.com/messages/t/987654321';
  let receivedDestination = '';
  let receivedResume: boolean | undefined;
  let pauseRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestResume: () => undefined,
    requestChangeDestination: (selectedDestination, options) => {
      receivedDestination = selectedDestination;
      receivedResume = options.resume;
      return { status: 'changed', resumed: options.resume };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeChangeDestination(configurationPath, destination);
  assert.equal(result.status, 'changed');
  if (result.status === 'changed') {
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/i);
    assert.equal(result.resumed, true);
  }
  assert.equal(receivedDestination, destination);
  assert.equal(receivedResume, true);

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
});

test('runtime control keeps a rejected destination change paused and reports the reason', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let pauseRequests = 0;
  let resumeRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestResume: () => {
      resumeRequests += 1;
    },
    requestChangeDestination: () => ({
      status: 'rejected',
      reason: 'The destination conversation could not be verified.',
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeChangeDestination(
    configurationPath,
    'https://www.facebook.com/messages/t/987654321',
  );
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.reason, 'The destination conversation could not be verified.');
    assert.equal(result.resumed, false);
  }

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 0);
  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /^RESUMED /);
  assert.equal(resumeRequests, 1);
});

test('runtime control reports a resumed engine after a rolled-back destination failure', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let pauseRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestChangeDestination: () => ({
      status: 'failed',
      reason: 'The requested destination was opened but its configuration could not be initialized.',
      resumed: true,
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeChangeDestination(
    configurationPath,
    'https://www.facebook.com/messages/t/987654321',
  );
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(
      result.reason,
      'The requested destination was opened but its configuration could not be initialized.',
    );
    assert.equal(result.resumed, true);
  }

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
});

test('runtime control rejects overlapping destination, pause, and resume changes', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let releaseChange!: () => void;
  let changeEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    changeEntered = resolve;
  });
  const release = new Promise<void>(resolve => {
    releaseChange = resolve;
  });
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => undefined,
    requestResume: () => undefined,
    requestChangeDestination: async () => {
      changeEntered();
      await release;
      return { status: 'changed', resumed: true };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const first = requestRuntimeChangeDestination(
    configurationPath,
    'https://www.facebook.com/messages/t/987654321',
  );
  await entered;

  await assert.rejects(
    requestRuntimeChangeDestination(
      configurationPath,
      'https://www.facebook.com/messages/t/111111111',
    ),
    /BUSY/,
  );
  await assert.rejects(requestRuntimePause(configurationPath), /BUSY/);
  await assert.rejects(requestRuntimeResume(configurationPath), /BUSY/);

  releaseChange();
  assert.equal((await first).status, 'changed');
});

test('runtime control aborts an in-progress destination change when stopped', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let releaseChange!: () => void;
  let changeEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    changeEntered = resolve;
  });
  const release = new Promise<void>(resolve => {
    releaseChange = resolve;
  });
  let shutdownRequested = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => {
    resolveShutdown = resolve;
  });
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => {
      shutdownRequested = true;
      resolveShutdown();
    },
    requestChangeDestination: async () => {
      changeEntered();
      await release;
      return { status: 'changed', resumed: true };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const change = requestRuntimeChangeDestination(
    configurationPath,
    'https://www.facebook.com/messages/t/987654321',
  );
  await entered;
  const stop = requestRuntimeStop(configurationPath);
  await shutdown;
  assert.equal(shutdownRequested, true);
  control.complete(0);
  releaseChange();

  await assert.rejects(change, /ABORTED/);
  assert.equal((await stop).status, 'stopped');
});

test('runtime control reports an aborted pause when the engine stops first', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let releasePause!: () => void;
  let pauseEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    pauseEntered = resolve;
  });
  const release = new Promise<void>(resolve => {
    releasePause = resolve;
  });
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => {
    resolveShutdown = resolve;
  });
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => resolveShutdown(),
    requestPause: async () => {
      pauseEntered();
      await release;
    },
  });
  control.setState('running');

  try {
    const pause = requestRuntimePause(configurationPath);
    await entered;
    const stop = requestRuntimeStop(configurationPath);
    await shutdown;
    control.complete(0);
    releasePause();

    await assert.rejects(pause, /ABORTED/);
    assert.equal((await stop).status, 'stopped');
  } finally {
    control.complete(1);
    await control.close();
  }
});

test('runtime control reports an aborted resume when the engine stops first', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let releaseResume!: () => void;
  let resumeEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    resumeEntered = resolve;
  });
  const release = new Promise<void>(resolve => {
    releaseResume = resolve;
  });
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => {
    resolveShutdown = resolve;
  });
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => resolveShutdown(),
    requestPause: () => undefined,
    requestResume: async () => {
      resumeEntered();
      await release;
    },
  });
  control.setState('running');

  try {
    assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
    const resume = requestRuntimeResume(configurationPath);
    await entered;
    const stop = requestRuntimeStop(configurationPath);
    await shutdown;
    control.complete(0);
    releaseResume();

    await assert.rejects(resume, /ABORTED/);
    assert.equal((await stop).status, 'stopped');
  } finally {
    control.complete(1);
    await control.close();
  }
});

test('runtime control rejects unsupported and unknown commands without requesting shutdown', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let shutdownRequests = 0;
  const control = await createRuntimeControl(configurationPath, () => {
    shutdownRequests += 1;
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /UNSUPPORTED$/);
  assert.match(await sendRuntimeCommand(configurationPath, 'BOGUS'), /INVALID_REQUEST$/);
  assert.equal(shutdownRequests, 0);
});

test('runtime control changes temperament without pausing, resuming, or restarting the engine', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const received: string[] = [];
  let pauseRequests = 0;
  let resumeRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestResume: () => {
      resumeRequests += 1;
    },
    requestSetTemperament: temperament => {
      received.push(temperament);
      return { status: 'changed' };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeSetTemperament(configurationPath, 'quiet');
  assert.equal(result.status, 'changed');
  if (result.status === 'changed') {
    assert.equal(result.temperament, 'quiet');
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/i);
  }
  assert.deepEqual(received, ['quiet']);
  assert.equal(pauseRequests, 0);
  assert.equal(resumeRequests, 0);
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);

  assert.equal((await requestRuntimeSetTemperament(configurationPath, 'talkative')).status, 'changed');
  assert.deepEqual(received, ['quiet', 'talkative']);
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
});

test('runtime control reports temperament failure without changing engine state', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let pauseRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestSetTemperament: () => ({
      status: 'failed',
      reason: 'The temperament could not be saved.',
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeSetTemperament(configurationPath, 'balanced');
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.reason, 'The temperament could not be saved.');
  }
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
});

test('runtime control changes personality without pausing, resuming, or restarting the engine', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const received: Array<{ mode: string; instruction: string }> = [];
  let pauseRequests = 0;
  let resumeRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestResume: () => {
      resumeRequests += 1;
    },
    requestSetPersonality: (mode, instruction) => {
      received.push({ mode, instruction });
      return { status: 'changed' };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const instruction = 'Sarcastic and deadpan.\nNever cheerful.\n\nMatch the room.';
  const result = await requestRuntimeSetPersonality(configurationPath, 'custom', instruction);
  assert.equal(result.status, 'changed');
  if (result.status === 'changed') {
    assert.equal(result.mode, 'custom');
    assert.equal(result.instruction, instruction);
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/i);
  }
  assert.deepEqual(received, [{ mode: 'custom', instruction }]);
  assert.equal(pauseRequests, 0);
  assert.equal(resumeRequests, 0);
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);

  assert.equal(
    (await requestRuntimeSetPersonality(configurationPath, 'default', '')).status,
    'changed',
  );
  assert.deepEqual(received[1], { mode: 'default', instruction: '' });
  assert.equal(resumeRequests, 0);
});

test('runtime control reports personality failure without changing engine state', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let pauseRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => {
      pauseRequests += 1;
    },
    requestSetPersonality: () => ({
      status: 'failed',
      reason: 'The personality could not be saved.',
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const result = await requestRuntimeSetPersonality(configurationPath, 'custom', 'deadpan');
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.reason, 'The personality could not be saved.');
  }
  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 1);
});

test('runtime control validates personality requests before invoking the handler', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  let calls = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestSetPersonality: () => {
      calls += 1;
      return { status: 'changed' };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.match(
    await sendPersonalityCommand(configurationPath, encodeProtocolText('loud'), encodeProtocolText('x')),
    /INVALID_REQUEST$/,
  );
  assert.match(
    await sendPersonalityCommand(configurationPath, encodeProtocolText('custom'), encodeProtocolText('')),
    /INVALID_REQUEST$/,
  );
  assert.match(
    await sendPersonalityCommand(configurationPath, encodeProtocolText('custom')),
    /INVALID_REQUEST$/,
  );
  assert.equal(calls, 0);
});

test('runtime control reports personality as unsupported when no handler is registered', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.match(
    await sendPersonalityCommand(configurationPath, encodeProtocolText('default'), encodeProtocolText('')),
    /UNSUPPORTED$/,
  );
});

test('runtime status snapshot reports startup and running states with only public fields', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const destination = 'https://www.facebook.com/messages/t/987654321';
  let statusRequests = 0;
  const statusDetails: RuntimeStatusDetails & {
    queueDepth: number;
    profilePath: string;
    messageText: string;
  } = {
    browser: 'edge',
    temperament: 'quiet',
    personality: 'custom',
    messengerDestination: destination,
    queueDepth: 12,
    profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\profile',
    messageText: 'internal message text',
  };
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestStatus: () => {
      statusRequests += 1;
      return statusDetails;
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });

  const starting = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(starting.status, 'running');
  if (starting.status === 'running') {
    assert.match(starting.instanceId, /^[0-9a-f-]{36}$/i);
    assert.equal(starting.state, 'starting');
    assert.equal(starting.browser, 'edge');
    assert.equal(starting.temperament, 'quiet');
    assert.equal(starting.personality, 'custom');
    assert.equal(starting.messengerDestination, destination);
    assert.deepEqual(
      Object.keys(starting).sort(),
      [
        'browser',
        'instanceId',
        'messengerDestination',
        'personality',
        'state',
        'status',
        'temperament',
      ],
    );
  }

  control.setState('running');
  const running = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(running.status, 'running');
  if (running.status === 'running') {
    assert.equal(running.state, 'running');
    assert.equal(running.instanceId, starting.status === 'running' ? starting.instanceId : '');
  }
  assert.equal(statusRequests, 2);

  const rawResponse = await sendRuntimeCommand(configurationPath, 'STATUS');
  assert.match(rawResponse, /^STATUS /);
  assert.doesNotMatch(rawResponse, /queueDepth/);
  assert.doesNotMatch(rawResponse, /profilePath/);
  assert.doesNotMatch(rawResponse, /internal message text/);
  assert.doesNotMatch(rawResponse, /C:\\/);
});

test('runtime status snapshot reflects pause and resume transitions', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestPause: () => undefined,
    requestResume: () => undefined,
    requestStatus: () => ({
      browser: 'brave',
      temperament: 'balanced',
      personality: 'default',
      messengerDestination: 'https://www.facebook.com/messages/t/987654321',
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const running = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(running.status === 'running' && running.state, 'running');

  assert.equal((await requestRuntimePause(configurationPath)).status, 'paused');
  const paused = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(paused.status === 'running' && paused.state, 'paused');

  assert.equal((await requestRuntimeResume(configurationPath)).status, 'resumed');
  const resumed = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(resumed.status === 'running' && resumed.state, 'running');
});

test('runtime status snapshot reflects successful destination, temperament, and personality changes', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const initialDestination = 'https://www.facebook.com/messages/t/111111111';
  const changedDestination = 'https://www.facebook.com/messages/t/987654321';
  const details: RuntimeStatusDetails = {
    browser: 'chrome',
    temperament: 'balanced',
    personality: 'default',
    messengerDestination: initialDestination,
  };
  let shutdownRequests = 0;
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => {
      shutdownRequests += 1;
    },
    requestStatus: () => ({ ...details }),
    requestChangeDestination: (destination, options) => {
      details.messengerDestination = destination;
      return { status: 'changed', resumed: options.resume };
    },
    requestSetTemperament: temperament => {
      details.temperament = temperament;
      return { status: 'changed' };
    },
    requestSetPersonality: mode => {
      details.personality = mode;
      return { status: 'changed' };
    },
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.equal((await requestRuntimeSetTemperament(configurationPath, 'talkative')).status, 'changed');
  assert.equal(
    (await requestRuntimeSetPersonality(configurationPath, 'custom', 'Deadpan.')).status,
    'changed',
  );
  assert.equal(
    (await requestRuntimeChangeDestination(configurationPath, changedDestination)).status,
    'changed',
  );

  const status = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(status.status, 'running');
  if (status.status === 'running') {
    assert.equal(status.state, 'running');
    assert.equal(status.browser, 'chrome');
    assert.equal(status.temperament, 'talkative');
    assert.equal(status.personality, 'custom');
    assert.equal(status.messengerDestination, changedDestination);
  }
  assert.equal(shutdownRequests, 0);
});

test('runtime status snapshot reports unsupported when no status provider is registered', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  assert.match(await sendRuntimeCommand(configurationPath, 'STATUS'), /ERROR .* UNSUPPORTED$/);
  const result = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(result.status, 'unsupported');
  if (result.status === 'unsupported') {
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/i);
  }
});

test('runtime status snapshot treats an older engine rejection as unsupported', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  const instanceId = '11111111-1111-1111-1111-111111111111';
  const server = createServer(socket => {
    socket.on('error', () => undefined);
    socket.write(`IMPBOT_RUNTIME/1 ${instanceId}\n`);
    socket.once('data', () => socket.end(`ERROR ${instanceId} INVALID_REQUEST\n`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  context.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  assert.deepEqual(
    await requestRuntimeStatusSnapshot(configurationPath),
    { status: 'unsupported', instanceId },
  );
});

test('existing runtime status request remains compatible with the status snapshot', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, {
    requestShutdown: () => undefined,
    requestStatus: () => ({
      browser: 'brave',
      temperament: 'balanced',
      personality: 'default',
      messengerDestination: 'https://www.facebook.com/messages/t/987654321',
    }),
  });
  context.after(async () => {
    control.complete(1);
    await control.close();
  });
  control.setState('running');

  const legacy = await requestRuntimeStatus(configurationPath);
  const snapshot = await requestRuntimeStatusSnapshot(configurationPath);
  assert.equal(legacy.status, 'running');
  assert.equal(snapshot.status, 'running');
  if (legacy.status === 'running' && snapshot.status === 'running') {
    assert.equal(snapshot.instanceId, legacy.instanceId);
  }
});

test('runtime shutdown confirmation waits until the endpoint is no longer owned', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, () => undefined);
  context.after(async () => {
    control.complete(1);
    await control.close();
  });

  const whileOwned = await waitForRuntimeShutdown(configurationPath, {
    timeoutMs: 300,
    pollIntervalMs: 20,
  });
  assert.equal(whileOwned.status, 'unconfirmed');
  if (whileOwned.status === 'unconfirmed') {
    assert.match(whileOwned.reason, /still owned/);
  }

  control.complete(0);
  await control.close();
  const afterRelease = await waitForRuntimeShutdown(configurationPath, {
    timeoutMs: 1_000,
    pollIntervalMs: 20,
  });
  assert.equal(afterRelease.status, 'stopped');
});

test('runtime stop accepts a response that arrives before its deadline', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const control = await createRuntimeControl(configurationPath, () => undefined);
  context.after(async () => {
    control.complete(1);
    await control.close();
  });

  const stop = requestRuntimeStop(configurationPath, { responseTimeoutMs: 5_000 });
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  control.complete(0);
  const result = await stop;
  assert.equal(result.status, 'stopped');
});

test('runtime stop times out with a bounded wait and cleans up a nonresponsive endpoint', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  const endpoint = getRuntimeControlEndpoint(configurationPath);
  let serverSocket: Socket | undefined;
  const server = createServer(socket => {
    serverSocket = socket;
    socket.on('error', () => undefined);
    socket.write('IMPBOT_RUNTIME/1 11111111-1111-1111-1111-111111111111\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  context.after(async () => {
    serverSocket?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const startedAt = Date.now();
  await assert.rejects(
    requestRuntimeStop(configurationPath, { responseTimeoutMs: 150 }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeControlTimeoutError);
      assert.match(error.message, /may have stopped/);
      assert.match(error.message, /not confirmed/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000);

  // A write on the server side fails with EPIPE only if the client destroyed its
  // socket, so this proves the timed-out handle was cleaned up rather than left open.
  assert.ok(serverSocket);
  const serverSideClosed = new Promise<void>((resolve, reject) => {
    serverSocket!.write('PROBE\n', error => {
      if (error) {
        resolve();
      } else {
        reject(new Error('the timed-out stop socket remained open'));
      }
    });
  });
  await Promise.race([
    serverSideClosed,
    new Promise<void>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the timed-out stop socket was not cleaned up')),
        2_000,
      );
      timer.unref();
    }),
  ]);
});
