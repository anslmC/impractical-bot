const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getDefaultPersonalityInstruction } = require('../components/personality');

test('default personality instruction preserves the existing NVIDIA system text', () => {
  assert.equal(
    getDefaultPersonalityInstruction(),
    'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
  );
});