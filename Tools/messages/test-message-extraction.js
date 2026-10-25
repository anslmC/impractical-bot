const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  classifyMessageLabel,
  extractMessageDetails,
} = require('../components/message-extraction');

test('classifies senders using Backread label data', () => {
  assert.deepEqual(
    classifyMessageLabel('At January 5, 2025, 7:30 PM, Alex Smith: hello'),
    {
      timestamp: {
        original: 'January 5, 2025, 7:30 PM',
        normalized: '2025-01-05T19:30:00',
        resolved: true,
      },
      sender: 'Alex Smith',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At January 5, 2025, 7:31 PM, You: hello'),
    {
      timestamp: {
        original: 'January 5, 2025, 7:31 PM',
        normalized: '2025-01-05T19:31:00',
        resolved: true,
      },
      sender: 'You',
      direction: 'OUTGOING',
    },
  );
});

test('uses rendered text and UNKNOWN classification when label evidence is absent', () => {
  assert.deepEqual(extractMessageDetails({
    messageId: 'unknown-1',
    ariaLabel: null,
    textWithoutSenderHeading: 'Rendered text',
  }), {
    messageId: 'unknown-1',
    message: 'Rendered text',
    sender: 'UNKNOWN',
    direction: 'UNKNOWN',
  });
});