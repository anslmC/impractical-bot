import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMessageIdentityTracker,
  fingerprintMessageText,
  formatMessageIdentitySummary,
  formatReconciledEditDiagnostic,
  getMessageIdNamespace,
  isSameLogicalMessage,
} from '../src/components/message-identity.js';

// The ids observed live for one logical outgoing reply: a numeric id and a
// `mid.$...` id, both attached to the same rendered message text.
const NUMERIC_ID = '7521591905785117407';
const MID_ID = 'mid.$gAAW_kanMS16nuYVAE2hiD_y5xnrf';
const REPLY =
  'I literally just said it. Like, one message ago. PleaseGetout Daily. There. I said it again.';

test('message id namespaces are recognized without treating either as authoritative', () => {
  assert.equal(getMessageIdNamespace(NUMERIC_ID), 'numeric');
  assert.equal(getMessageIdNamespace(MID_ID), 'mid');
  assert.equal(getMessageIdNamespace('message-1'), 'other');
  assert.equal(getMessageIdNamespace(''), 'other');
  assert.equal(getMessageIdNamespace('  '), 'other');
});

test('a numeric id and a mid$ id for the same reply are one logical message', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(messages.map(message => message.messageId), [NUMERIC_ID]);
  assert.deepEqual(duplicates, [{
    observedMessageId: MID_ID,
    canonicalMessageId: NUMERIC_ID,
    direction: 'OUTGOING',
    sender: 'You',
    message: REPLY,
  }]);
  assert.equal(fingerprintMessageText(REPLY), fingerprintMessageText(` ${REPLY} `.trim()));
});

test('a merged id stays canonical when only the other copy is rendered later', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  const laterPoll = tracker.reconcile([
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: 'mid.$newer', message: 'next question', sender: 'Alex', direction: 'INCOMING' },
  ]);

  assert.deepEqual(
    laterPoll.messages.map(message => message.messageId),
    [NUMERIC_ID, 'mid.$newer'],
    'the other namespace resolves to the canonical id instead of becoming new work again',
  );
  assert.deepEqual(laterPoll.duplicates, [], 'the merge is reported once, not on every poll');
});

test('an alternate id observed on a later poll merges into the earlier copy', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  const laterPoll = tracker.reconcile([
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(
    laterPoll.messages.map(message => message.messageId),
    [NUMERIC_ID],
    'the server id resolves back to the copy that was already observed',
  );
  assert.deepEqual(laterPoll.duplicates, [{
    observedMessageId: MID_ID,
    canonicalMessageId: NUMERIC_ID,
    direction: 'OUTGOING',
    sender: 'You',
    message: REPLY,
  }]);
});

test('an earlier server id stays canonical when the numeric id appears on a later poll', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  const laterPoll = tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(
    laterPoll.messages.map(message => message.messageId),
    [MID_ID],
    'the first observed copy remains the stable identity for the reply',
  );
  assert.deepEqual(laterPoll.duplicates, [{
    observedMessageId: NUMERIC_ID,
    canonicalMessageId: MID_ID,
    direction: 'OUTGOING',
    sender: 'You',
    message: REPLY,
  }]);
});

test('legitimate consecutive messages with identical text stay distinct', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: 'mid.$a', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
    { messageId: 'mid.$b', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    ['mid.$a', 'mid.$b'],
    'repeated requests in one namespace are separate messages',
  );
  assert.deepEqual(duplicates, []);
  assert.equal(
    isSameLogicalMessage(
      { messageId: 'mid.$a', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
      { messageId: 'mid.$b', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
    ),
    false,
  );
});

test('legitimate repeated text in one namespace stays distinct across polls', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    { messageId: 'mid.$a', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
  ]);

  const laterPoll = tracker.reconcile([
    { messageId: 'mid.$b', message: 'say it again', sender: 'Alex', direction: 'INCOMING' },
  ]);

  assert.deepEqual(
    laterPoll.messages.map(message => message.messageId),
    ['mid.$b'],
    'a same-namespace repeat is not an alternate representation of the earlier message',
  );
  assert.deepEqual(laterPoll.duplicates, []);
});

