import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import { chromium, type Browser, type ConnectOverCDPOptions } from 'playwright';
import { validateConfiguration, type Configuration } from '../config/configuration.js';

export interface BrowserProcessHandle {
  readonly pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  unref(): void;
}

export interface BrowserLaunchFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
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
  findProfileProcesses?: (executablePath: string, profilePath: string) => Promise<number[]>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserCloseOptions {
  platform?: NodeJS.Platform;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  findProfileProcesses?: (executablePath: string, profilePath: string) => Promise<number[]>;
  requestProcessClose?: (processIds: number[]) => Promise<void>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserLaunchSession {
  endpoint: string;
  browserVersion: string;
  disconnect(): Promise<void>;
}

interface ChildState {
  exited: boolean;
  failure?: Error;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const defaultFileSystem: BrowserLaunchFileSystem = { mkdir };

function findProfileProcesses(executablePath: string, profilePath: string): Promise<number[]> {
  const script = `
$ErrorActionPreference = 'Stop'
$profile = $env:IMPBOT_PROFILE_PATH.TrimEnd([char]92)
$needle = '--user-data-dir=' + $profile
$comparison = [System.StringComparison]::OrdinalIgnoreCase
$matchingProcessIds = @(Get-CimInstance Win32_Process -Filter "Name='$env:IMPBOT_BROWSER_NAME'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  $index = $commandLine.IndexOf($needle, $comparison)
  if ($index -lt 0 -or -not [System.String]::Equals($_.ExecutablePath, $env:IMPBOT_BROWSER_PATH, $comparison)) {
    return $false
  }
  $end = $index + $needle.Length
  $end -eq $commandLine.Length -or [char]::IsWhiteSpace($commandLine[$end]) -or $commandLine[$end] -eq '"' -or $commandLine[$end] -eq [char]92
} | ForEach-Object { [int]$_.ProcessId })
if ($matchingProcessIds.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $matchingProcessIds -Compress }
`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          IMPBOT_BROWSER_NAME: win32.basename(executablePath),
          IMPBOT_BROWSER_PATH: executablePath,
          IMPBOT_PROFILE_PATH: profilePath,
        },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Unable to check whether the configured browser profile is already in use.', {
            cause: error,
          }));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
          const processIds = Array.isArray(parsed) ? parsed : [parsed];
          if (!processIds.every(processId => Number.isInteger(processId) && processId > 0)) {
            throw new Error('Browser profile process query returned invalid process IDs.');
          }
          resolve(processIds as number[]);
        } catch (error) {
          reject(new Error('Unable to parse the browser profile process query result.', { cause: error }));
        }
      },
    );
  });
}

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.once('connect', () => finish(new Error(`CDP port ${port} is already in use; refusing to attach.`)));
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        finish();
      } else {
        finish(new Error(`Unable to verify that CDP port ${port} is available.`, { cause: error }));
      }
    });
    socket.setTimeout(1_000);
    socket.once('timeout', () => finish(new Error(`Timed out checking whether CDP port ${port} is available.`)));
  });
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requestWindowsProcessClose(processIds: number[]): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$processIds = $env:IMPBOT_PROCESS_IDS.Split(',') | ForEach-Object { [int]$_ }
$requested = $false
foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    if (-not $process.CloseMainWindow()) {
      throw "Process $processId did not accept a graceful close request."
    }
    $requested = $true
  }
}
if (-not $requested) { throw 'No dedicated browser window accepted a graceful close request.' }
`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, IMPBOT_PROCESS_IDS: processIds.join(',') },
      },
      error => error
        ? reject(new Error('Unable to request graceful browser shutdown.', { cause: error }))
        : resolve(),
    );
  });
}

export async function closeConfiguredBrowser(
  configuration: Configuration,
  options: BrowserCloseOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser closing is not supported on '${platform}'.`);
  }

  const validatedConfiguration = validateConfiguration(configuration);
  const getProfileProcesses = options.findProfileProcesses ?? findProfileProcesses;
  const processIds = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (processIds.length === 0) {
    return;
  }

  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (shutdownTimeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error('Browser shutdown and polling timeouts must be positive.');
  }

  await (options.requestProcessClose ?? requestWindowsProcessClose)(processIds);

  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const deadline = now() + shutdownTimeoutMs;
  while (now() <= deadline) {
    const remainingProcesses = await getProfileProcesses(
      validatedConfiguration.executablePath,
      validatedConfiguration.profilePath,
    );
    if (remainingProcesses.length === 0) {
      return;
    }
    const remainingTime = deadline - now();
    if (remainingTime <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remainingTime));
  }

  throw new Error('Timed out waiting for the dedicated browser to shut down gracefully.');
}

