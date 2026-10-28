import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import {
  createRuntimeControl,
  getRuntimeControlEndpoint,
  requestRuntimePause,
  requestRuntimeResume,
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
