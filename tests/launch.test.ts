import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  launchConfiguredBrowser,
  type BrowserLaunchFileSystem,
  type BrowserProcessHandle,
} from '../src/browser/launch.js';
import type { Configuration } from '../src/config/configuration.js';

const configuration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Browsers\\Brave\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\browser-profile',
};

class FakeProcess extends EventEmitter implements BrowserProcessHandle {
  readonly pid = 12345;
  killCalls: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

class FakeFileSystem implements BrowserLaunchFileSystem {
  readonly directories: string[] = [];
  readonly unlinkedPaths: string[] = [];
  markerContent: string | undefined;
  markerMtime = 0;
  mkdirFailure: Error | undefined;
  unlinkFailure: Error | undefined;

  async mkdir(path: string): Promise<void> {
    if (this.mkdirFailure) {
      throw this.mkdirFailure;
    }
    this.directories.push(path);
  }

  async readFile(path: string): Promise<string> {
    if (this.markerContent === undefined) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: 'ENOENT' });
    }
    return this.markerContent;
  }

  async stat(): Promise<{ mtimeMs: number }> {
    if (this.markerContent === undefined) {
      throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
    }
    return { mtimeMs: this.markerMtime };
  }

  async unlink(path: string): Promise<void> {
    this.unlinkedPaths.push(path);
    if (this.unlinkFailure) {
      throw this.unlinkFailure;
    }
    if (this.markerContent === undefined) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: 'ENOENT' });
    }
    this.markerContent = undefined;
    this.markerMtime = 0;
  }
}

function createBrowserMock(overrides: Partial<{
  isConnected: () => boolean;
  version: () => Promise<string>;
  close: () => Promise<void>;
}> = {}) {
  const calls = { close: 0, version: 0 };
  const browser = {
    isConnected: overrides.isConnected ?? (() => true),
    async version() {
      calls.version += 1;
      return overrides.version ? overrides.version() : 'Brave Chromium test';
    },
    async close() {
      calls.close += 1;
      if (overrides.close) {
        await overrides.close();
      }
    },
  };
  return { browser, calls };
}

function createOptions(
  fileSystem: FakeFileSystem,
  child: FakeProcess,
  overrides: {
    startupTimeoutMs?: number;
    connectionTimeoutMs?: number;
    onSpawn?: (executablePath: string, args: string[], options: { shell?: string | boolean }) => void;
    connect?: (endpoint: string, options: { isLocal?: boolean; noDefaults?: boolean; timeout?: number }) => Promise<unknown>;
    terminate?: (process: BrowserProcessHandle) => Promise<void>;
    runTaskkill?: (pid: number) => Promise<void>;
  } = {},
  selectedConfiguration: Configuration = configuration,
) {
  const calls = {
    connectedEndpoint: '' as string,
    terminateProcess: undefined as BrowserProcessHandle | undefined,
    now: 0,
  };
  const terminateProcessTree = overrides.terminate
    ? async (process: BrowserProcessHandle) => {
      calls.terminateProcess = process;
      await overrides.terminate?.(process);
    }
    : undefined;
  const launch = launchConfiguredBrowser(selectedConfiguration, {
    platform: 'win32',
    startupTimeoutMs: overrides.startupTimeoutMs ?? 100,
    pollIntervalMs: 10,
    connectionTimeoutMs: overrides.connectionTimeoutMs ?? 50,
    fileSystem,
    spawnProcess: (executablePath, args, spawnOptions) => {
      overrides.onSpawn?.(executablePath, args, spawnOptions);
      return child;
    },
    connectOverCDP: async (endpoint, options) => {
      calls.connectedEndpoint = endpoint;
      if (overrides.connect) {
        return await overrides.connect(endpoint, options) as never;
      }
      return createBrowserMock().browser as never;
    },
    terminateProcessTree,
    runTaskkill: overrides.runTaskkill,
    now: () => calls.now,
    delay: async milliseconds => {
      calls.now += milliseconds;
    },
  });
  return { launch, calls };
}

function writeEndpoint(fileSystem: FakeFileSystem, port = 43127): void {
  fileSystem.markerContent = `${port}\n/devtools/browser/test-endpoint\n`;
  fileSystem.markerMtime = 2;
}

async function disconnectAndExit(
  session: Awaited<ReturnType<typeof launchConfiguredBrowser>>,
  child: FakeProcess,
): Promise<void> {
  await session.disconnect();
  child.emit('exit', 0, null);
}

