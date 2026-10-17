import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import {
  launchConfiguredBrowser,
  type BrowserLaunchFileSystem,
  type BrowserProcessHandle,
} from '../src/browser/launch.js';
import type { Configuration } from '../src/config/configuration.js';

const baseConfiguration: Configuration = {
  version: 1,
  browser: 'brave',
  executablePath: 'C:\\Browsers\\Brave\\brave.exe',
  profilePath: 'C:\\Users\\test\\AppData\\Local\\Impractical Bot\\browser-profile',
  cdpPort: 49271,
  startupUrl: 'https://www.facebook.com',
};

class FakeProcess implements BrowserProcessHandle {
  readonly pid = 12345;
  exited = false;
  unrefCalls = 0;
  private readonly listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  once(event: 'error' | 'exit', listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): this {
    if (event === 'exit') {
      this.listeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    return this;
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exited = true;
    for (const listener of this.listeners) {
      listener(code, signal);
    }
  }
}

class FakeFileSystem implements BrowserLaunchFileSystem {
  readonly directories: string[] = [];

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function createCdpServer(): { server: Server; start(port: number): Promise<void> } {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/test-session`,
    }));
  });
  return {
    server,
    start: port => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }),
  };
}

function browserMock() {
  const calls = { close: 0, version: 0 };
  let connected = true;
  return {
    calls,
    browser: {
      isConnected: () => connected,
      async version() {
        calls.version += 1;
        return 'Brave Chromium test';
      },
      async close() {
        calls.close += 1;
        connected = false;
      },
    },
  };
}

test('launches configured browser, connects to its configured port, then disconnects Playwright only', async t => {
  const port = await getAvailablePort();
  const config = { ...baseConfiguration, cdpPort: port };
  const { server, start } = createCdpServer();
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const child = new FakeProcess();
  const fileSystem = new FakeFileSystem();
  const browser = browserMock();
  let args: string[] = [];
  let connectEndpoint = '';
  let processScans = 0;
  const session = await launchConfiguredBrowser(config, {
    platform: 'win32',
    fileSystem,
    findProfileProcesses: async () => {
      processScans += 1;
      return processScans === 1 ? [] : [child.pid];
    },
    spawnProcess: (executablePath, launchArgs, options) => {
      assert.equal(executablePath, config.executablePath);
      assert.equal(options.detached, true);
      args = launchArgs;
      void start(port);
      return child;
    },
    connectOverCDP: async endpoint => {
      connectEndpoint = endpoint;
      return browser.browser as never;
    },
  });

  assert.deepEqual(fileSystem.directories, [config.profilePath]);
  assert.deepEqual(args, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profilePath}`,
    config.startupUrl,
  ]);
  assert.equal(connectEndpoint, `ws://127.0.0.1:${port}/devtools/browser/test-session`);
  assert.equal(child.unrefCalls, 1);
  assert.equal(browser.calls.version, 1);

  await session.disconnect();
  await session.disconnect();
  assert.equal(browser.calls.close, 1);
  assert.equal(server.listening, true);
  assert.equal(child.exited, false);
});

test('refuses to launch when the configured profile is already in use', async () => {
  const child = new FakeProcess();
  let spawned = false;
  await assert.rejects(launchConfiguredBrowser(baseConfiguration, {
    platform: 'win32',
    findProfileProcesses: async () => [9876],
    spawnProcess: () => {
      spawned = true;
      return child;
    },
  }), /already use the configured profile/);
  assert.equal(spawned, false);
});

test('refuses an occupied CDP port rather than connecting to its listener', async t => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  let spawned = false;
  await assert.rejects(launchConfiguredBrowser({ ...baseConfiguration, cdpPort: address.port }, {
    platform: 'win32',
    findProfileProcesses: async () => [],
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
  }), /already in use; refusing to attach/);
  assert.equal(spawned, false);
});

test('reports an early browser process exit without terminating its process tree', async () => {
  const port = await getAvailablePort();
  const child = new FakeProcess();
  await assert.rejects(launchConfiguredBrowser({ ...baseConfiguration, cdpPort: port }, {
    platform: 'win32',
    startupTimeoutMs: 50,
    pollIntervalMs: 5,
    fileSystem: new FakeFileSystem(),
    findProfileProcesses: async () => [],
    spawnProcess: () => {
      queueMicrotask(() => child.exit(2));
      return child;
    },
  }), /exited before its CDP endpoint became ready/);
});

test('unsupported platform fails before creating the profile or spawning a process', async () => {
  const fileSystem = new FakeFileSystem();
  let spawned = false;
  await assert.rejects(launchConfiguredBrowser(baseConfiguration, {
    platform: 'linux',
    fileSystem,
    spawnProcess: () => {
      spawned = true;
      return new FakeProcess();
    },
  }), /not supported/);
  assert.deepEqual(fileSystem.directories, []);
  assert.equal(spawned, false);
});
