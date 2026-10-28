const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildPacketTurn,
  createPacketBuilderState,
} = require('../components/mention-packet-builder');
const { extractMessageDetails } = require('../components/message-extraction');

function message(messageId, text, mention = false) {
  return { messageId, message: text, mention };
}

test('extracts sender and direction from the Backread aria-label format', () => {
  const incoming = extractMessageDetails({
    messageId: 'incoming-1',
    ariaLabel: 'At January 5, 2025, 7:30 PM, Alex Smith: @Bot hello',
    textWithoutSenderHeading: '@Bot hello',
  });
  const outgoing = extractMessageDetails({
    messageId: 'outgoing-1',
    ariaLabel: 'At January 5, 2025, 7:31 PM, You: sent message',
    textWithoutSenderHeading: 'sent message',
  });

  assert.deepEqual(incoming, {
    messageId: 'incoming-1',
    message: '@Bot hello',
    sender: 'Alex Smith',
    direction: 'INCOMING',
  });
  assert.deepEqual(outgoing, {
    messageId: 'outgoing-1',
    message: 'sent message',
    sender: 'You',
    direction: 'OUTGOING',
  });
});

test('preserves sender and direction through new, mention, and context packet messages', () => {
  const mention = {
    ...message('mention-1', '@PleaseGetout', true),
    sender: 'Alex Smith',
    direction: 'INCOMING',
  };
  const context = {
    ...message('context-1', 'Earlier message'),
    sender: 'You',
    direction: 'OUTGOING',
  };
  const followUp = {
    ...message('follow-up-1', 'More details'),
    sender: 'Jordan Lee',
    direction: 'INCOMING',
  };
  const firstPoll = buildPacketTurn({
    newMessages: [mention],
    recentContext: [context],
  });
  const secondPoll = buildPacketTurn({
    newMessages: [followUp],
    state: firstPoll.state,
  });

  assert.deepEqual(secondPoll.packet.newMessages, [mention, followUp]);
  assert.deepEqual(secondPoll.packet.mentionMessages, [mention]);
  assert.deepEqual(secondPoll.packet.contextMessages, [context]);
});

test('returns no packet when there are no new messages', () => {
  const result = buildPacketTurn({ newMessages: [] });

  assert.equal(result.packet, null);
  assert.equal(result.pendingPacket, null);
});

test('records new messages without mentions but does not create a packet', () => {
  const result = buildPacketTurn({
    newMessages: [message('m-1', 'hello'), message('m-2', 'anyone around?')],
  });

  assert.equal(result.packet, null);
  assert.equal(result.pendingPacket, null);
  assert.deepEqual(
    result.state.observedMessages.map(item => item.messageId),
    ['m-1', 'm-2'],
  );
});

test('collects a separate follow-up from the next poll into the mention packet', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [message('mention-90', '@PleaseGetout', true)],
    recentContext: [message('context-2', 'Earlier message')],
  });

  assert.equal(firstPoll.packet, null);
  assert.equal(firstPoll.pendingPacket.packetId, 'packet-001');

  const secondPoll = buildPacketTurn({
    newMessages: [message('follow-up-10', 'bring the tools tomorrow')],
    recentContext: [message('context-2', 'Earlier message')],
    state: firstPoll.state,
  });

  assert.deepEqual(secondPoll.packet.newMessages.map(item => item.messageId), [
    'mention-90', 'follow-up-10',
  ]);
  assert.deepEqual(secondPoll.packet.mentionMessages.map(item => item.messageId), [
    'mention-90',
  ]);
  assert.deepEqual(secondPoll.packet.contextMessages.map(item => item.messageId), [
    'context-2',
  ]);
  assert.equal(secondPoll.pendingPacket, null);
});

test('ignores repeated IDs in overlapping poll snapshots without sorting IDs', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [message('message-90', '@PleaseGetout', true)],
  });
  const secondPoll = buildPacketTurn({
    newMessages: [
      message('message-90', '@PleaseGetout', true),
      message('message-10', 'follow-up'),
    ],
    state: firstPoll.state,
  });

  assert.deepEqual(secondPoll.packet.newMessages.map(item => item.messageId), [
    'message-90', 'message-10',
  ]);
});

test('keeps repeated context available without adding it as new work', () => {
  const context = message('context-1', 'Earlier context');
  const firstPoll = buildPacketTurn({
    newMessages: [],
    recentContext: [context, context],
  });
  const secondPoll = buildPacketTurn({
    newMessages: [message('mention-1', '@PleaseGetout', true), context],
    recentContext: [context],
    state: firstPoll.state,
  });

  assert.deepEqual(secondPoll.pendingPacket.newMessages.map(item => item.messageId), [
    'mention-1',
  ]);
  assert.deepEqual(secondPoll.pendingPacket.contextMessages.map(item => item.messageId), [
    'context-1',
  ]);
});

test('groups multiple mentions in the same collection window', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [message('mention-1', '@PleaseGetout', true)],
  });
  const result = buildPacketTurn({
    newMessages: [
      message('ordinary-1', 'first follow-up'),
      message('mention-2', '@PleaseGetout, also this', true),
    ],
    state: firstPoll.state,
  });

  assert.deepEqual(result.packet.newMessages.map(item => item.messageId), [
    'mention-1', 'ordinary-1', 'mention-2',
  ]);
  assert.deepEqual(result.packet.mentionMessages.map(item => item.messageId), [
    'mention-1', 'mention-2',
  ]);
});

test('does not assign the same message ID to work more than once', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [message('mention-1', '@PleaseGetout', true)],
  });
  const secondPoll = buildPacketTurn({
    newMessages: [
      message('mention-1', '@PleaseGetout', true),
      message('follow-up-1', 'details'),
    ],
    state: firstPoll.state,
  });
  const laterPoll = buildPacketTurn({
    newMessages: [message('follow-up-1', 'details')],
    state: secondPoll.state,
  });

  assert.deepEqual(secondPoll.packet.newMessages.map(item => item.messageId), [
    'mention-1', 'follow-up-1',
  ]);
  assert.equal(laterPoll.packet, null);
  assert.equal(laterPoll.pendingPacket, null);
});

test('rejects conflicting content for a repeated message ID', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [message('same-id', 'original')],
  });

  assert.throws(() => buildPacketTurn({
    newMessages: [message('same-id', 'changed')],
    state: firstPoll.state,
  }), /observed with different content/);
});

test('accepts a delivery-status-only difference once normalized', () => {
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

  const firstPoll = buildPacketTurn({ newMessages: [firstObservation] });
  const repeatedPoll = buildPacketTurn({
    newMessages: [statusObservation],
    state: firstPoll.state,
  });

  assert.equal(repeatedPoll.packet, null);
  assert.deepEqual(
    repeatedPoll.state.observedMessages.map(item => item.message),
    ['haha look it up yourself'],
  );
});

test('does not mutate its input state', () => {
  const state = createPacketBuilderState();
  buildPacketTurn({
    newMessages: [message('mention-1', '@PleaseGetout', true)],
    state,
  });

  assert.deepEqual(state, createPacketBuilderState());
});