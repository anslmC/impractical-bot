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

test('ignores a directly attached Sent delivery status', () => {
  const firstObservation = extractMessageDetails({
    messageId: 'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc',
    ariaLabel: 'At October 18, 2026, 1:15 PM, You: Hahaha!',
    textWithoutSenderHeading: 'Hahaha!',
  });
  const statusObservation = extractMessageDetails({
    messageId: 'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc',
    ariaLabel: 'At October 18, 2026, 1:15 PM, You: Hahaha!Sent',
    textWithoutSenderHeading: 'Hahaha!Sent',
  });

  assert.deepEqual(statusObservation, firstObservation);
  assert.equal(extractMessageDetails({
    messageId: 'fallback-1',
    ariaLabel: null,
    textWithoutSenderHeading: 'Hahaha!Sent',
  }).message, 'Hahaha!');
});

test('ignores a whitespace-separated Sent delivery status', () => {
  const firstObservation = extractMessageDetails({
    messageId: 'mid.$gAAW_kanMS16ns3jGqGhgjN7o1gW1',
    ariaLabel: 'At October 18, 2026, 1:15 PM, You: haha look it up yourself',
    textWithoutSenderHeading: 'haha look it up yourself',
  });
  const statusObservation = extractMessageDetails({
    messageId: 'mid.$gAAW_kanMS16ns3jGqGhgjN7o1gW1',
    ariaLabel: 'At October 18, 2026, 1:15 PM, You: haha look it up yourself Sent',
    textWithoutSenderHeading: 'haha look it up yourself Sent',
  });

  assert.equal(statusObservation.message, 'haha look it up yourself');
  assert.deepEqual(statusObservation, firstObservation);
});

test('ignores a newline-separated Sent delivery status', () => {
  assert.equal(extractMessageDetails({
    messageId: 'newline-status',
    ariaLabel: null,
    textWithoutSenderHeading: 'haha look it up yourself\nSent',
  }).message, 'haha look it up yourself');
});

test('preserves the legitimate phrase "I have Sent"', () => {
  assert.equal(extractMessageDetails({
    messageId: 'legitimate-have-sent',
    ariaLabel: 'At October 18, 2026, 1:15 PM, You: I have Sent',
    textWithoutSenderHeading: 'I have Sent',
  }).message, 'I have Sent');
  assert.equal(extractMessageDetails({
    messageId: 'legitimate-have-sent-fallback',
    ariaLabel: null,
    textWithoutSenderHeading: 'I have Sent',
  }).message, 'I have Sent');
});