test('identical text across a sender or direction change is never merged', () => {
  const tracker = createMessageIdentityTracker();
  const { messages } = tracker.reconcile([
    { messageId: NUMERIC_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: 'ok', sender: 'Alex', direction: 'INCOMING' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    [NUMERIC_ID, MID_ID],
  );
  assert.equal(
    isSameLogicalMessage(
      { messageId: NUMERIC_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
      { messageId: MID_ID, message: 'ok', sender: 'Alex', direction: 'OUTGOING' },
    ),
    false,
  );
  assert.equal(
    isSameLogicalMessage(
      { messageId: NUMERIC_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
      { messageId: MID_ID, message: 'ok', sender: 'You', direction: 'INCOMING' },
    ),
    false,
  );
});

test('non-adjacent numeric and mid$ copies are merged as one logical message', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: NUMERIC_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
    { messageId: 'mid.$between', message: 'another message', sender: 'Alex', direction: 'INCOMING' },
    { messageId: MID_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    [NUMERIC_ID, 'mid.$between'],
    'the second namespace resolves to the first rendered copy',
  );
  assert.deepEqual(duplicates, [{
    observedMessageId: MID_ID,
    canonicalMessageId: NUMERIC_ID,
    direction: 'OUTGOING',
    sender: 'You',
    message: 'ok',
  }]);
});

test('non-adjacent identical text in one namespace stays distinct', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: 'mid.$first', message: 'ok', sender: 'Alex', direction: 'INCOMING' },
    { messageId: 'mid.$between', message: 'another message', sender: 'You', direction: 'OUTGOING' },
    { messageId: 'mid.$second', message: 'ok', sender: 'Alex', direction: 'INCOMING' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    ['mid.$first', 'mid.$between', 'mid.$second'],
    'same-namespace repetition is not a duplicate rendering',
  );
  assert.deepEqual(duplicates, []);
});

test('identical text at different observed timestamps stays distinct', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    {
      messageId: NUMERIC_ID,
      message: REPLY,
      sender: 'You',
      direction: 'OUTGOING',
      timestamp: { original: '1:15 PM', normalized: null, resolved: false },
    },
    {
      messageId: MID_ID,
      message: REPLY,
      sender: 'You',
      direction: 'OUTGOING',
      timestamp: { original: '1:16 PM', normalized: null, resolved: false },
    },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    [NUMERIC_ID, MID_ID],
    'different timestamps are evidence of two genuine messages',
  );
  assert.deepEqual(duplicates, []);
});

test('a canonical message accepts only one alternate-id copy', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    {
      messageId: 'mid.$repeat',
      message: REPLY,
      sender: 'You',
      direction: 'OUTGOING',
    },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    [NUMERIC_ID, 'mid.$repeat'],
    'a later identical mid$ message is not assumed to be the same rendering',
  );
  assert.equal(duplicates.length, 1);
});

