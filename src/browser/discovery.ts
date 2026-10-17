import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { BROWSER_IDS, type BrowserId } from '../config/configuration.js';

export interface BrowserCandidate {
  browser: BrowserId;
  displayName: string;
  executablePath: string;
}

export interface BrowserDiscoveryOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  registryLookup?: (browser: BrowserId) => Promise<readonly string[]>;
  pathLookup?: (executableName: string) => Promise<readonly string[]>;
}

interface BrowserDefinition {
  displayName: string;
  executableName: string;
  installationSubpath: string;
}

const BROWSER_DEFINITIONS: Record<BrowserId, BrowserDefinition> = {
  brave: {
    displayName: 'Brave Browser',
    executableName: 'brave.exe',
    installationSubpath: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  },
  chrome: {
    displayName: 'Google Chrome',
    executableName: 'chrome.exe',
    installationSubpath: 'Google\\Chrome\\Application\\chrome.exe',
  },
  edge: {
    displayName: 'Microsoft Edge',
    executableName: 'msedge.exe',
    installationSubpath: 'Microsoft\\Edge\\Application\\msedge.exe',
  },
};

function isFullyQualifiedWindowsPath(value: string): boolean {
  return win32.isAbsolute(value) && win32.parse(value).root !== '\\';
}

function normalizeExecutablePath(value: string): string {
  return win32.normalize(value).replace(/\\+$/, '').toLowerCase();
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function validateBrowserExecutablePath(value: unknown): BrowserCandidate {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    !isFullyQualifiedWindowsPath(value)
  ) {
    throw new Error('Executable path must be a fully qualified Windows path without surrounding whitespace.');
  }

  const executableName = win32.basename(value).toLowerCase();
  const browser = BROWSER_IDS.find(
    browserId => BROWSER_DEFINITIONS[browserId].executableName === executableName,
  );
  if (!browser) {
    throw new Error('Executable must be brave.exe, chrome.exe, or msedge.exe.');
  }

  return {
    browser,
    displayName: BROWSER_DEFINITIONS[browser].displayName,
    executablePath: value,
  };
}

function knownInstallationPaths(
  browser: BrowserId,
  environment: NodeJS.ProcessEnv,
): string[] {
  const definition = BROWSER_DEFINITIONS[browser];
  const roots = [
    environment.LOCALAPPDATA,
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.ProgramW6432,
  ];

  return roots
    .filter((root): root is string => Boolean(root && isFullyQualifiedWindowsPath(root)))
    .map(root => win32.join(root, definition.installationSubpath));
}

function queryRegistry(key: string, view: '/reg:32' | '/reg:64'): Promise<string[]> {
  return new Promise(resolve => {
    execFile(
      'reg.exe',
      ['query', key, '/ve', view],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }

        const match = /^\s*\(Default\)\s+REG_SZ\s+(.+?)\s*$/im.exec(stdout);
        if (!match) {
          resolve([]);
          return;
        }

        const value = match[1].replace(/^"(.*)"$/, '$1');
        resolve([value]);
      },
    );
  });
}

async function lookupWindowsRegistry(browser: BrowserId): Promise<string[]> {
  const executableName = BROWSER_DEFINITIONS[browser].executableName;
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`;
  const hives = ['HKCU', 'HKLM'] as const;
  const views = ['/reg:64', '/reg:32'] as const;
  const paths: string[] = [];

  for (const hive of hives) {
    for (const view of views) {
      paths.push(...await queryRegistry(`${hive}\\${key}`, view));
    }
  }
  return paths;
}

async function lookupPath(environment: NodeJS.ProcessEnv, executableName: string): Promise<string[]> {
  const searchPath = environment.PATH ?? '';
  const candidates = searchPath
    .split(';')
    .map(directory => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(isFullyQualifiedWindowsPath)
    .map(directory => win32.join(directory, executableName));

  return candidates.filter(path => existsSync(path));
}

export async function discoverBrowsers(
  options: BrowserDiscoveryOptions = {},
): Promise<BrowserCandidate[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser discovery is not supported on '${platform}'.`);
  }

  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? isFile;
  const registryLookup = options.registryLookup ?? lookupWindowsRegistry;
  const pathLookup = options.pathLookup ?? ((name: string) => lookupPath(environment, name));
  const candidates: BrowserCandidate[] = [];
  const seenPaths = new Set<string>();

  const addCandidate = (browser: BrowserId, executablePath: string): void => {
    try {
      const candidate = validateBrowserExecutablePath(executablePath);
      if (candidate.browser !== browser || !fileExists(candidate.executablePath)) {
        return;
      }

      const normalizedPath = normalizeExecutablePath(candidate.executablePath);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        candidates.push(candidate);
      }
    } catch {
      return;
    }
  };

  for (const browser of BROWSER_IDS) {
    for (const path of knownInstallationPaths(browser, environment)) {
      addCandidate(browser, path);
    }
  }

  for (const browser of BROWSER_IDS) {
    try {
      for (const path of await registryLookup(browser)) {
        addCandidate(browser, path);
      }
    } catch {
      // Registry failures should not prevent the remaining discovery methods.
    }
  }

  for (const browser of BROWSER_IDS) {
    try {
      const executableName = BROWSER_DEFINITIONS[browser].executableName;
      for (const path of await pathLookup(executableName)) {
        addCandidate(browser, path);
      }
    } catch {
      // PATH failures should not prevent the remaining browsers from being checked.
    }
  }

  return candidates;
}

export function getBrowserDisplayName(browser: BrowserId): string {
  return BROWSER_DEFINITIONS[browser].displayName;
}