test('launches configured browser with dedicated profile and a dynamic loopback CDP port', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const browserMock = createBrowserMock();
  let launchArguments: string[] = [];
  let shellOption: string | boolean | undefined;
  let connectionOptions: { isLocal?: boolean; noDefaults?: boolean; timeout?: number } | undefined;
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: (executablePath, args, options) => {
      assert.equal(executablePath, configuration.executablePath);
      launchArguments = args;
      shellOption = options.shell;
      writeEndpoint(fileSystem);
    },
    connect: async (_endpoint, options) => {
      connectionOptions = options;
      return browserMock.browser as never;
    },
    terminate: async () => undefined,
  });

  const session = await launch;

  assert.equal(fileSystem.directories[0], configuration.profilePath);
  assert.ok(launchArguments.includes(`--user-data-dir=${configuration.profilePath}`));
  assert.ok(launchArguments.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launchArguments.includes('--remote-debugging-port=0'));
  assert.equal(shellOption, false);
  assert.equal(calls.connectedEndpoint, 'ws://127.0.0.1:43127/devtools/browser/test-endpoint');
  assert.equal(session.process, child);
  assert.equal(session.browserVersion, 'Brave Chromium test');
  assert.equal(browserMock.calls.version, 1);
  assert.deepEqual(connectionOptions, { isLocal: true, noDefaults: true, timeout: 50 });

  await disconnectAndExit(session, child);
  assert.equal(browserMock.calls.close, 1);
  assert.equal(child.killCalls.length, 0);
  assert.equal(calls.terminateProcess, undefined);
});

test('launches configured Brave, Chrome, and Edge executables through Chromium', async () => {
  const browserExecutables = [
    ['brave', 'C:\\Browsers\\Brave\\brave.exe'],
    ['chrome', 'C:\\Browsers\\Chrome\\chrome.exe'],
    ['edge', 'C:\\Browsers\\Edge\\msedge.exe'],
  ] as const;

  for (const [browser, executablePath] of browserExecutables) {
    const fileSystem = new FakeFileSystem();
    const child = new FakeProcess();
    const selectedConfiguration: Configuration = {
      ...configuration,
      browser,
      executablePath,
    };
    const { launch } = createOptions(
      fileSystem,
      child,
      {
        onSpawn: actualExecutable => {
          assert.equal(actualExecutable, executablePath);
          writeEndpoint(fileSystem);
        },
        terminate: async () => undefined,
      },
      selectedConfiguration,
    );

    const session = await launch;
    await disconnectAndExit(session, child);
  }
});

test('accepts identical endpoint contents only after deleting the prior marker', async () => {
  const fileSystem = new FakeFileSystem();
  fileSystem.markerContent = '42222\n/devtools/browser/test-endpoint\n';
  fileSystem.markerMtime = 1;
  const child = new FakeProcess();
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => {
      assert.equal(fileSystem.markerContent, undefined);
      fileSystem.markerContent = '42222\n/devtools/browser/test-endpoint\n';
      fileSystem.markerMtime = 2;
    },
    terminate: async () => undefined,
  });

  const session = await launch;
  assert.deepEqual(fileSystem.unlinkedPaths, [
    'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\browser-profile\\DevToolsActivePort',
  ]);
  assert.equal(calls.connectedEndpoint, 'ws://127.0.0.1:42222/devtools/browser/test-endpoint');
  await disconnectAndExit(session, child);
});

test('marker deletion failure prevents spawning and releases the profile reservation', async () => {
  const fileSystem = new FakeFileSystem();
  fileSystem.markerContent = '41111\n/devtools/browser/old-endpoint\n';
  fileSystem.markerMtime = 1;
  fileSystem.unlinkFailure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const child = new FakeProcess();
  let spawned = false;
  const first = createOptions(fileSystem, child, {
    onSpawn: () => {
      spawned = true;
    },
  });

  await assert.rejects(first.launch, /Unable to remove stale DevToolsActivePort marker/);
  assert.equal(spawned, false);

  fileSystem.unlinkFailure = undefined;
  const retry = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    terminate: async () => undefined,
  });
  const session = await retry.launch;
  await disconnectAndExit(session, child);
});

