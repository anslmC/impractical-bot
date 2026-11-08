import { lstatSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { isFullyQualifiedWindowsPath } from './browser/browser-definitions.js';
import type { ConfigurationPaths } from './config/configuration.js';

const APPLICATION_DATA_DIRECTORY_NAME = 'Impractical Bot';
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, '../..');

export interface ApplicationDataFileSystem {
  lstat(path: string): Stats;
  realpath(path: string): string;
  remove(path: string): void;
}

export interface ApplicationDataDirectoryOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  repositoryRoot?: string;
  installationDirectory?: string;
  fileSystem?: ApplicationDataFileSystem;
}

export class UnsafeApplicationDataDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeApplicationDataDirectoryError';
  }
}

const defaultFileSystem: ApplicationDataFileSystem = {
  lstat: path => lstatSync(path),
  realpath: path => realpathSync(path),
  remove: path => rmSync(path, {
    recursive: true,
    force: false,
    maxRetries: 5,
    retryDelay: 100,
  }),
};

function normalizeForComparison(value: string): string {
  return win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function isSameOrDescendant(
  ancestor: string,
  candidate: string,
): boolean {
  const normalizedAncestor = normalizeForComparison(ancestor);
  const normalizedCandidate = normalizeForComparison(candidate);
  return normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(`${normalizedAncestor}\\`);
}

function pathsOverlap(first: string, second: string): boolean {
  return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    String((error as NodeJS.ErrnoException).code) === code;
}

export function validateApplicationDataDirectory(
  paths: ConfigurationPaths,
  options: ApplicationDataDirectoryOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new UnsafeApplicationDataDirectoryError(
      'Deleting application data is only supported on Windows.',
    );
  }

  const target = paths.directory;
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    target.includes('\0') ||
    !isFullyQualifiedWindowsPath(target)
  ) {
    throw new UnsafeApplicationDataDirectoryError(
      'The application data directory must be an absolute Windows path.',
    );
  }

  const normalizedTarget = win32.normalize(target);
  if (win32.parse(normalizedTarget).root === normalizedTarget) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete a drive root as the application data directory.',
    );
  }
  if (win32.basename(normalizedTarget) !== APPLICATION_DATA_DIRECTORY_NAME) {
    throw new UnsafeApplicationDataDirectoryError(
      `Refusing to delete a directory that is not named '${APPLICATION_DATA_DIRECTORY_NAME}'.`,
    );
  }

  const parent = win32.dirname(normalizedTarget);
  if (
    !isFullyQualifiedWindowsPath(parent) ||
    win32.parse(parent).root === parent
  ) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete an application data directory without a safe parent directory.',
    );
  }

  const cwd = options.cwd ?? process.cwd();
  if (isSameOrDescendant(normalizedTarget, cwd)) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete the application data directory because it is the current working ' +
      'directory or one of its parents.',
    );
  }

  const repositoryRoot = options.repositoryRoot ?? DEFAULT_PACKAGE_ROOT;
  if (pathsOverlap(normalizedTarget, repositoryRoot)) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete the application data directory because it overlaps the repository.',
    );
  }

  const installationDirectory = options.installationDirectory ?? DEFAULT_PACKAGE_ROOT;
  if (pathsOverlap(normalizedTarget, installationDirectory)) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete the application data directory because it overlaps the installation ' +
      'directory.',
    );
  }
}

export type ApplicationDataDirectoryState = 'missing' | 'directory';

export function inspectApplicationDataDirectory(
  paths: ConfigurationPaths,
  options: ApplicationDataDirectoryOptions = {},
): ApplicationDataDirectoryState {
  validateApplicationDataDirectory(paths, options);

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const normalizedTarget = win32.normalize(paths.directory);
  let stats: Stats;
  try {
    stats = fileSystem.lstat(normalizedTarget);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete an application data directory that is a symbolic link or junction.',
    );
  }
  if (!stats.isDirectory()) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete an application data directory that is not a directory.',
    );
  }

  const resolvedTarget = fileSystem.realpath(normalizedTarget);
  const expectedParent = win32.dirname(normalizedTarget);
  if (
    normalizeForComparison(win32.dirname(resolvedTarget)) !==
      normalizeForComparison(expectedParent) ||
    normalizeForComparison(win32.basename(resolvedTarget)) !==
      normalizeForComparison(APPLICATION_DATA_DIRECTORY_NAME)
  ) {
    throw new UnsafeApplicationDataDirectoryError(
      'Refusing to delete an application data directory that resolves outside its expected ' +
      'location.',
    );
  }

  return 'directory';
}

export function deleteApplicationDataDirectory(
  paths: ConfigurationPaths,
  options: ApplicationDataDirectoryOptions = {},
): ApplicationDataDirectoryState {
  const state = inspectApplicationDataDirectory(paths, options);
  if (state === 'missing') {
    return state;
  }

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  fileSystem.remove(win32.normalize(paths.directory));
  return state;
}