test('unknown namespaces, empty text and unknown direction are never merged', () => {
  const tracker = createMessageIdentityTracker();
  const { messages } = tracker.reconcile([
    { messageId: 'message-1', message: 'hello', sender: 'You', direction: 'OUTGOING' },
    { messageId: 'message-2', message: 'hello', sender: 'You', direction: 'OUTGOING' },
    { messageId: NUMERIC_ID, message: '   ', sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: '   ', sender: 'You', direction: 'OUTGOING' },
    { messageId: '7521592070141142020', message: 'who', sender: 'UNKNOWN', direction: 'UNKNOWN' },
    { messageId: 'mid.$unknown', message: 'who', sender: 'UNKNOWN', direction: 'UNKNOWN' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    ['message-1', 'message-2', NUMERIC_ID, MID_ID, '7521592070141142020', 'mid.$unknown'],
  );
});

test('clearing the tracker forgets learned aliases for a new conversation', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);
  tracker.clear();

  const afterClear = tracker.reconcile([
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(
    afterClear.messages.map(message => message.messageId),
    [MID_ID],
    'a different conversation starts with its own identity',
  );
});

test('a repeated pair in one snapshot is reported once and never duplicated', () => {
  const tracker = createMessageIdentityTracker();
  const snapshot = [
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ];

  const first = tracker.reconcile(snapshot);
  const second = tracker.reconcile(snapshot);

  assert.deepEqual(first.messages.map(message => message.messageId), [NUMERIC_ID]);
  assert.equal(first.duplicates.length, 1);
  assert.deepEqual(second.messages.map(message => message.messageId), [NUMERIC_ID]);
  assert.deepEqual(second.duplicates, []);
});

const EDIT_SENDER = 'Anselmo';
const EDIT_TIMESTAMP = { original: '1:15 PM', normalized: null, resolved: false };
const EDIT_NEIGHBORS = [
  { messageId: 'neighbor-before', message: 'before', sender: 'Neighbor', direction: 'INCOMING' },
  { messageId: 'neighbor-after', message: 'after', sender: 'Neighbor', direction: 'INCOMING' },
];
const editObservationOptions = (
  count: number,
  timestamp = EDIT_TIMESTAMP,
) => ({ observations: Array.from({ length: count }, () => ({ timestamp })) });
const editedMessage = (
  messageId: string,
  message: string,
  sender = EDIT_SENDER,
) => ({ messageId, message, sender, direction: 'INCOMING' });
const messageSnapshot = (editedId: string, editedText: string) => [
  EDIT_NEIGHBORS[0],
  editedMessage(editedId, editedText),
  EDIT_NEIGHBORS[1],
];

test('a changed physical id with edited text reconciles into one logical message', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('edit-A', 'test'), editObservationOptions(3));

  const result = tracker.reconcile(
    messageSnapshot('edit-B', 'test but edited'),
    editObservationOptions(3),
  );

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'edit-A', 'neighbor-after'],
  );
  assert.equal(result.messages[1].message, 'test but edited');
  assert.deepEqual(result.duplicates, []);
  assert.equal(result.reconciledEdits.length, 1);
  assert.deepEqual(result.reconciledEdits[0], {
    observedMessageId: 'edit-B',
    previousPhysicalMessageId: 'edit-A',
    canonicalMessageId: 'edit-A',
    sender: EDIT_SENDER,
    direction: 'INCOMING',
    matchSignals: [
      'same-sender',
      'same-direction',
      'dom-position',
      'observation-proximity',
      'timestamp-match',
      'stable-neighbors',
    ],
    previousMessage: 'test',
    updatedMessage: 'test but edited',
    confidence: 'stable-neighbors',
  });
  assert.deepEqual(result.diagnostics, {
    candidates: 1,
    reconciled: 1,
    rejected: 0,
    ambiguous: 0,
    invalid: 0,
    duplicatesSuppressed: 0,
  });
});

test('a reconciled replacement stays canonical on later polls without duplicate entries', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('edit-A', 'test'), editObservationOptions(3));
  tracker.reconcile(
    messageSnapshot('edit-B', 'test but edited'),
    editObservationOptions(3),
  );

  const repeated = tracker.reconcile(
    messageSnapshot('edit-B', 'test but edited'),
    editObservationOptions(3),
  );

  assert.deepEqual(
    repeated.messages.map(message => message.messageId),
    ['neighbor-before', 'edit-A', 'neighbor-after'],
  );
  assert.equal(repeated.messages[1].message, 'test but edited');
  assert.deepEqual(repeated.reconciledEdits, []);
  assert.deepEqual(repeated.diagnostics, {
    candidates: 0,
    reconciled: 0,
    rejected: 0,
    ambiguous: 0,
    invalid: 0,
    duplicatesSuppressed: 0,
  });
});

