import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { win32 } from 'node:path';
import { resolveConfigurationPaths, isBotTemperament, isBotPersonalityMode, BROWSER_IDS, type BotTemperament, type BotPersonalityMode, type BrowserId } from './config/configuration.js';

const PROTOCOL = 'IMPBOT_RUNTIME/1';
const RUNTIME_NOT_OWNED_PREFIX = 'The runtime-control endpoint is not owned by an impractical-bot engine';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_LINE_LENGTH = 65_536;
const SHUTDOWN_CONFIRMATION_TIMEOUT_MS = 30_000;
const SHUTDOWN_CONFIRMATION_POLL_INTERVAL_MS = 100;
const STOP_RESPONSE_TIMEOUT_MS = 30_000;

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

export class RuntimeControlTimeoutError extends RuntimeControlEndpointError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeControlTimeoutError';
  }
}

type RuntimeNotRunning = { status: 'not-running' };

type RuntimeChangeSuccess = { status: 'changed' };
type RuntimeChangeFailure = { status: 'failed'; reason: string };

export type RuntimeStopResult =
  | { status: 'stopped'; instanceId: string }
  | RuntimeNotRunning;

export type RuntimePauseResult =
  | { status: 'paused'; instanceId: string }
  | RuntimeNotRunning;

export type RuntimeResumeResult =
  | { status: 'resumed'; instanceId: string }
  | RuntimeNotRunning;

type RuntimeDestinationChangeOutcome =
  | { status: 'changed'; resumed: boolean }
  | { status: 'rejected'; reason: string; resumed?: boolean }
  | { status: 'failed'; reason: string; resumed?: boolean };

export type RuntimeDestinationChangeResult = RuntimeDestinationChangeOutcome;

export type RuntimeChangeDestinationResult =
  | (RuntimeDestinationChangeOutcome & { instanceId: string })
  | RuntimeNotRunning;

export type RuntimeTemperamentChangeResult =
  | RuntimeChangeSuccess
  | RuntimeChangeFailure;

export type RuntimeSetTemperamentResult =
  | { status: 'changed'; instanceId: string; temperament: BotTemperament }
  | (RuntimeChangeFailure & { instanceId: string })
  | RuntimeNotRunning;

export type RuntimePersonalityChangeResult =
  | RuntimeChangeSuccess
  | RuntimeChangeFailure;

export type RuntimeSetPersonalityResult =
  | { status: 'changed'; instanceId: string; mode: BotPersonalityMode; instruction: string }
  | (RuntimeChangeFailure & { instanceId: string })
  | RuntimeNotRunning;

export type RuntimeEngineState = 'starting' | 'running' | 'paused' | 'changing' | 'stopping';

export interface RuntimeStatusSnapshot {
  state: RuntimeEngineState;
  browser: BrowserId;
  temperament: BotTemperament;
  personality: BotPersonalityMode;
  messengerDestination: string;
}

export interface RuntimeStatusDetails {
  browser: BrowserId;
  temperament: BotTemperament;
  personality: BotPersonalityMode;
  messengerDestination: string;
  state?: RuntimeEngineState;
}

export interface RuntimeDestinationChangeOptions {
  resume: boolean;
}

export interface RuntimeControlHandlers {
  requestShutdown: () => void;
  requestPause?: () => void | Promise<void>;
  requestResume?: () => void | Promise<void>;
  requestStatus?: () => RuntimeStatusDetails | Promise<RuntimeStatusDetails>;
  requestChangeDestination?: (
    destination: string,
    options: RuntimeDestinationChangeOptions,
  ) => RuntimeDestinationChangeResult | Promise<RuntimeDestinationChangeResult>;
  requestSetTemperament?: (
    temperament: BotTemperament,
  ) => RuntimeTemperamentChangeResult | Promise<RuntimeTemperamentChangeResult>;
  requestSetPersonality?: (
    mode: BotPersonalityMode,
    instruction: string,
  ) => RuntimePersonalityChangeResult | Promise<RuntimePersonalityChangeResult>;
}

