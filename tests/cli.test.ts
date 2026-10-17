import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli.js';

function captureCli(args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = runCli(args, message => output.push(message), message => errors.push(message));
  return { exitCode, output, errors };
}

test('each supported command reports that it is not implemented', () => {
  for (const command of ['init', 'config', 'start', 'stop']) {
    const result = captureCli([command]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [`The ${command} command is not implemented yet.`]);
    assert.deepEqual(result.errors, []);
  }
});

test('help options and no command display usage', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = captureCli(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.output[0], /Usage: impbot <command>/);
    assert.match(result.output[0], /init\s+Initialize impractical-bot/);
    assert.match(result.output[0], /config\s+Configure impractical-bot/);
    assert.match(result.output[0], /start\s+Start impractical-bot/);
    assert.match(result.output[0], /stop\s+Stop impractical-bot/);
    assert.deepEqual(result.errors, []);
  }
});

test('version options read the version from package metadata', () => {
  const packageMetadata = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };

  for (const option of ['--version', '-v']) {
    const result = captureCli([option]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, [packageMetadata.version]);
    assert.deepEqual(result.errors, []);
  }
});

test('unknown commands and unexpected arguments fail with a usage hint', () => {
  for (const args of [['unknown'], ['start', '--force']]) {
    const result = captureCli(args);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.match(result.errors[0], /^Error: /);
    assert.match(result.errors[0], /Usage: impbot <command>/);
  }
});