test('stable-id content edits remain in place without changed-id reconciliation', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('stable-edit', 'test'), editObservationOptions(3));

  const result = tracker.reconcile(
    messageSnapshot('stable-edit', 'test but edited'),
    editObservationOptions(3),
  );

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'stable-edit', 'neighbor-after'],
  );
  assert.equal(result.messages[1].message, 'test but edited');
  assert.deepEqual(result.reconciledEdits, []);
  assert.deepEqual(result.diagnostics, {
    candidates: 0,
    reconciled: 0,
    rejected: 0,
    ambiguous: 0,
    invalid: 0,
    duplicatesSuppressed: 0,
  });
});

test('legitimate consecutive same-sender messages remain separate while the earlier message renders', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('consecutive-A', 'first'), editObservationOptions(3));

  const result = tracker.reconcile([
    EDIT_NEIGHBORS[0],
    editedMessage('consecutive-A', 'first'),
    editedMessage('consecutive-B', 'second'),
    EDIT_NEIGHBORS[1],
  ], editObservationOptions(4));

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'consecutive-A', 'consecutive-B', 'neighbor-after'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.equal(result.diagnostics.candidates, 0);
});

test('similar edited text from a different sender never reconciles', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('sender-A', 'test'), editObservationOptions(3));

  const result = tracker.reconcile([
    EDIT_NEIGHBORS[0],
    editedMessage('sender-B', 'test but edited', 'Someone Else'),
    EDIT_NEIGHBORS[1],
  ], editObservationOptions(3));

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'sender-B', 'neighbor-after'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.equal(result.diagnostics.candidates, 0);
});

test('incompatible timestamps reject a changed-id edit candidate', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('timestamp-A', 'test'), editObservationOptions(3));

  const result = tracker.reconcile(
    messageSnapshot('timestamp-B', 'test but edited'),
    editObservationOptions(3, {
      original: '1:16 PM',
      normalized: null,
      resolved: false,
    }),
  );

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'timestamp-B', 'neighbor-after'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.equal(result.diagnostics.candidates, 1);
  assert.equal(result.diagnostics.rejected, 1);
  assert.equal(result.diagnostics.reconciled, 0);
});

test('ambiguous structural evidence prevents changed-id merging', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([
    EDIT_NEIGHBORS[0],
    editedMessage('ambiguous-A', 'alpha'),
    editedMessage('ambiguous-B', 'beta'),
    EDIT_NEIGHBORS[1],
  ], editObservationOptions(4));

  const result = tracker.reconcile([
    EDIT_NEIGHBORS[0],
    editedMessage('ambiguous-C', 'gamma'),
    EDIT_NEIGHBORS[1],
  ], editObservationOptions(3));

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['neighbor-before', 'ambiguous-C', 'neighbor-after'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.equal(result.diagnostics.candidates, 1);
  assert.equal(result.diagnostics.ambiguous, 1);
  assert.equal(result.diagnostics.reconciled, 0);
});

test('missing and malformed ids are skipped without terminating reconciliation', () => {
  const tracker = createMessageIdentityTracker();

  const result = tracker.reconcile([
    editedMessage('', 'missing id'),
    editedMessage('   ', 'blank id'),
    { messageId: 'bad-message', message: 42 as unknown as string, sender: EDIT_SENDER, direction: 'INCOMING' },
    editedMessage('valid-after-invalid', 'still processing'),
  ], editObservationOptions(4));

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['valid-after-invalid'],
  );
  assert.equal(result.diagnostics.invalid, 3);
  assert.deepEqual(result.reconciledEdits, []);
});