test('directory creation failure releases the profile reservation for retry', async () => {
  const fileSystem = new FakeFileSystem();
  fileSystem.mkdirFailure = new Error('directory unavailable');
  const child = new FakeProcess();
  let spawnCount = 0;
  const first = createOptions(fileSystem, child, {
    onSpawn: () => {
      spawnCount += 1;
    },
  });

  await assert.rejects(first.launch, /directory unavailable/);
  assert.equal(spawnCount, 0);

  fileSystem.mkdirFailure = undefined;
  const retry = createOptions(fileSystem, child, {
    onSpawn: () => {
      spawnCount += 1;
      writeEndpoint(fileSystem);
    },
    terminate: async () => undefined,
  });
  const session = await retry.launch;
  assert.equal(spawnCount, 1);
  await disconnectAndExit(session, child);
});

test('synchronous spawn failure releases the profile reservation for retry', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const first = createOptions(fileSystem, child, {
    onSpawn: () => {
      throw new Error('spawn failed synchronously');
    },
  });

  await assert.rejects(first.launch, /spawn failed synchronously/);

  const retry = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    terminate: async () => undefined,
  });
  const session = await retry.launch;
  await disconnectAndExit(session, child);
});

test('reserves one profile through disconnect until the owned process exits', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const first = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    terminate: async () => undefined,
  });
  const session = await first.launch;

  let secondSpawned = false;
  const second = createOptions(new FakeFileSystem(), new FakeProcess(), {
    onSpawn: () => {
      secondSpawned = true;
    },
  });
  await assert.rejects(second.launch, /already using this profile/);
  assert.equal(secondSpawned, false);

  await session.disconnect();
  const whileConnected = createOptions(new FakeFileSystem(), new FakeProcess());
  await assert.rejects(whileConnected.launch, /already using this profile/);

  child.emit('exit', 0, null);
  const afterExitFileSystem = new FakeFileSystem();
  const afterExitChild = new FakeProcess();
  const afterExit = createOptions(afterExitFileSystem, afterExitChild, {
    onSpawn: () => writeEndpoint(afterExitFileSystem),
    terminate: async () => undefined,
  });
  const nextSession = await afterExit.launch;
  await disconnectAndExit(nextSession, afterExitChild);
});

test('profile reservation treats trailing separators as equivalent', async () => {
  const profilePath = `${configuration.profilePath}\\`;
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const first = createOptions(
    fileSystem,
    child,
    {
      onSpawn: () => writeEndpoint(fileSystem),
      terminate: async () => undefined,
    },
    { ...configuration, profilePath },
  );
  const session = await first.launch;

  const equivalentPath = createOptions(new FakeFileSystem(), new FakeProcess(), {}, configuration);
  await assert.rejects(equivalentPath.launch, /already using this profile/);
  await disconnectAndExit(session, child);
});

test('profile reservation preserves drive roots and distinguishes different volumes', async () => {
  const driveRootFileSystem = new FakeFileSystem();
  const driveRootChild = new FakeProcess();
  const driveRoot = createOptions(
    driveRootFileSystem,
    driveRootChild,
    {
      onSpawn: () => writeEndpoint(driveRootFileSystem),
      terminate: async () => undefined,
    },
    { ...configuration, profilePath: 'C:\\' },
  );
  const driveRootSession = await driveRoot.launch;

  const equivalentRoot = createOptions(
    new FakeFileSystem(),
    new FakeProcess(),
    {},
    { ...configuration, profilePath: 'C:\\\\' },
  );
  await assert.rejects(equivalentRoot.launch, /already using this profile/);

  const otherVolumeFileSystem = new FakeFileSystem();
  const otherVolumeChild = new FakeProcess();
  const otherVolume = createOptions(
    otherVolumeFileSystem,
    otherVolumeChild,
    {
      onSpawn: () => writeEndpoint(otherVolumeFileSystem),
      terminate: async () => undefined,
    },
    { ...configuration, profilePath: 'D:\\' },
  );
  const otherVolumeSession = await otherVolume.launch;

  await disconnectAndExit(driveRootSession, driveRootChild);
  await disconnectAndExit(otherVolumeSession, otherVolumeChild);
});

test('times out on malformed endpoint data and cleans up only the spawned process tree', async () => {
  const malformedMarkers = [
    'not-a-port\n/devtools/browser/test-endpoint\n',
    '43127\n/not-a-browser-path\n',
  ];

  for (const markerContent of malformedMarkers) {
    const fileSystem = new FakeFileSystem();
    const child = new FakeProcess();
    const { launch, calls } = createOptions(fileSystem, child, {
      startupTimeoutMs: 20,
      onSpawn: () => {
        fileSystem.markerContent = markerContent;
        fileSystem.markerMtime = 2;
      },
      terminate: async () => undefined,
    });

    await assert.rejects(launch, /malformed DevToolsActivePort/);
    assert.equal(calls.terminateProcess, child);
    assert.deepEqual(child.killCalls, []);
  }
});

