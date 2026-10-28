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
  requestRuntimeStop,
  RuntimeAlreadyRunningError,
  RuntimeControlEndpointError,
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

test('runtime stop, pause, and resume report not-running when no owner exists', async context => {
  const configurationPath = temporaryConfigurationPath(context);
  assert.deepEqual(await requestRuntimeStop(configurationPath), { status: 'not-running' });
  assert.deepEqual(await requestRuntimePause(configurationPath), { status: 'not-running' });
  assert.deepEqual(await requestRuntimeResume(configurationPath), { status: 'not-running' });
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
  }

  assert.match(await sendRuntimeCommand(configurationPath, 'PAUSE'), /^PAUSED /);
  assert.equal(pauseRequests, 0);
  assert.match(await sendRuntimeCommand(configurationPath, 'RESUME'), /^RESUMED /);
  assert.equal(resumeRequests, 1);
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