test('repeated changed-id replacements flatten aliases instead of forming chains or cycles', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(messageSnapshot('alias-A', 'one'), editObservationOptions(3));
  tracker.reconcile(messageSnapshot('alias-B', 'one edited'), editObservationOptions(3));
  const third = tracker.reconcile(
    messageSnapshot('alias-C', 'one edited again'),
    editObservationOptions(3),
  );
  const fourth = tracker.reconcile(
    messageSnapshot('alias-C', 'one edited again'),
    editObservationOptions(3),
  );

  assert.deepEqual(
    third.messages.map(message => message.messageId),
    ['neighbor-before', 'alias-A', 'neighbor-after'],
  );
  assert.equal(third.reconciledEdits[0].previousPhysicalMessageId, 'alias-B');
  assert.equal(third.reconciledEdits[0].canonicalMessageId, 'alias-A');
  assert.deepEqual(
    fourth.messages.map(message => message.messageId),
    ['neighbor-before', 'alias-A', 'neighbor-after'],
  );
  assert.deepEqual(fourth.reconciledEdits, []);
});

test('duplicate observations are counted as suppressed without affecting identity', () => {
  const tracker = createMessageIdentityTracker();
  const result = tracker.reconcile([
    { messageId: NUMERIC_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
    { messageId: MID_ID, message: REPLY, sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(result.messages.map(message => message.messageId), [NUMERIC_ID]);
  assert.equal(result.diagnostics.duplicatesSuppressed, 1);
});

test('identity diagnostics bound and escape text previews and summarize counters', () => {
  const previousMessage = `old\n"quoted" ${'x'.repeat(200)}`;
  const updatedMessage = `new\n"quoted" ${'y'.repeat(200)}`;
  const line = formatReconciledEditDiagnostic({
    observedMessageId: 'preview-B',
    previousPhysicalMessageId: 'preview-A',
    canonicalMessageId: 'preview-A',
    sender: EDIT_SENDER,
    direction: 'INCOMING',
    matchSignals: ['same-sender', 'stable-neighbors'],
    previousMessage,
    updatedMessage,
    confidence: 'stable-neighbors',
  });

  assert.match(line, /MESSAGE_EDIT_RECONCILED/);
  assert.ok(line.includes('\\n'), 'newlines are escaped');
  assert.ok(!line.includes('\n'), 'the diagnostic stays on one line');
  assert.ok(line.length < 500, 'previews are bounded');
  assert.equal(formatMessageIdentitySummary({
    candidates: 0,
    reconciled: 0,
    rejected: 0,
    ambiguous: 0,
    invalid: 0,
    duplicatesSuppressed: 0,
  }), null);
  assert.equal(formatMessageIdentitySummary({
    candidates: 3,
    reconciled: 1,
    rejected: 1,
    ambiguous: 1,
    invalid: 0,
    duplicatesSuppressed: 2,
  }), 'MESSAGE IDENTITY SUMMARY | candidates=3 reconciled=1 rejected=1 ambiguous=1 invalid=0 duplicates_suppressed=2');
});

test('similar consecutive single-message polls do not reconcile without structural evidence', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile(
    [editedMessage('sequential-1', 'message 1')],
    editObservationOptions(1),
  );

  const result = tracker.reconcile(
    [editedMessage('sequential-2', 'message 2')],
    editObservationOptions(1),
  );

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['sequential-2'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.equal(result.diagnostics.reconciled, 0);
  assert.equal(result.diagnostics.rejected, 1);
});

test('changed-id text reconciliation is skipped when no observation metadata is supplied', () => {
  const tracker = createMessageIdentityTracker();
  tracker.reconcile([editedMessage('unobserved-A', 'test')]);

  const result = tracker.reconcile([editedMessage('unobserved-B', 'test but edited')]);

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['unobserved-B'],
  );
  assert.deepEqual(result.reconciledEdits, []);
  assert.deepEqual(result.diagnostics, {
    candidates: 0,
    reconciled: 0,
    rejected: 0,
    ambiguous: 0,
    invalid: 0,
    duplicatesSuppressed: 0,
  });
});
