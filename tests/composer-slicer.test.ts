import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceComposerMessage } from '../src/components/composer-slicer.js';

const FAMILY_EMOJI = '👨‍👩‍👧‍👦';
const GRINNING_FACE = '😀';
const COMBINING_E_ACUTE = 'e\u0301';

function assertSlicingInvariants(text: string, maxCharacters: number): string[] {
  const chunks = sliceComposerMessage(text, maxCharacters);
  assert.ok(chunks.length > 0, 'a non-empty input produces at least one chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no chunk is empty');
    assert.ok(
      chunk.length <= maxCharacters,
      `chunk of ${String(chunk.length)} characters exceeds ${String(maxCharacters)}`,
    );
  }
  assert.equal(chunks.join(''), text, 'concatenating the chunks reproduces the input');
  return chunks;
}

function assertNoLoneSurrogates(chunks: readonly string[]): void {
  for (const chunk of chunks) {
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(chunk),
      false,
      'no chunk ends with a lone high surrogate',
    );
    assert.equal(
      /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk),
      false,
      'no chunk starts with a lone low surrogate',
    );
  }
}

test('empty input produces no chunks', () => {
  assert.deepEqual(sliceComposerMessage('', 100), []);
  assert.deepEqual(sliceComposerMessage('', 1), []);
});

test('input shorter than the threshold is returned unchanged', () => {
  const text = 'A short reply.';
  assert.deepEqual(sliceComposerMessage(text, 100), [text]);
});

test('input exactly at the threshold stays a single message', () => {
  const text = 'word '.repeat(20).trimEnd();
  assert.equal(text.length, 99);
  assert.deepEqual(sliceComposerMessage(text, text.length), [text]);
  assert.deepEqual(sliceComposerMessage(text, text.length + 1), [text]);
});

test('input one character above the threshold is sliced', () => {
  const text = 'word '.repeat(100) + 'x';
  assert.equal(text.length, 501);
  const chunks = assertSlicingInvariants(text, 500);
  assert.equal(chunks.length, 2);
});

test('a maximum of one splits every code unit', () => {
  const text = 'abc de';
  const chunks = assertSlicingInvariants(text, 1);
  assert.deepEqual(chunks, ['a', 'b', 'c', ' ', 'd', 'e']);
});

test('a maximum of two keeps whole graphemes when they fit', () => {
  const text = `${GRINNING_FACE.repeat(4)}${COMBINING_E_ACUTE.repeat(2)}`;
  const chunks = assertSlicingInvariants(text, 2);
  assert.deepEqual(chunks, [
    GRINNING_FACE,
    GRINNING_FACE,
    GRINNING_FACE,
    GRINNING_FACE,
    COMBINING_E_ACUTE,
    COMBINING_E_ACUTE,
  ]);
  assertNoLoneSurrogates(chunks);
});

test('a maximum of ten slices a 291 character response into ordered bubbles', () => {
  const text = ('One long generated response must arrive as several consecutive bubbles. ')
    .repeat(5)
    .slice(0, 291);
  assert.equal(text.length, 291);
  const chunks = assertSlicingInvariants(text, 10);
  assert.ok(chunks.length >= 29);
  assert.equal(chunks[0], 'One long ');
  assert.equal(chunks[1], 'generated ');
});

test('a maximum of five hundred keeps a long response readable', () => {
  const paragraph = 'This is a super large message that needs to be divided into smaller ' +
    'consecutive messages, because one enormous Messenger bubble is difficult to read. ' +
    'Slicing must stay deterministic and lossless. ';
  const text = paragraph.repeat(40).trimEnd();
  const chunks = assertSlicingInvariants(text, 500);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.length > 250));
});

test('sentence boundaries are preferred over mid-sentence word boundaries', () => {
  const text = 'One sentence here. Two sentence there. Three final one.';
  const chunks = assertSlicingInvariants(text, 45);
  assert.deepEqual(chunks, [
    'One sentence here. Two sentence there. ',
    'Three final one.',
  ]);
});

