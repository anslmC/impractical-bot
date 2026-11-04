import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundedDiagnosticPreview,
  describeTextChange,
  formatGenerationDiagnostic,
} from '../src/components/reply-diagnostics.js';

test('text change diagnostics identify removed prefixes and suffixes', () => {
  assert.deepEqual(
    describeTextChange('Alex: hello', 'hello'),
    { removedPrefix: 'Alex: ', removedSuffix: '' },
  );
  assert.deepEqual(
    describeTextChange('hello. what about you?', 'hello.'),
    { removedPrefix: '', removedSuffix: ' what about you?' },
  );
  assert.deepEqual(
    describeTextChange('Alex: hello. what about you?', 'hello.'),
    {
      removedPrefix: 'Alex: ',
      removedSuffix: ' what about you?',
    },
  );
  assert.deepEqual(
    describeTextChange('unchanged', 'unchanged'),
    { removedPrefix: '', removedSuffix: '' },
  );
});

test('diagnostic previews are escaped and bounded', () => {
  const escaped = boundedDiagnosticPreview('line one\nline two', 40);
  assert.equal(escaped, JSON.stringify('line one\nline two'));

  const bounded = boundedDiagnosticPreview('x'.repeat(500), 20);
  assert.equal(bounded, JSON.stringify(`${'x'.repeat(20)}...`));
  assert.ok(bounded.length < 40);
});

test('generation diagnostics include packet, attempt, size, hash, and preview', () => {
  const line = formatGenerationDiagnostic({
    packetId: 'packet-007',
    packetType: 'mention',
    stage: 'raw',
    attempt: 'first',
    triggerId: 'in-1',
    targetId: 'in-2',
    text: 'hello there',
    outcome: 'accepted',
    reason: 'none',
    fields: ['guard=accepted'],
  });

  assert.match(line, /^\[generation\] packet=packet-007 type=mention stage=raw/u);
  assert.match(line, /attempt=first outcome=accepted reason=none/u);
  assert.match(line, /trigger=in-1 target=in-2/u);
  assert.match(line, /chars=11 hash=[a-f0-9]{12}/u);
  assert.match(line, /preview="hello there" guard=accepted/u);
});
