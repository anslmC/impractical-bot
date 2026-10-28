import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { win32 } from 'node:path';
import { resolveConfigurationPaths } from './config/configuration.js';

const PROTOCOL = 'IMPBOT_RUNTIME/1';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_LINE_LENGTH = 256;

export class RuntimeAlreadyRunningError extends Error {
  constructor() {
    super('An impractical-bot engine is already running for this configuration.');
    this.name = 'RuntimeAlreadyRunningError';
  }
}

export class RuntimeControlEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeControlEndpointError';
  }
}

export type RuntimeStopResult =
  | { status: 'stopped'; instanceId: string }
  | { status: 'not-running' };

export type RuntimePauseResult =
  | { status: 'paused'; instanceId: string }
  | { status: 'not-running' };

export type RuntimeResumeResult =
  | { status: 'resumed'; instanceId: string }
  | { status: 'not-running' };

type RuntimeState = 'starting' | 'running' | 'paused' | 'stopping';

export interface RuntimeControlHandlers {
  requestShutdown: () => void;
  requestPause?: () => void | Promise<void>;
  requestResume?: () => void | Promise<void>;
}

export interface RuntimeControl {
  setState(state: 'running' | 'stopping'): void;
  complete(exitCode: number): void;
  close(): Promise<void>;
}

function getConfigurationFilePath(configurationFilePath?: string): string {
  return configurationFilePath ?? resolveConfigurationPaths().filePath;
}

export function getRuntimeControlEndpoint(configurationFilePath?: string): string {
  const canonicalPath = win32.normalize(getConfigurationFilePath(configurationFilePath)).toLowerCase();
  const identity = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 40);
  return `\\\\.\\pipe\\impractical-bot-${identity}`;
}

function isPipeMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['ENOENT', 'ECONNREFUSED'].includes(String(error.code));
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function readLine(socket: Socket, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error?: Error, line?: string): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      if (error) {
        reject(error);
      } else {
        resolve(line ?? '');
      }
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_LENGTH) {
        finish(new RuntimeControlEndpointError('Runtime-control response exceeded the protocol limit.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        finish(undefined, buffer.slice(0, newline).replace(/\r$/, ''));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new RuntimeControlEndpointError('Runtime-control connection closed unexpectedly.'));
    const onTimeout = (): void => finish(new RuntimeControlEndpointError('Timed out waiting for the runtime-control response.'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

async function hasRuntimeProtocol(endpoint: string): Promise<boolean> {
  let socket: Socket;
  try {
    socket = createConnection(endpoint);
  } catch {
    return false;
  }

  try {
    const greeting = await readLine(socket);
    return new RegExp(`^${PROTOCOL} [0-9a-f-]{36}$`, 'i').test(greeting);
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

export async function createRuntimeControl(
  configurationFilePath: string | undefined,
  handlers: RuntimeControlHandlers | (() => void),
): Promise<RuntimeControl> {
  if (process.platform !== 'win32') {
    throw new RuntimeControlEndpointError('Runtime control is only supported on Windows.');
  }

  const runtimeHandlers: RuntimeControlHandlers = typeof handlers === 'function'
    ? { requestShutdown: handlers }
    : handlers;
  const endpoint = getRuntimeControlEndpoint(configurationFilePath);
  const instanceId = randomUUID();
  const sockets = new Set<Socket>();
  const stoppingSockets = new Set<Socket>();
  let resolveCompletion!: (exitCode: number) => void;
  const completion = new Promise<number>(resolve => {
    resolveCompletion = resolve;
  });
  let shutdownRequested = false;
  let state: RuntimeState = 'starting';
  const isStopping = (): boolean => state === 'stopping';

  const commandResult = async (command: string): Promise<string> => {
    if (command === `STOP ${instanceId}`) {
      if (!shutdownRequested) {
        shutdownRequested = true;
        state = 'stopping';
        runtimeHandlers.requestShutdown();
      }
      const exitCode = await completion;
      return `${exitCode === 0 || exitCode === 130 ? 'STOPPED' : 'FAILED'} ${instanceId} ${exitCode}\n`;
    }

    if (command === `PAUSE ${instanceId}`) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (!runtimeHandlers.requestPause) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      if (state === 'paused') {
        return `PAUSED ${instanceId}\n`;
      }
      if (state !== 'running') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      try {
        await runtimeHandlers.requestPause();
        if (!isStopping()) {
          state = 'paused';
        }
        return `PAUSED ${instanceId}\n`;
      } catch {
        return `ERROR ${instanceId} PAUSE_FAILED\n`;
      }
    }

    if (command === `RESUME ${instanceId}`) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (!runtimeHandlers.requestResume) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      if (state === 'running') {
        return `RESUMED ${instanceId}\n`;
      }
      if (state !== 'paused') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      try {
        await runtimeHandlers.requestResume();
        if (!isStopping()) {
          state = 'running';
        }
        return `RESUMED ${instanceId}\n`;
      } catch {
        return `ERROR ${instanceId} RESUME_FAILED\n`;
      }
    }

    return `ERROR ${instanceId} INVALID_REQUEST\n`;
  };

  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      stoppingSockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
      stoppingSockets.delete(socket);
    });
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
    socket.write(`${PROTOCOL} ${instanceId}\n`);

    let buffer = '';
    let requestHandled = false;
    socket.on('data', (chunk: Buffer) => {
      if (requestHandled) {
        return;
      }
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_LENGTH) {
        socket.end('ERROR invalid request\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      requestHandled = true;
      const command = buffer.slice(0, newline).replace(/\r$/, '');
      socket.setTimeout(0);
      if (command === `STOP ${instanceId}`) {
        stoppingSockets.add(socket);
      }
      void commandResult(command).then(
        response => socket.end(response),
        () => socket.end(`ERROR ${instanceId} TRANSITION_FAILED\n`),
      );
    });
  });

  try {
    await listen(server, endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (await hasRuntimeProtocol(endpoint)) {
        throw new RuntimeAlreadyRunningError();
      }
      throw new RuntimeControlEndpointError(
        'The runtime-control endpoint is occupied by a process that is not an impractical-bot engine.',
      );
    }
    throw new RuntimeControlEndpointError(
      `Unable to own the runtime-control endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let closePromise: Promise<void> | undefined;
  return {
    setState(nextState) {
      if (nextState === 'stopping') {
        state = 'stopping';
      } else if (state === 'starting') {
        state = 'running';
      }
    },
    complete(exitCode) {
      resolveCompletion(exitCode);
    },
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          if (!stoppingSockets.has(socket) && !socket.writableEnded) {
            socket.destroy();
          }
        }
        server.close(error => error ? reject(error) : resolve());
      });
      return closePromise;
    },
  };
}

type RuntimeTransitionCommand = 'PAUSE' | 'RESUME';

async function requestRuntimeTransition(
  configurationFilePath: string | undefined,
  command: RuntimeTransitionCommand,
): Promise<{ status: 'paused' | 'resumed'; instanceId: string } | { status: 'not-running' }> {
  if (process.platform !== 'win32') {
    throw new RuntimeControlEndpointError('Runtime control is only supported on Windows.');
  }

  const endpoint = getRuntimeControlEndpoint(configurationFilePath);
  const socket = createConnection(endpoint);
  try {
    let instanceId: string;
    try {
      const greeting = await readLine(socket);
      const match = greeting.match(new RegExp(`^${PROTOCOL} ([0-9a-f-]{36})$`, 'i'));
      if (!match) {
        throw new RuntimeControlEndpointError(
          `The runtime-control endpoint is not owned by an impractical-bot engine; no ${command.toLowerCase()} request was sent.`,
        );
      }
      instanceId = match[1];
    } catch (error) {
      if (isPipeMissing(error)) {
        return { status: 'not-running' };
      }
      throw error;
    }

    socket.setTimeout(0);
    socket.write(`${command} ${instanceId}\n`);
    const response = await readLine(socket, 0);
    const expected = command === 'PAUSE' ? `PAUSED ${instanceId}` : `RESUMED ${instanceId}`;
    if (response === expected) {
      return {
        status: command === 'PAUSE' ? 'paused' : 'resumed',
        instanceId,
      };
    }
    if (response.startsWith(`ERROR ${instanceId} `)) {
      const reason = response.slice(`ERROR ${instanceId} `.length);
      throw new RuntimeControlEndpointError(
        `The engine rejected the ${command.toLowerCase()} request (${reason}).`,
      );
    }
    throw new RuntimeControlEndpointError(
      `The engine returned an invalid ${command.toLowerCase()} response.`,
    );
  } catch (error) {
    if (isPipeMissing(error)) {
      return { status: 'not-running' };
    }
    throw error;
  } finally {
    socket.destroy();
  }
}

export async function requestRuntimePause(
  configurationFilePath?: string,
): Promise<RuntimePauseResult> {
  const result = await requestRuntimeTransition(configurationFilePath, 'PAUSE');
  return result.status === 'not-running'
    ? result
    : { status: 'paused', instanceId: result.instanceId };
}

export async function requestRuntimeResume(
  configurationFilePath?: string,
): Promise<RuntimeResumeResult> {
  const result = await requestRuntimeTransition(configurationFilePath, 'RESUME');
  return result.status === 'not-running'
    ? result
    : { status: 'resumed', instanceId: result.instanceId };
}

export async function requestRuntimeStop(
  configurationFilePath?: string,
): Promise<RuntimeStopResult> {
  if (process.platform !== 'win32') {
    throw new RuntimeControlEndpointError('Runtime control is only supported on Windows.');
  }

  const endpoint = getRuntimeControlEndpoint(configurationFilePath);
  const socket = createConnection(endpoint);
  try {
    let instanceId: string;
    try {
      const greeting = await readLine(socket);
      const match = greeting.match(new RegExp(`^${PROTOCOL} ([0-9a-f-]{36})$`, 'i'));
      if (!match) {
        throw new RuntimeControlEndpointError(
          'The runtime-control endpoint is not owned by an impractical-bot engine; no stop request was sent.',
        );
      }
      instanceId = match[1];
    } catch (error) {
      if (isPipeMissing(error)) {
        return { status: 'not-running' };
      }
      throw error;
    }

    socket.setTimeout(0);
    socket.write(`STOP ${instanceId}\n`);
    const response = await readLine(socket, 0);
    if (response === `STOPPED ${instanceId} 0` || response === `STOPPED ${instanceId} 130`) {
      return { status: 'stopped', instanceId };
    }
    if (response.startsWith(`FAILED ${instanceId} `)) {
      throw new RuntimeControlEndpointError(
        `The engine received the stop request but shutdown failed (exit code ${response.slice(`FAILED ${instanceId} `.length)}).`,
      );
    }
    throw new RuntimeControlEndpointError('The engine returned an invalid stop response.');
  } catch (error) {
    if (isPipeMissing(error)) {
      return { status: 'not-running' };
    }
    throw error;
  } finally {
    socket.destroy();
  }
}
