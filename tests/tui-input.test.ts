import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TerminalInputParser,
  type TerminalInputEvent,
} from '../src/tui/input.js';

function createParser(escapeTimeoutMs = 5): {
  events: TerminalInputEvent[];
  parser: TerminalInputParser;
} {
  const events: TerminalInputEvent[] = [];
  const parser = new TerminalInputParser(event => events.push(event), {
    escapeTimeoutMs,
  });
  return { events, parser };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

test('streaming input reassembles escape sequences split across chunks', () => {
  const { events, parser } = createParser();
  try {
    parser.feed('\u001b[');
    parser.feed('5~');
    parser.feed('\u001b');
    parser.feed('[6~');
    parser.feed('\u001b[1;5');
    parser.feed('H');
    parser.feed('\u001b[4');
    parser.feed('~');

    assert.deepEqual(events, [
      { type: 'key', key: 'pageUp' },
      { type: 'key', key: 'pageDown' },
      { type: 'key', key: 'home' },
      { type: 'key', key: 'end' },
    ]);
  } finally {
    parser.dispose();
  }
});

test('application cursor sequences are parsed across every split point', () => {
  for (const chunks of [
    ['\u001b', 'O', 'H'],
    ['\u001bO', 'H'],
    ['\u001b', 'OA'],
    ['\u001b', 'O', 'B'],
  ]) {
    const { events, parser } = createParser();
    try {
      for (const chunk of chunks) {
        parser.feed(chunk);
      }
    } finally {
      parser.dispose();
    }
    assert.equal(events.length, 1, chunks.join('|'));
    assert.equal(events[0]?.type, 'key', chunks.join('|'));
  }
});

test('control keys and printable text are separated', () => {
  const { events, parser } = createParser();
  try {
    parser.feed('ab\u0003\r\u007f\u0008\u001b[3~');
  } finally {
    parser.dispose();
  }

  assert.deepEqual(events, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
    { type: 'key', key: 'ctrlC' },
    { type: 'key', key: 'enter' },
    { type: 'key', key: 'backspace' },
    { type: 'key', key: 'backspace' },
    { type: 'key', key: 'delete' },
  ]);
});

test('a lone Escape flushes as Escape without dropping later text', async () => {
  const { events, parser } = createParser(5);
  try {
    parser.feed('\u001b');
    assert.deepEqual(events, []);
    await delay(20);
    assert.deepEqual(events, [{ type: 'key', key: 'escape' }]);

    parser.feed('x');
    assert.deepEqual(events, [
      { type: 'key', key: 'escape' },
      { type: 'text', text: 'x' },
    ]);
  } finally {
    parser.dispose();
  }
});

test('an incomplete escape sequence flushes as Escape without leaking bytes', async () => {
  const { events, parser } = createParser(5);
  try {
    parser.feed('\u001b[5');
    await delay(20);
    assert.deepEqual(events, [{ type: 'key', key: 'escape' }]);
    assert.equal(parser.pending, '');
  } finally {
    parser.dispose();
  }
});

test('disposing the parser cancels a pending escape flush', async () => {
  const { events, parser } = createParser(5);
  parser.feed('\u001b');
  parser.dispose();
  await delay(20);
  assert.deepEqual(events, []);
});