function encodeProtocolText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeProtocolText(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function parseDestinationFailureResponse(value: string): {
  resumed: boolean;
  reason: string;
} {
  const stateMatch = value.match(/^(RUNNING|PAUSED) (.*)$/s);
  if (!stateMatch) {
    return { resumed: false, reason: decodeProtocolText(value) };
  }
  return {
    resumed: stateMatch[1] === 'RUNNING',
    reason: decodeProtocolText(stateMatch[2]),
  };
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

function assertWindowsRuntimeSupport(): void {
  if (process.platform !== 'win32') {
    throw new RuntimeControlEndpointError('Runtime control is only supported on Windows.');
  }
}

function parseRuntimeHandshake(greeting: string): string | undefined {
  return greeting.match(new RegExp(`^${PROTOCOL} ([0-9a-f-]{36})$`, 'i'))?.[1];
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
    const onTimeout = (): void => finish(new RuntimeControlTimeoutError('Timed out waiting for the runtime-control response.'));

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
    return parseRuntimeHandshake(await readLine(socket)) !== undefined;
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
  assertWindowsRuntimeSupport();

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
  let state: RuntimeEngineState = 'starting';
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

    if (command === `STATUS ${instanceId}`) {
      if (!runtimeHandlers.requestStatus) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      try {
        const status = await runtimeHandlers.requestStatus();
        return `STATUS ${instanceId} ${state} ${status.browser} ${status.temperament} ` +
          `${status.personality} ${encodeProtocolText(status.messengerDestination)}\n`;
      } catch {
        return `ERROR ${instanceId} STATUS_FAILED\n`;
      }
    }

    const destinationPrefix = `DESTINATION ${instanceId} `;
    if (command.startsWith(destinationPrefix)) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (!runtimeHandlers.requestChangeDestination) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      if (state === 'changing') {
        return `ERROR ${instanceId} BUSY\n`;
      }
      if (state !== 'running' && state !== 'paused') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }

      const destination = decodeProtocolText(command.slice(destinationPrefix.length));
      const resume = state === 'running';
      state = 'changing';
      try {
        const result = await runtimeHandlers.requestChangeDestination(destination, { resume });
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        if (result.status === 'changed') {
          state = result.resumed ? 'running' : 'paused';
          return `CHANGED ${instanceId} ${result.resumed ? 'RUNNING' : 'PAUSED'}\n`;
        }
        state = result.resumed ? 'running' : 'paused';
        return `${result.status === 'rejected' ? 'REJECTED' : 'FAILED'} ${instanceId} ` +
          `${result.resumed ? 'RUNNING' : 'PAUSED'} ${encodeProtocolText(result.reason)}\n`;
      } catch (error) {
        if (!isStopping()) {
          state = 'paused';
        }
        return `FAILED ${instanceId} PAUSED ${encodeProtocolText(
          error instanceof Error ? error.message : String(error),
        )}\n`;
      }
    }

    const temperamentPrefix = `TEMPERAMENT ${instanceId} `;
    if (command.startsWith(temperamentPrefix)) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (state === 'changing') {
        return `ERROR ${instanceId} BUSY\n`;
      }
      if (!runtimeHandlers.requestSetTemperament) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      if (state !== 'running' && state !== 'paused') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }

      const temperament = decodeProtocolText(command.slice(temperamentPrefix.length));
      if (!isBotTemperament(temperament)) {
        return `ERROR ${instanceId} INVALID_REQUEST\n`;
      }
      const previousState = state;
      state = 'changing';
      try {
        const result = await runtimeHandlers.requestSetTemperament(temperament);
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = previousState;
        if (result.status === 'changed') {
          return `CHANGED ${instanceId}\n`;
        }
        return `FAILED ${instanceId} ${encodeProtocolText(result.reason)}\n`;
      } catch (error) {
        if (!isStopping()) {
          state = previousState;
        }
        return `FAILED ${instanceId} ${encodeProtocolText(
          error instanceof Error ? error.message : String(error),
        )}\n`;
      }
    }

    const personalityPrefix = `PERSONALITY ${instanceId} `;
    if (command.startsWith(personalityPrefix)) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (state === 'changing') {
        return `ERROR ${instanceId} BUSY\n`;
      }
      if (!runtimeHandlers.requestSetPersonality) {
        return `ERROR ${instanceId} UNSUPPORTED\n`;
      }
      if (state !== 'running' && state !== 'paused') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }

      const rest = command.slice(personalityPrefix.length);
      const space = rest.indexOf(' ');
      if (space < 0) {
        return `ERROR ${instanceId} INVALID_REQUEST\n`;
      }
      const mode = decodeProtocolText(rest.slice(0, space));
      const instruction = decodeProtocolText(rest.slice(space + 1));
      if (!isBotPersonalityMode(mode)) {
        return `ERROR ${instanceId} INVALID_REQUEST\n`;
      }
      if (mode === 'custom' && (!instruction || instruction.trim().length === 0)) {
        return `ERROR ${instanceId} INVALID_REQUEST\n`;
      }
      const previousState = state;
      state = 'changing';
      try {
        const result = await runtimeHandlers.requestSetPersonality(mode, instruction);
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = previousState;
        if (result.status === 'changed') {
          return `CHANGED ${instanceId}\n`;
        }
        return `FAILED ${instanceId} ${encodeProtocolText(result.reason)}\n`;
      } catch (error) {
        if (!isStopping()) {
          state = previousState;
        }
        return `FAILED ${instanceId} ${encodeProtocolText(
          error instanceof Error ? error.message : String(error),
        )}\n`;
      }
    }

    if (command === `PAUSE ${instanceId}`) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (state === 'changing') {
        return `ERROR ${instanceId} BUSY\n`;
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
      state = 'changing';
      try {
        await runtimeHandlers.requestPause();
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = 'paused';
        return `PAUSED ${instanceId}\n`;
      } catch {
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = 'running';
        return `ERROR ${instanceId} PAUSE_FAILED\n`;
      }
    }

    if (command === `RESUME ${instanceId}`) {
      if (state === 'stopping') {
        return `ERROR ${instanceId} INVALID_STATE\n`;
      }
      if (state === 'changing') {
        return `ERROR ${instanceId} BUSY\n`;
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
      state = 'changing';
      try {
        await runtimeHandlers.requestResume();
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = 'running';
        return `RESUMED ${instanceId}\n`;
      } catch {
        if (isStopping()) {
          return `ERROR ${instanceId} ABORTED\n`;
        }
        state = 'paused';
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

interface RuntimeConnection {
  instanceId: string;
  socket: Socket;
}

interface RuntimeConnectionOptions<T> {
  notOwnedMessage: string;
  run: (connection: RuntimeConnection) => Promise<T>;
}

async function withRuntimeConnection<T>(
  configurationFilePath: string | undefined,
  options: RuntimeConnectionOptions<T>,
): Promise<T | RuntimeNotRunning> {
  assertWindowsRuntimeSupport();
  const socket = createConnection(getRuntimeControlEndpoint(configurationFilePath));

  try {
    const instanceId = parseRuntimeHandshake(await readLine(socket));
    if (!instanceId) {
      throw new RuntimeControlEndpointError(options.notOwnedMessage);
    }
    return await options.run({ instanceId, socket });
  } catch (error) {
    if (isPipeMissing(error)) {
      return { status: 'not-running' };
    }
    throw error;
  } finally {
    socket.destroy();
  }
}

async function requestRuntimeResponse(
  socket: Socket,
  command: string,
  timeoutMs = 0,
): Promise<string> {
  socket.setTimeout(0);
  socket.write(`${command}\n`);
  return readLine(socket, timeoutMs);
}

function runtimeErrorReason(response: string, instanceId: string): string | undefined {
  const prefix = `ERROR ${instanceId} `;
  return response.startsWith(prefix) ? response.slice(prefix.length) : undefined;
}

async function requestRuntimeTransition(
  configurationFilePath: string | undefined,
  command: RuntimeTransitionCommand,
): Promise<{ status: 'paused' | 'resumed'; instanceId: string } | RuntimeNotRunning> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage:
      `${RUNTIME_NOT_OWNED_PREFIX}; no ${command.toLowerCase()} request was sent.`,
    run: async ({ instanceId, socket }) => {
      const response = await requestRuntimeResponse(socket, `${command} ${instanceId}`);
      const expected = command === 'PAUSE' ? `PAUSED ${instanceId}` : `RESUMED ${instanceId}`;
      if (response === expected) {
        return {
          status: command === 'PAUSE' ? 'paused' : 'resumed',
          instanceId,
        };
      }
      const reason = runtimeErrorReason(response, instanceId);
      if (reason !== undefined) {
        throw new RuntimeControlEndpointError(
          `The engine rejected the ${command.toLowerCase()} request (${reason}).`,
        );
      }
      throw new RuntimeControlEndpointError(
        `The engine returned an invalid ${command.toLowerCase()} response.`,
      );
    },
  });
}

