import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMessageIdentityTracker,
  fingerprintMessageText,
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

test('non-adjacent records are never merged even across namespaces', () => {
  const tracker = createMessageIdentityTracker();
  const { messages, duplicates } = tracker.reconcile([
    { messageId: NUMERIC_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
    { messageId: 'mid.$between', message: 'another message', sender: 'Alex', direction: 'INCOMING' },
    { messageId: MID_ID, message: 'ok', sender: 'You', direction: 'OUTGOING' },
  ]);

  assert.deepEqual(
    messages.map(message => message.messageId),
    [NUMERIC_ID, 'mid.$between', MID_ID],
    'separation in rendered order keeps two identical-looking messages distinct',
  );
  assert.deepEqual(duplicates, []);
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