async function waitForEndpoint(
  port: number,
  childState: ChildState,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
  startupTimeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const endpointUrl = `http://127.0.0.1:${port}/json/version`;
  const deadline = now() + startupTimeoutMs;

  while (now() <= deadline) {
    if (childState.failure) {
      throw childState.failure;
    }
    if (childState.exited) {
      throw new Error('Browser process exited before its CDP endpoint became ready.');
    }

    try {
      const response = await fetch(endpointUrl, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) {
        throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
      }
      const result = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof result.webSocketDebuggerUrl !== 'string') {
        throw new Error('CDP endpoint did not return a browser WebSocket URL.');
      }
      const websocketUrl = new URL(result.webSocketDebuggerUrl);
      if (
        websocketUrl.protocol !== 'ws:' ||
        !['127.0.0.1', 'localhost'].includes(websocketUrl.hostname) ||
        websocketUrl.port !== String(port) ||
        !websocketUrl.pathname.startsWith('/devtools/browser/')
      ) {
        throw new Error('CDP endpoint returned a WebSocket URL outside the configured loopback endpoint.');
      }
      if (childState.exited) {
        throw new Error('Browser process exited before its CDP connection was accepted.');
      }
      return websocketUrl.href;
    } catch (error) {
      if (error instanceof Error && !('cause' in error) && /CDP endpoint/.test(error.message)) {
        throw error;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }

  if (childState.failure) {
    throw childState.failure;
  }
  if (childState.exited) {
    throw new Error('Browser process exited before its CDP endpoint became ready.');
  }
  throw new Error('Timed out waiting for the browser CDP endpoint.');
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
  if (validatedConfiguration.cdpPort === undefined || !validatedConfiguration.startupUrl) {
    throw new Error('Configuration is missing its CDP port or startup URL. Run `impbot init` to update it.');
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (startupTimeoutMs <= 0 || pollIntervalMs <= 0 || connectionTimeoutMs <= 0) {
    throw new Error('Browser startup, polling, and connection timeouts must be positive.');
  }

  const getProfileProcesses = options.findProfileProcesses ?? findProfileProcesses;
  const existingProcesses = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (existingProcesses.length > 0) {
    throw new Error(
      `Browser process(es) ${existingProcesses.join(', ')} already use the configured profile; refusing to launch another tab.`,
    );
  }
  await assertPortAvailable(validatedConfiguration.cdpPort);

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  await fileSystem.mkdir(validatedConfiguration.profilePath, { recursive: true });
  const spawnProcess = options.spawnProcess ?? ((executablePath, args, spawnOptions) =>
    spawn(executablePath, args, spawnOptions));
  const child = spawnProcess(
    validatedConfiguration.executablePath,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${validatedConfiguration.cdpPort}`,
      `--user-data-dir=${validatedConfiguration.profilePath}`,
      validatedConfiguration.startupUrl,
    ],
    { detached: true, shell: false, windowsHide: false, stdio: 'ignore' },
  );
  const childState: ChildState = { exited: false };
  child.once('error', error => {
    childState.failure = error;
  });
  child.once('exit', () => {
    childState.exited = true;
  });
  child.unref();

  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const endpoint = await waitForEndpoint(
    validatedConfiguration.cdpPort,
    childState,
    now,
    delay,
    startupTimeoutMs,
    pollIntervalMs,
  );
  const ownerProcessIds = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (child.pid === undefined || !ownerProcessIds.includes(child.pid) || childState.exited) {
    throw new Error('Unable to verify that the launched process owns the configured CDP endpoint; refusing to attach.');
  }

  const connectOverCDP = options.connectOverCDP ?? ((url, connectOptions) =>
    chromium.connectOverCDP(url, connectOptions));
  const browser = await connectOverCDP(endpoint, {
    isLocal: true,
    noDefaults: true,
    timeout: connectionTimeoutMs,
  });

  try {
    if (!browser.isConnected()) {
      throw new Error('Playwright completed the CDP connection but reports the browser disconnected.');
    }
    const browserVersion = await browser.version();
    if (!browserVersion.trim() || !browser.isConnected() || childState.exited) {
      throw new Error('Playwright CDP connection verification failed.');
    }

    let disconnectPromise: Promise<void> | undefined;
    return {
      endpoint,
      browserVersion,
      disconnect() {
        disconnectPromise ??= browser.close();
        return disconnectPromise;
      },
    };
  } catch (error) {
    if (browser.isConnected()) {
      await browser.close().catch(() => undefined);
    }
    throw error;
  }
}