export async function requestRuntimeChangeDestination(
  configurationFilePath: string | undefined,
  destination: string,
): Promise<RuntimeChangeDestinationResult> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage:
      `${RUNTIME_NOT_OWNED_PREFIX}; no destination change request was sent.`,
    run: async ({ instanceId, socket }) => {
      const response = await requestRuntimeResponse(
        socket,
        `DESTINATION ${instanceId} ${encodeProtocolText(destination)}`,
      );
      if (response === `CHANGED ${instanceId} RUNNING`) {
        return { status: 'changed', instanceId, resumed: true };
      }
      if (response === `CHANGED ${instanceId} PAUSED`) {
        return { status: 'changed', instanceId, resumed: false };
      }
      const rejectedPrefix = `REJECTED ${instanceId} `;
      if (response.startsWith(rejectedPrefix)) {
        const { resumed, reason } = parseDestinationFailureResponse(
          response.slice(rejectedPrefix.length),
        );
        return { status: 'rejected', instanceId, reason, resumed };
      }
      const failedPrefix = `FAILED ${instanceId} `;
      if (response.startsWith(failedPrefix)) {
        const { resumed, reason } = parseDestinationFailureResponse(
          response.slice(failedPrefix.length),
        );
        return { status: 'failed', instanceId, reason, resumed };
      }
      const reason = runtimeErrorReason(response, instanceId);
      if (reason !== undefined) {
        throw new RuntimeControlEndpointError(
          `The engine rejected the destination change request (${reason}).`,
        );
      }
      throw new RuntimeControlEndpointError(
        'The engine returned an invalid destination change response.',
      );
    },
  });
}

