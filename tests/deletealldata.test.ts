import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { TerminalPrompt } from '../src/browser/initialization.js';
import { runCli, type CliRuntimeOptions } from '../src/cli.js';
import { CLI_COMMANDS } from '../src/cli-commands.js';
import { formatCliHelp } from '../src/cli-help.js';
import {
  resolveConfigurationPaths,
  type ConfigurationPaths,
} from '../src/config/configuration.js';
import {
  inspectApplicationDataDirectory,
  validateApplicationDataDirectory,
  type ApplicationDataDirectoryOptions,
  type ApplicationDataFileSystem,
} from '../src/data-directory.js';

interface DeleteRunOptions {
  promptResult?: string | null;
  runtime?: CliRuntimeOptions;
  applicationDataOptions?: ApplicationDataDirectoryOptions;
}

interface DeleteRunResult {
  exitCode: number;
  output: string[];
  errors: string[];
  promptCalls: number;
  outputText: string;
  errorText: string;
}

function createTemporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-delete-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createPaths(localAppData: string): ConfigurationPaths {
  const directory = join(localAppData, 'Impractical Bot');
  return {
    directory,
    filePath: join(directory, 'config.json'),
  };
}

function safeApplicationDataOptions(
  overrides: ApplicationDataDirectoryOptions = {},
): ApplicationDataDirectoryOptions {
  return {
    platform: 'win32',
    cwd: join(tmpdir(), 'impractical-bot-safe-cwd'),
    repositoryRoot: join(tmpdir(), 'impractical-bot-safe-repository'),
    installationDirectory: join(tmpdir(), 'impractical-bot-safe-installation'),
    ...overrides,
  };
}

async function runDelete(
  paths: ConfigurationPaths,
  options: DeleteRunOptions = {},
): Promise<DeleteRunResult> {
  const output: string[] = [];
  const errors: string[] = [];
  let promptCalls = 0;
  const prompt: TerminalPrompt = async () => {
    promptCalls += 1;
    return options.promptResult === undefined ? 'DELETE' : options.promptResult;
  };
  const runtime: CliRuntimeOptions = {
    requestRuntimeStatus: async () => ({ status: 'not-running' }),
    resolveConfigurationPaths: () => paths,
    ...options.runtime,
    applicationDataOptions: safeApplicationDataOptions(options.applicationDataOptions),
  };

  const exitCode = await runCli(
    ['deletealldata'],
    message => output.push(message),
    message => errors.push(message),
    undefined,
    prompt,
    undefined,
    runtime,
  );

  return {
    exitCode,
    output,
    errors,
    promptCalls,
    outputText: output.join('\n'),
    errorText: errors.join('\n'),
  };
}

function createMissingFileSystem(remove: () => void): ApplicationDataFileSystem {
  return {
    lstat: () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    realpath: () => {
      throw new Error('realpath must not be called for a missing directory');
    },
    remove,
  };
}

function directoryStats(): Stats {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
  } as unknown as Stats;
}

function symbolicLinkStats(): Stats {
  return {
    isSymbolicLink: () => true,
    isDirectory: () => false,
  } as unknown as Stats;
}

test('deletealldata is registered in the CLI command list and help output', () => {
  const command = CLI_COMMANDS.find(candidate => candidate.name === 'deletealldata');
  assert.ok(command);
  assert.match(command.description, /application data/i);
  assert.match(
    formatCliHelp({ columns: 120, color: false }),
    /deletealldata\s+Delete all local application data/,
  );
});

test('application data paths resolve beneath LOCALAPPDATA using the existing resolver', () => {
  const localAppData = join(tmpdir(), 'impractical-bot-delete-resolution');
  const paths = resolveConfigurationPaths({ LOCALAPPDATA: localAppData }, 'win32');

  assert.deepEqual(paths, {
    directory: join(localAppData, 'Impractical Bot'),
    filePath: join(localAppData, 'Impractical Bot', 'config.json'),
  });
});

test('missing application data directory exits successfully without attempting deletion', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  let removeCalls = 0;

  const result = await runDelete(paths, {
    applicationDataOptions: {
      fileSystem: createMissingFileSystem(() => {
        removeCalls += 1;
      }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.outputText, /Nothing to delete/);
  assert.equal(result.promptCalls, 0);
  assert.equal(removeCalls, 0);
});

test('exact DELETE confirmation removes only the application data directory', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  mkdirSync(paths.directory, { recursive: true });
  mkdirSync(join(paths.directory, 'brave-profile'), { recursive: true });
  writeFileSync(
    paths.filePath,
    JSON.stringify({ version: 1, pin: '123456', note: 'sensitive-config-value' }),
  );
  writeFileSync(join(paths.directory, '.env'), 'NVIDIA_API_KEY=nvapi-secret-value\n');
  writeFileSync(join(paths.directory, 'brave-profile', 'Cookies'), 'session-secret');
  const externalProfile = join(localAppData, 'external-profile');
  mkdirSync(externalProfile, { recursive: true });
  const externalFile = join(externalProfile, 'Cookies');
  writeFileSync(externalFile, 'external-session');

  const result = await runDelete(paths);

  assert.equal(result.exitCode, 0);
  assert.equal(result.promptCalls, 1);
  assert.match(result.outputText, /Target directory: .*Impractical Bot/);
  assert.match(result.outputText, /Deleted application data directory/);
  assert.match(result.outputText, /Externally configured browser profiles.*not deleted/);
  assert.equal(existsSync(paths.directory), false);
  assert.equal(existsSync(externalFile), true);
  assert.doesNotMatch(
    result.outputText,
    /123456|sensitive-config-value|nvapi-secret-value|session-secret|external-session/,
  );
  assert.doesNotMatch(result.errorText, /123456|nvapi-secret-value|session-secret/);
});

test('incorrect confirmations, cancellation, and SIGINT do not delete anything', async context => {
  for (const promptResult of ['delete', 'DELETE ', '', null]) {
    const localAppData = createTemporaryDirectory(context);
    const paths = createPaths(localAppData);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.filePath, '{}');

    const result = await runDelete(paths, { promptResult });

    assert.equal(result.exitCode, 0, `prompt=${String(promptResult)}`);
    assert.equal(result.promptCalls, 1, `prompt=${String(promptResult)}`);
    assert.match(result.outputText, /Deletion cancelled/);
    assert.equal(existsSync(paths.directory), true, `prompt=${String(promptResult)}`);
  }
});

