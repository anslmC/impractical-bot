import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  chromium,
  type Browser,
  type ConnectOverCDPOptions,
} from 'playwright';
import { validateConfiguration, type Configuration } from '../config/configuration.js';

export interface BrowserProcessHandle {
  readonly pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface BrowserLaunchFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

export interface BrowserLaunchOptions {
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  connectionTimeoutMs?: number;
  fileSystem?: BrowserLaunchFileSystem;
  spawnProcess?: (
    executablePath: string,
    args: string[],
    options: SpawnOptions,
  ) => BrowserProcessHandle;
  connectOverCDP?: (
    endpoint: string,
    options: ConnectOverCDPOptions,
  ) => Promise<Browser>;
  terminateProcessTree?: (process: BrowserProcessHandle) => Promise<void>;
  runTaskkill?: (pid: number) => Promise<void>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserLaunchSession {
  browser: Browser;
  process: BrowserProcessHandle;
  endpoint: string;
  browserVersion: string;
  disconnect(): Promise<void>;
}

interface BrowserProcessState {
  failure?: Error;
  exited: boolean;
  spawnFailed: boolean;
  cleanupInProgress: boolean;
  cleanupIncomplete: boolean;
  sessionReturned: boolean;
}

interface MarkerSnapshot {
  content: string;
  mtimeMs: number;
}

interface DevToolsEndpoint {
  port: number;
  websocketPath: string;
  url: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

const defaultFileSystem: BrowserLaunchFileSystem = {
  mkdir,
  readFile,
  stat,
  unlink,
};

const activeProfilePaths = new Set<string>();

function reserveProfile(profilePath: string): () => void {
  const normalizedPath = win32.normalize(profilePath);
  const root = win32.parse(normalizedPath).root;
  const pathWithoutTrailingSeparators = normalizedPath.length > root.length
    ? normalizedPath.replace(/[\\/]+$/, '')
    : normalizedPath;
  const key = pathWithoutTrailingSeparators.toLowerCase();
  if (activeProfilePaths.has(key)) {
    throw new Error('A browser launch is already using this profile.');
  }

  activeProfilePaths.add(key);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeProfilePaths.delete(key);
    }
  };
}

async function clearActivePortMarker(
  fileSystem: BrowserLaunchFileSystem,
  markerPath: string,
): Promise<void> {
  try {
    await fileSystem.unlink(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to remove stale DevToolsActivePort marker.', { cause: error });
    }
  }
}

function parseDevToolsEndpoint(content: string): DevToolsEndpoint {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length !== 2) {
    throw new Error('DevToolsActivePort must contain a port and a browser WebSocket path.');
  }

  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DevToolsActivePort contains an invalid port.');
  }

  const websocketPath = lines[1];
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(websocketPath)) {
    throw new Error('DevToolsActivePort contains an invalid browser WebSocket path.');
  }

  return {
    port,
    websocketPath,
    url: `ws://127.0.0.1:${port}${websocketPath}`,
  };
}

async function readMarker(
  fileSystem: BrowserLaunchFileSystem,
  markerPath: string,
): Promise<MarkerSnapshot | undefined> {
  try {
    const [content, metadata] = await Promise.all([
      fileSystem.readFile(markerPath, 'utf8'),
      fileSystem.stat(markerPath),
    ]);
    return { content, mtimeMs: metadata.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function defaultTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      error => error ? reject(error) : resolve(),
    );
  });
}

async function defaultTerminateProcessTree(
  process: BrowserProcessHandle,
  runTaskkill: (pid: number) => Promise<void>,
  isExited: () => boolean,
): Promise<void> {
  if (process.pid === undefined) {
    throw new Error('Browser process-tree cleanup incomplete: spawned process has no PID.');
  }
  if (isExited()) {
    throw new Error('Browser process-tree cleanup incomplete: owned process exited before taskkill.');
  }

  try {
    await runTaskkill(process.pid);
  } catch (error) {
    let fallbackResult = 'direct-child signal was not sent';
    if (!isExited()) {
      try {
        fallbackResult = process.kill()
          ? 'direct-child signal was sent, but descendant termination is unverified'
          : 'direct-child signal was not sent';
      } catch {
        fallbackResult = 'direct-child signal failed';
      }
    }
    throw new Error(
      `Browser process-tree cleanup incomplete: taskkill failed and ${fallbackResult}.`,
      { cause: error },
    );
  }
}

function isProcessFailure(
  failure: Error | undefined,
  exited: boolean,
): Error | undefined {
  if (failure) {
    return failure;
  }
  if (exited) {
    return new Error('Browser process exited before its CDP endpoint became ready.');
  }
  return undefined;
}