test('paragraph boundaries are preferred over sentence boundaries', () => {
  const firstParagraph = `${'A'.repeat(100)}.`;
  const secondParagraph = `${'B'.repeat(100)}.`;
  const text = `${firstParagraph}\n\n${secondParagraph}`;
  const chunks = assertSlicingInvariants(text, 120);
  assert.deepEqual(chunks, [`${firstParagraph}\n\n`, secondParagraph]);
});

test('punctuation boundaries are used when no sentence boundary fits', () => {
  const text = 'First clause here, second clause follows';
  const chunks = assertSlicingInvariants(text, 25);
  assert.deepEqual(chunks, ['First clause here, ', 'second clause follows']);
});

test('word boundaries are used when no punctuation boundary fits', () => {
  const text = 'alpha beta gamma delta epsilon';
  const chunks = assertSlicingInvariants(text, 15);
  assert.deepEqual(chunks, ['alpha beta ', 'gamma delta ', 'epsilon']);
});

test('repeated punctuation and blank lines are preserved', () => {
  const text = 'Wait...\n\nWhat?! Really???\n\nOkay: then; fine.';
  const chunks = assertSlicingInvariants(text, 8);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.some(chunk => chunk.includes('\n\n')));
});

test('a long unbroken word is split at the strict character limit', () => {
  const text = 'x'.repeat(1000);
  const chunks = assertSlicingInvariants(text, 80);
  assert.equal(chunks.length, 13);
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.length === 80));
});

test('a very long word between natural boundaries is split safely', () => {
  const text = `Short. ${'y'.repeat(60)} end.`;
  const chunks = assertSlicingInvariants(text, 30);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0], 'Short. ');
});

test('unicode grapheme clusters are never split by a natural boundary', () => {
  const text = FAMILY_EMOJI.repeat(10);
  assert.equal(text.length, 110);
  const chunks = assertSlicingInvariants(text, 24);
  assert.deepEqual(chunks, Array.from({ length: 5 }, () => FAMILY_EMOJI.repeat(2)));
  assertNoLoneSurrogates(chunks);
});

test('a strict limit smaller than one grapheme still terminates and never oversizes', () => {
  const chunks = assertSlicingInvariants(GRINNING_FACE.repeat(3), 1);
  assert.equal(chunks.length, 6);
  assert.ok(chunks.every(chunk => chunk.length === 1));
});

test('whitespace and punctuation are preserved exactly', () => {
  const text = '  Leading space. Tab\there.  \n\n  New paragraph!  Trailing   ';
  const chunks = assertSlicingInvariants(text, 20);
  assert.ok(chunks.length > 1);
});

test('a tiny tail is rebalanced onto a nearby earlier boundary', () => {
  const text = 'word '.repeat(9);
  assert.equal(text.length, 45);
  const chunks = assertSlicingInvariants(text, 40);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].length, 10);
});

test('very long responses keep every invariant', () => {
  const paragraph = 'This is a super large message that needs to be divided into smaller ' +
    'consecutive messages, because one enormous Messenger bubble is difficult to read. ' +
    'Slicing must stay deterministic and lossless. ';
  const text = paragraph.repeat(300);
  assert.ok(text.length > 50_000);
  const chunks = assertSlicingInvariants(text, 500);
  assert.ok(chunks.length > 100);
});

test('every maximum keeps the invariants across pathological inputs', () => {
  const inputs = [
    'a',
    '...',
    '\n\n\n',
    '     ',
    '😀',
    FAMILY_EMOJI,
    COMBINING_E_ACUTE,
    'word '.repeat(50),
    'NoNaturalBoundariesAtAll'.repeat(20),
    'Mixed\n\nparagraphs. With... punctuation?! And commas, semicolons; dashes — here. '.repeat(5),
  ];
  for (const maxCharacters of [1, 2, 3, 4, 7, 10, 13, 50, 100, 500]) {
    for (const text of inputs) {
      assertSlicingInvariants(text, maxCharacters);
    }
  }
});

test('slicing is deterministic', () => {
  const text = 'One sentence here. Two sentence there. Three final one.';
  assert.deepEqual(
    sliceComposerMessage(text, 20),
    sliceComposerMessage(text, 20),
  );
});

test('malformed maximums are rejected', () => {
  for (const maxCharacters of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => sliceComposerMessage('Some text', maxCharacters),
      RangeError,
    );
  }
});