test('a running engine prevents deletion and does not prompt', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  mkdirSync(paths.directory, { recursive: true });

  const result = await runDelete(paths, {
    runtime: {
      requestRuntimeStatus: async () => ({ status: 'running', instanceId: 'engine-instance' }),
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.promptCalls, 0);
  assert.match(result.errorText, /impbot stop/);
  assert.equal(existsSync(paths.directory), true);
});

test('a runtime status error prevents deletion and does not prompt', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  mkdirSync(paths.directory, { recursive: true });

  const result = await runDelete(paths, {
    runtime: {
      requestRuntimeStatus: async () => {
        throw new Error('runtime endpoint unavailable');
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.promptCalls, 0);
  assert.match(result.errorText, /Unable to check whether impractical-bot is running/);
  assert.equal(existsSync(paths.directory), true);
});

test('non-interactive execution refuses to delete', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  mkdirSync(paths.directory, { recursive: true });

  const result = await runDelete(paths, {
    runtime: {
      isInteractive: () => false,
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.promptCalls, 0);
  assert.match(result.errorText, /requires an interactive terminal/);
  assert.equal(existsSync(paths.directory), true);
});

test('invalid basenames, drive roots, cwd, repository, and installation overlaps are rejected', () => {
  const localAppData = join(tmpdir(), 'impractical-bot-delete-safety');
  const target = join(localAppData, 'Impractical Bot');
  const paths = { directory: target, filePath: join(target, 'config.json') };
  const options = safeApplicationDataOptions();

  assert.throws(
    () => validateApplicationDataDirectory(
      { directory: join(localAppData, 'Other Directory'), filePath: join(localAppData, 'Other Directory', 'config.json') },
      options,
    ),
    /not named 'Impractical Bot'/,
  );
  assert.throws(
    () => validateApplicationDataDirectory(
      { directory: 'C:\\', filePath: 'C:\\config.json' },
      options,
    ),
    /drive root/,
  );
  assert.throws(
    () => validateApplicationDataDirectory(
      paths,
      { ...options, cwd: join(target, 'inside') },
    ),
    /current working directory/,
  );
  assert.throws(
    () => validateApplicationDataDirectory(
      paths,
      { ...options, repositoryRoot: join(target, 'src') },
    ),
    /repository/,
  );
  assert.throws(
    () => validateApplicationDataDirectory(
      paths,
      { ...options, installationDirectory: join(target, 'dist') },
    ),
    /installation directory/,
  );
});

test('symbolic link and junction targets are rejected', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  let removeCalls = 0;

  assert.throws(
    () => inspectApplicationDataDirectory(paths, safeApplicationDataOptions({
      fileSystem: {
        lstat: () => symbolicLinkStats(),
        realpath: () => paths.directory,
        remove: () => {
          removeCalls += 1;
        },
      },
    })),
    /symbolic link or junction/,
  );

  const actualDirectory = join(localAppData, 'actual-data');
  mkdirSync(actualDirectory, { recursive: true });
  try {
    symlinkSync(actualDirectory, paths.directory, 'junction');
  } catch {
    return;
  }
  context.after(() => rmSync(paths.directory, { recursive: true, force: true }));

  assert.throws(
    () => inspectApplicationDataDirectory(paths, safeApplicationDataOptions()),
    /symbolic link or junction/,
  );
  assert.equal(removeCalls, 0);
});

test('the target is revalidated immediately before deletion', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  let lstatCalls = 0;
  let removeCalls = 0;

  const result = await runDelete(paths, {
    applicationDataOptions: {
      fileSystem: {
        lstat: () => {
          lstatCalls += 1;
          return lstatCalls === 1 ? directoryStats() : symbolicLinkStats();
        },
        realpath: () => paths.directory,
        remove: () => {
          removeCalls += 1;
        },
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.errorText, /symbolic link or junction/);
  assert.equal(removeCalls, 0);
});

test('deletion failures report an error and never report success', async context => {
  const localAppData = createTemporaryDirectory(context);
  const paths = createPaths(localAppData);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.filePath, '{}');

  const result = await runDelete(paths, {
    applicationDataOptions: {
      fileSystem: {
        lstat: path => lstatSync(path),
        realpath: path => realpathSync(path),
        remove: () => {
          throw Object.assign(new Error('file is locked'), { code: 'EBUSY' });
        },
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.errorText, /Unable to delete the application data directory/);
  assert.match(result.errorText, /may have been partially deleted/);
  assert.doesNotMatch(result.outputText, /Deleted application data directory/);
  assert.equal(existsSync(paths.directory), true);
});