async function waitForEndpoint(
  markerPath: string,
  process: BrowserProcessHandle,
  processState: { failure?: Error; exited: boolean },
  fileSystem: BrowserLaunchFileSystem,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
  startupTimeoutMs: number,
  pollIntervalMs: number,
): Promise<DevToolsEndpoint> {
  const deadline = now() + startupTimeoutMs;
  let malformedEndpoint = false;

  while (now() <= deadline) {
    const processFailure = isProcessFailure(processState.failure, processState.exited);
    if (processFailure) {
      throw processFailure;
    }

    const marker = await readMarker(fileSystem, markerPath);
    if (marker) {
      try {
        return parseDevToolsEndpoint(marker.content);
      } catch {
        malformedEndpoint = true;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }

  if (isProcessFailure(processState.failure, processState.exited)) {
    throw isProcessFailure(processState.failure, processState.exited);
  }
  if (malformedEndpoint) {
    throw new Error('Browser wrote malformed DevToolsActivePort data before startup timed out.');
  }
  throw new Error('Timed out waiting for the browser CDP endpoint.');
}

async function cleanupFailedLaunch(
  process: BrowserProcessHandle,
  browser: Browser | undefined,
  processState: BrowserProcessState,
  terminateProcessTree: (process: BrowserProcessHandle) => Promise<void>,
): Promise<Error[]> {
  const errors: Error[] = [];

  if (browser?.isConnected()) {
    try {
      await browser.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (processState.spawnFailed) {
    return errors;
  }

  if (processState.exited) {
    errors.push(new Error('Browser process-tree cleanup incomplete: descendants could not be verified after process exit.'));
  } else if (process.pid === undefined) {
    errors.push(new Error('Browser process-tree cleanup incomplete: spawned process has no PID.'));
  } else {
    try {
      await terminateProcessTree(process);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return errors;
}

export async function launchConfiguredBrowser(
  configuration: Configuration,
  options: BrowserLaunchOptions = {},
): Promise<BrowserLaunchSession> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser launching is not supported on '${platform}'.`);
  }

  const validatedConfiguration = validateConfiguration(configuration);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (startupTimeoutMs <= 0 || pollIntervalMs <= 0 || connectionTimeoutMs <= 0) {
    throw new Error('Browser startup, polling, and connection timeouts must be positive.');
  }

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const releaseProfile = reserveProfile(validatedConfiguration.profilePath);
  const spawnProcess = options.spawnProcess ?? ((executablePath, args, spawnOptions) =>
    spawn(executablePath, args, spawnOptions));
  const connectOverCDP = options.connectOverCDP ?? ((endpoint, connectOptions) =>
    chromium.connectOverCDP(endpoint, connectOptions));
  const runTaskkill = options.runTaskkill ?? defaultTaskkill;
  let terminateProcessTree = options.terminateProcessTree;
  const markerPath = win32.join(validatedConfiguration.profilePath, 'DevToolsActivePort');
  let child: BrowserProcessHandle | undefined;
  const processState: BrowserProcessState = {
    exited: false,
    spawnFailed: false,
    cleanupInProgress: false,
    cleanupIncomplete: false,
    sessionReturned: false,
  };
  let browser: Browser | undefined;
  try {
    await fileSystem.mkdir(validatedConfiguration.profilePath, { recursive: true });
    await clearActivePortMarker(fileSystem, markerPath);
    child = spawnProcess(
      validatedConfiguration.executablePath,
      [
        `--user-data-dir=${validatedConfiguration.profilePath}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      {
        shell: false,
        windowsHide: false,
        stdio: 'ignore',
      },
    );
    child.once('error', error => {
      processState.failure = error;
      processState.spawnFailed = child?.pid === undefined;
      if (processState.spawnFailed && !processState.cleanupInProgress) {
        releaseProfile();
      }
    });
    child.once('exit', (code, signal) => {
      processState.exited = true;
      processState.failure = new Error(
        `Browser process exited before its CDP endpoint became ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
      );
      if (
        processState.sessionReturned &&
        !processState.cleanupInProgress &&
        !processState.cleanupIncomplete
      ) {
        releaseProfile();
      }
    });
    terminateProcessTree ??= ownedProcess => defaultTerminateProcessTree(
      ownedProcess,
      runTaskkill,
      () => processState.exited,
    );

    const endpoint = await waitForEndpoint(
      markerPath,
      child,
      processState,
      fileSystem,
      now,
      delay,
      startupTimeoutMs,
      pollIntervalMs,
    );
    const processFailure = isProcessFailure(processState.failure, processState.exited);
    if (processFailure) {
      throw processFailure;
    }
    browser = await connectOverCDP(endpoint.url, {
      isLocal: true,
      noDefaults: true,
      timeout: connectionTimeoutMs,
    });

    if (!browser.isConnected()) {
      throw new Error('Playwright completed the CDP connection but reports the browser disconnected.');
    }
    const browserVersion = await browser.version();
    if (
      !browserVersion.trim() ||
      !browser.isConnected() ||
      isProcessFailure(processState.failure, processState.exited)
    ) {
      throw new Error('Playwright CDP connection verification failed.');
    }

    let disconnected = false;
    processState.sessionReturned = true;
    return {
      browser,
      process: child,
      endpoint: endpoint.url,
      browserVersion,
      async disconnect() {
        if (disconnected) {
          return;
        }
        disconnected = true;
        if (browser?.isConnected()) {
          await browser.close();
        }
      },
    };
  } catch (error) {
    const startupError = error instanceof Error ? error : new Error(String(error));
    if (!child) {
      releaseProfile();
      throw startupError;
    }
    processState.cleanupInProgress = true;
    const cleanupErrors = await cleanupFailedLaunch(
      child,
      browser,
      processState,
      terminateProcessTree ?? (ownedProcess => defaultTerminateProcessTree(
        ownedProcess,
        runTaskkill,
        () => processState.exited,
      )),
    );
    processState.cleanupInProgress = false;
    if (cleanupErrors.length > 0 && !processState.spawnFailed) {
      processState.cleanupIncomplete = true;
    }
    if (cleanupErrors.length === 0 || processState.spawnFailed) {
      releaseProfile();
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        `Browser startup failed: ${startupError.message}; cleanup incomplete (${cleanupErrors.length} error(s)).`,
      );
    }
    throw startupError;
  }
}