export async function requestRuntimeSetTemperament(
  configurationFilePath: string | undefined,
  temperament: BotTemperament,
): Promise<RuntimeSetTemperamentResult> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage:
      `${RUNTIME_NOT_OWNED_PREFIX}; no temperament change request was sent.`,
    run: async ({ instanceId, socket }) => {
      const response = await requestRuntimeResponse(
        socket,
        `TEMPERAMENT ${instanceId} ${encodeProtocolText(temperament)}`,
      );
      if (response === `CHANGED ${instanceId}`) {
        return { status: 'changed', instanceId, temperament };
      }
      const failedPrefix = `FAILED ${instanceId} `;
      if (response.startsWith(failedPrefix)) {
        return {
          status: 'failed',
          instanceId,
          reason: decodeProtocolText(response.slice(failedPrefix.length)),
        };
      }
      const reason = runtimeErrorReason(response, instanceId);
      if (reason !== undefined) {
        throw new RuntimeControlEndpointError(
          `The engine rejected the temperament change request (${reason}).`,
        );
      }
      throw new RuntimeControlEndpointError(
        'The engine returned an invalid temperament change response.',
      );
    },
  });
}

export async function requestRuntimeSetPersonality(
  configurationFilePath: string | undefined,
  mode: BotPersonalityMode,
  instruction: string,
): Promise<RuntimeSetPersonalityResult> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage:
      `${RUNTIME_NOT_OWNED_PREFIX}; no personality change request was sent.`,
    run: async ({ instanceId, socket }) => {
      const response = await requestRuntimeResponse(
        socket,
        `PERSONALITY ${instanceId} ${encodeProtocolText(mode)} ${encodeProtocolText(instruction)}`,
      );
      if (response === `CHANGED ${instanceId}`) {
        return { status: 'changed', instanceId, mode, instruction };
      }
      const failedPrefix = `FAILED ${instanceId} `;
      if (response.startsWith(failedPrefix)) {
        return {
          status: 'failed',
          instanceId,
          reason: decodeProtocolText(response.slice(failedPrefix.length)),
        };
      }
      const reason = runtimeErrorReason(response, instanceId);
      if (reason !== undefined) {
        throw new RuntimeControlEndpointError(
          `The engine rejected the personality change request (${reason}).`,
        );
      }
      throw new RuntimeControlEndpointError(
        'The engine returned an invalid personality change response.',
      );
    },
  });
}

type RuntimeRunningStatus = { status: 'running'; instanceId: string };

export type RuntimeStatusResult = RuntimeRunningStatus | RuntimeNotRunning;

export type RuntimeStatusSnapshotResult =
  | (RuntimeRunningStatus & RuntimeStatusSnapshot)
  | RuntimeNotRunning
  | { status: 'unsupported'; instanceId: string };

function isRuntimeEngineState(value: string): value is RuntimeEngineState {
  return ['starting', 'running', 'paused', 'changing', 'stopping'].includes(value);
}

