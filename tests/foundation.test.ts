import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Node.js runtime meets the project minimum', () => {
  const [majorVersion, minorVersion] = process.versions.node.split('.').map(Number);

  assert.ok(
    majorVersion > 22 || (majorVersion === 22 && minorVersion >= 13),
    `Expected Node.js 22.13 or newer, got ${process.versions.node}`,
  );
});