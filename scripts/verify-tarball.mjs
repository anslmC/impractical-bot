#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';

const PACKAGE_ROOT = 'package';
const PACKAGE_ROOT_PREFIX = `${PACKAGE_ROOT}/`;
const EXPECTED_FILES_ALLOWLIST = ['dist/src'];
const EXPECTED_BIN_TARGET = 'dist/src/cli.js';
const REQUIRED_FILES = ['package.json', 'README.md', 'LICENSE', EXPECTED_BIN_TARGET];

function fail(message) {
  console.error(`Tarball verification failed: ${message}`);
  process.exit(1);
}

function quote(value) {
  return JSON.stringify(value);
}

function validateArchiveEntry(entry) {
  if (entry.length === 0) {
    return null;
  }

  if (/[\u0000-\u001f\u007f]/.test(entry)) {
    fail(`tarball entry contains a control character: ${quote(entry)}`);
  }

  if (posix.isAbsolute(entry) || win32.isAbsolute(entry)) {
    fail(`tarball entry is an absolute path: ${quote(entry)}`);
  }

  const normalized = entry.replace(/\\/g, '/');
  if (posix.isAbsolute(normalized) || win32.isAbsolute(normalized)) {
    fail(`tarball entry is an absolute path: ${quote(entry)}`);
  }

  if (normalized === PACKAGE_ROOT || normalized === PACKAGE_ROOT_PREFIX) {
    return null;
  }

  if (!normalized.startsWith(PACKAGE_ROOT_PREFIX)) {
    fail(`tarball entry is outside the package root: ${quote(entry)}`);
  }

  const remainder = normalized.slice(PACKAGE_ROOT_PREFIX.length);
  const isDirectory = remainder.endsWith('/');
  const relativePath = isDirectory ? remainder.slice(0, -1) : remainder;

  if (relativePath.length === 0) {
    fail(`tarball entry is malformed: ${quote(entry)}`);
  }

  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail(`tarball entry contains an unsafe path component: ${quote(entry)}`);
    }
    if (segment.includes(':')) {
      fail(`tarball entry contains a Windows-incompatible path component: ${quote(entry)}`);
    }
  }

  return { path: relativePath, isDirectory };
}

const tarballArgument = process.argv[2];
if (!tarballArgument) {
  console.error('Usage: node scripts/verify-tarball.mjs <path-to-tarball>');
  process.exit(2);
}

const tarballPath = resolve(tarballArgument);
if (!existsSync(tarballPath)) {
  fail(`tarball does not exist: ${tarballPath}`);
}

let tarOutput;
try {
  tarOutput = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
} catch (error) {
  fail(`unable to list tarball contents: ${error instanceof Error ? error.message : String(error)}`);
}

const archiveEntries = tarOutput
  .split(/\r?\n/)
  .filter(entry => entry.length > 0);

const files = [];
for (const entry of archiveEntries) {
  const validatedEntry = validateArchiveEntry(entry);
  if (validatedEntry === null || validatedEntry.isDirectory) {
    continue;
  }
  files.push(validatedEntry.path);
}

const allowedFilePatterns = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/src\/.+\.js$/,
];

const unexpectedFiles = files.filter(
  file => !allowedFilePatterns.some(pattern => pattern.test(file)),
);
if (unexpectedFiles.length > 0) {
  fail(
    `unexpected files were packaged:\n${unexpectedFiles.map(file => `  - ${file}`).join('\n')}`,
  );
}

const missingFiles = REQUIRED_FILES.filter(file => !files.includes(file));
if (missingFiles.length > 0) {
  fail(`required files were not packaged:\n${missingFiles.map(file => `  - ${file}`).join('\n')}`);
}

const runtimeFiles = files.filter(file => file.startsWith('dist/src/'));
if (runtimeFiles.length === 0) {
  fail('no runtime files were packaged under dist/src');
}

let manifest;
try {
  manifest = JSON.parse(
    execFileSync('tar', ['-xOzf', tarballPath, `${PACKAGE_ROOT_PREFIX}package.json`], {
      encoding: 'utf8',
    }),
  );
} catch (error) {
  fail(
    `unable to read package.json from the tarball: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  fail('package.json in the tarball is not a JSON object');
}

if (manifest.name !== 'impbot') {
  fail(`expected package name 'impbot', found '${manifest.name}'`);
}

const allowlistMatches = Array.isArray(manifest.files) &&
  manifest.files.length === EXPECTED_FILES_ALLOWLIST.length &&
  manifest.files.every((value, index) => value === EXPECTED_FILES_ALLOWLIST[index]);
if (!allowlistMatches) {
  fail(
    `expected package.json files allowlist to equal exactly ${
      JSON.stringify(EXPECTED_FILES_ALLOWLIST)
    }, found ${JSON.stringify(manifest.files)}`,
  );
}

if (typeof manifest.bin?.impbot !== 'string') {
  fail('package.json is missing a string bin.impbot entry');
}

const normalizedBinTarget = manifest.bin.impbot.replace(/\\/g, '/');
const binTarget = normalizedBinTarget.startsWith('./')
  ? normalizedBinTarget.slice(2)
  : normalizedBinTarget;

if (binTarget !== EXPECTED_BIN_TARGET) {
  fail(
    `expected bin.impbot to resolve to '${EXPECTED_BIN_TARGET}', found '${
      binTarget || '<missing>'
    }'`,
  );
}

if (!files.includes(binTarget)) {
  fail(`bin target was not packaged: ${binTarget}`);
}

console.log(`Verified tarball: ${tarballPath}`);
console.log(`Package: ${manifest.name}@${manifest.version}`);
console.log(`CLI: ${binTarget}`);
console.log(`Packaged files: ${files.length}`);
console.log(`Runtime files under dist/src: ${runtimeFiles.length}`);