function isBrowserId(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

export async function requestRuntimeStatusSnapshot(
  configurationFilePath?: string,
): Promise<RuntimeStatusSnapshotResult> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage: `${RUNTIME_NOT_OWNED_PREFIX}; no status request was sent.`,
    run: async ({ instanceId, socket }) => {
      const response = await requestRuntimeResponse(socket, `STATUS ${instanceId}`);
      const responsePrefix = `STATUS ${instanceId} `;
      if (response.startsWith(responsePrefix)) {
        const [state, browser, temperament, personality, encodedDestination, ...extra] =
          response.slice(responsePrefix.length).split(' ');
        if (
          extra.length > 0 ||
          !isRuntimeEngineState(state) ||
          !isBrowserId(browser) ||
          !isBotTemperament(temperament) ||
          !isBotPersonalityMode(personality) ||
          encodedDestination === undefined
        ) {
          throw new RuntimeControlEndpointError(
            'The engine returned an invalid status response.',
          );
        }
        return {
          status: 'running',
          instanceId,
          state,
          browser,
          temperament,
          personality,
          messengerDestination: decodeProtocolText(encodedDestination),
        };
      }
      if (
        response === `ERROR ${instanceId} UNSUPPORTED` ||
        response === `ERROR ${instanceId} INVALID_REQUEST`
      ) {
        return { status: 'unsupported', instanceId };
      }
      const reason = runtimeErrorReason(response, instanceId);
      if (reason !== undefined) {
        throw new RuntimeControlEndpointError(
          `The engine could not provide its runtime status (${reason}).`,
        );
      }
      throw new RuntimeControlEndpointError('The engine returned an invalid status response.');
    },
  });
}

export async function requestRuntimeStatus(
  configurationFilePath?: string,
): Promise<RuntimeStatusResult> {
  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage: `${RUNTIME_NOT_OWNED_PREFIX}.`,
    run: async ({ instanceId }) => ({ status: 'running', instanceId }),
  });
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

export interface RuntimeStopOptions {
  responseTimeoutMs?: number;
}

export async function requestRuntimeStop(
  configurationFilePath?: string,
  options: RuntimeStopOptions = {},
): Promise<RuntimeStopResult> {
  assertWindowsRuntimeSupport();

  const responseTimeoutMs = options.responseTimeoutMs ?? STOP_RESPONSE_TIMEOUT_MS;
  if (responseTimeoutMs <= 0) {
    throw new RuntimeControlEndpointError('Runtime stop response timeout must be positive.');
  }

  return withRuntimeConnection(configurationFilePath, {
    notOwnedMessage: `${RUNTIME_NOT_OWNED_PREFIX}; no stop request was sent.`,
    run: async ({ instanceId, socket }) => {
      let response: string;
      try {
        response = await requestRuntimeResponse(
          socket,
          `STOP ${instanceId}`,
          responseTimeoutMs,
        );
      } catch (error) {
        if (error instanceof RuntimeControlTimeoutError) {
          throw new RuntimeControlTimeoutError(
            'Timed out waiting for the runtime-control stop response; the engine may have ' +
            'stopped, so shutdown is not confirmed.',
          );
        }
        throw error;
      }
      if (response === `STOPPED ${instanceId} 0` || response === `STOPPED ${instanceId} 130`) {
        return { status: 'stopped', instanceId };
      }
      const failedPrefix = `FAILED ${instanceId} `;
      if (response.startsWith(failedPrefix)) {
        throw new RuntimeControlEndpointError(
          `The engine received the stop request but shutdown failed (exit code ${response.slice(failedPrefix.length)}).`,
        );
      }
      throw new RuntimeControlEndpointError('The engine returned an invalid stop response.');
    },
  });
}

export type RuntimeShutdownWaitResult =
  | { status: 'stopped' }
  | { status: 'unconfirmed'; reason: string };

export interface RuntimeShutdownWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function waitForRuntimeShutdown(
  configurationFilePath?: string,
  options: RuntimeShutdownWaitOptions = {},
): Promise<RuntimeShutdownWaitResult> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_CONFIRMATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SHUTDOWN_CONFIRMATION_POLL_INTERVAL_MS;
  if (timeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new RuntimeControlEndpointError(
      'Runtime shutdown confirmation timeout and polling interval must be positive.',
    );
  }

  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  }));
  const deadline = now() + timeoutMs;
  let lastError: string | undefined;

  while (true) {
    try {
      const status = await requestRuntimeStatus(configurationFilePath);
      if (status.status === 'not-running') {
        return { status: 'stopped' };
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: 'unconfirmed',
        reason: lastError ?? 'The runtime endpoint is still owned by a running engine.',
      };
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }
}