test('reports an early browser process exit without targeting its stale PID', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const earlyExitConfiguration: Configuration = {
    ...configuration,
    profilePath: `${configuration.profilePath}\\early-exit`,
  };
  let taskkillCalled = false;
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => {
      queueMicrotask(() => child.emit('exit', 2, null));
    },
    runTaskkill: async () => {
      taskkillCalled = true;
    },
  }, earlyExitConfiguration);

  await assert.rejects(launch, error =>
    error instanceof AggregateError &&
    /exited before its CDP endpoint/.test(error.message) &&
    /cleanup incomplete/.test(error.message),
  );
  assert.equal(calls.terminateProcess, undefined);
  assert.equal(taskkillCalled, false);
});

test('cleans up the launched process when CDP connection fails', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    connect: async () => {
      throw new Error('CDP unavailable');
    },
    terminate: async () => undefined,
  });

  await assert.rejects(launch, /CDP unavailable/);
  assert.equal(calls.terminateProcess, child);
});

test('taskkill failure attempts direct-child fallback but reports tree cleanup incomplete', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const cleanupConfiguration: Configuration = {
    ...configuration,
    profilePath: `${configuration.profilePath}\\cleanup-incomplete`,
  };
  const taskkillPids: number[] = [];
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    connect: async () => {
      throw new Error('CDP unavailable');
    },
    runTaskkill: async pid => {
      taskkillPids.push(pid);
      throw new Error('taskkill denied');
    },
  }, cleanupConfiguration);

  await assert.rejects(launch, /cleanup incomplete/);
  assert.deepEqual(taskkillPids, [child.pid]);
  assert.deepEqual(child.killCalls, [undefined]);
  assert.equal(calls.terminateProcess, undefined);

  const whileAlive = createOptions(new FakeFileSystem(), new FakeProcess(), {}, cleanupConfiguration);
  await assert.rejects(whileAlive.launch, /already using this profile/);
  child.emit('exit', 1, null);

  const afterRootExit = createOptions(new FakeFileSystem(), new FakeProcess(), {}, cleanupConfiguration);
  await assert.rejects(afterRootExit.launch, /already using this profile/);
});

test('cleans up when connection verification fails', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const browserMock = createBrowserMock({ isConnected: () => false });
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    connect: async () => browserMock.browser as never,
    terminate: async () => undefined,
  });

  await assert.rejects(launch, /reports the browser disconnected/);
  assert.equal(calls.terminateProcess, child);
});

test('a stale endpoint without new data times out rather than connecting to another browser', async () => {
  const fileSystem = new FakeFileSystem();
  fileSystem.markerContent = '41111\n/devtools/browser/old-endpoint\n';
  fileSystem.markerMtime = 1;
  const child = new FakeProcess();
  let connectionAttempted = false;
  const { launch, calls } = createOptions(fileSystem, child, {
    startupTimeoutMs: 20,
    connect: async () => {
      connectionAttempted = true;
      return createBrowserMock().browser as never;
    },
    terminate: async () => undefined,
  });

  await assert.rejects(launch, /Timed out waiting for the browser CDP endpoint/);
  assert.equal(connectionAttempted, false);
  assert.equal(calls.terminateProcess, child);
});

test('unsupported platform fails before creating profile or spawning a process', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  let spawned = false;
  await assert.rejects(
    launchConfiguredBrowser(configuration, {
      platform: 'linux',
      fileSystem,
      spawnProcess: () => {
        spawned = true;
        return child;
      },
    }),
    /not supported/,
  );
  assert.deepEqual(fileSystem.directories, []);
  assert.equal(spawned, false);
});

test('disconnect is idempotent and never invokes process-tree cleanup', async () => {
  const fileSystem = new FakeFileSystem();
  const child = new FakeProcess();
  const browserMock = createBrowserMock();
  const { launch, calls } = createOptions(fileSystem, child, {
    onSpawn: () => writeEndpoint(fileSystem),
    connect: async () => browserMock.browser as never,
    terminate: async () => undefined,
  });

  const session = await launch;
  await session.disconnect();
  await session.disconnect();
  assert.equal(browserMock.calls.close, 1);
  assert.equal(calls.terminateProcess, undefined);
  assert.equal(child.killCalls.length, 0);
  child.emit('exit', 0, null);
});

