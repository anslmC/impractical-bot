import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MESSAGE_TARGETING_INSTRUCTION_MARKER,
  appendMessageTargetingInstruction,
  buildMessageTargetingInstruction,
  classifyMessageTargeting,
  isRelayStillNeeded,
  mentionsParticipant,
  relayWasDelivered,
  type TargetingMessage,
} from '../src/components/message-targeting.js';
import { buildParticipantAwareness } from '../src/components/participant-awareness.js';
import { buildPacketTurn, createPacketBuilderState } from '../src/components/mention-packet-builder.js';
import { buildRngPacket } from '../src/components/rng-packet-builder.js';
import { stripGenericTrailingQuestions } from '../src/components/reply-normalization.js';

const awareness = buildParticipantAwareness({
  bot: { name: 'Yukinon', aliases: ['@Yukinon'] },
  messages: [
    { sender: 'Katsuyo', direction: 'INCOMING' },
    { sender: 'Anselmo', direction: 'INCOMING' },
    { sender: 'Blair', direction: 'INCOMING' },
  ],
});

function classify(
  message: string,
  sender = 'Katsuyo',
  recentMessages: readonly TargetingMessage[] = [],
) {
  return classifyMessageTargeting({
    message: { messageId: 'current', message, sender, direction: 'INCOMING' },
    awareness,
    recentMessages,
  });
}

test('participant awareness merges observed and roster names without the bot', () => {
  const merged = buildParticipantAwareness({
    bot: { name: 'Yukinon', aliases: ['@Yukinon'] },
    roster: {
      status: 'complete',
      members: [
        { firstName: 'Yukinon', isPuppet: true },
        { firstName: 'Anselmo', isPuppet: false },
        { firstName: 'Blair', isPuppet: false },
      ],
      puppet: { firstName: 'Yukinon', isPuppet: true },
      duplicateFirstNames: [],
    },
    messages: [
      { sender: 'Anselmo', direction: 'INCOMING' },
      { sender: 'Blair', direction: 'INCOMING' },
      { sender: 'Yukinon', direction: 'OUTGOING' },
    ],
  });

  assert.deepEqual(merged.canonicalNames, ['Anselmo', 'Blair']);
  assert.equal(merged.participantNames.includes('Yukinon'), false);
});

test('a bare bot name at the start is a direct address', () => {
  assert.equal(classify('Yukinon are you good?').kind, 'bot');
  assert.equal(classify('Yukinon?').kind, 'bot');
  assert.equal(classify('Hey Yukinon!').kind, 'bot');
});

test('a third-person bot mention is not treated as a direct address', () => {
  assert.equal(classify('Yukinon is not here.').kind, 'none');
});

test('self-identification does not become an address to the named participant', () => {
  const context = classify('I am Anselmo.');
  assert.equal(context.kind, 'self-identification');
  assert.deepEqual(context.mentionedParticipants, ['Anselmo']);
  assert.equal(context.relay, null);
});

test('second-person identity statements follow the recent addressee', () => {
  const aboutBot = classify('You are not Anselmo.', 'Blair', [
    { sender: 'Anselmo', direction: 'INCOMING', message: 'I am Anselmo.' },
  ]);
  assert.equal(aboutBot.kind, 'bot');

  const toAnselmo = classify('You are not Anselmo.', 'Blair', [
    { sender: 'Katsuyo', direction: 'INCOMING', message: 'Anselmo!' },
  ]);
  assert.equal(toAnselmo.kind, 'participant');
  assert.equal(toAnselmo.addressedTo, 'Anselmo');
});

test('a direct call or question to a participant creates a relay', () => {
  for (const message of ['Hey Anselmo!', 'Anselmo?', 'Anselmo, have you seen this?']) {
    const context = classify(message);
    assert.equal(context.kind, 'participant', message);
    assert.equal(context.addressedTo, 'Anselmo', message);
    assert.equal(context.relay?.sender, 'Katsuyo', message);
    assert.equal(context.relay?.recipient, 'Anselmo', message);
  }
});

test('an indirect request to tell a participant creates a relay', () => {
  const context = classify('Can you tell Anselmo I said hi?');
  assert.equal(context.kind, 'bot');
  assert.equal(context.relay?.sender, 'Katsuyo');
  assert.equal(context.relay?.recipient, 'Anselmo');
});

test('statements about a participant do not create relays', () => {
  for (const message of [
    'Anselmo is late again.',
    'Anselmo is funny.',
    'I was talking to Anselmo.',
    'Have you seen Anselmo?',
  ]) {
    const context = classify(message);
    assert.notEqual(context.kind, 'participant', message);
    assert.equal(context.relay, null, message);
  }
});

test('a third-person call between participants relays to its recipient', () => {
  const context = classify('Katsuyo is calling Anselmo.');
  assert.equal(context.kind, 'about-participant');
  assert.equal(context.relay?.sender, 'Katsuyo');
  assert.equal(context.relay?.recipient, 'Anselmo');
});

test('group address is recognized without turning it into a participant call', () => {
  assert.equal(classify('Everyone, listen up.').kind, 'group');
  assert.equal(classify('Both of you, stop.').kind, 'group');
});

test('a relay is skipped once the recipient has replied', () => {
  const relay = { sender: 'Katsuyo', recipient: 'Anselmo', sourceMessageId: 'm-1' };
  const messages = [
    { messageId: 'm-1', message: 'Anselmo?', sender: 'Katsuyo', direction: 'INCOMING' },
    { messageId: 'm-2', message: 'Yes?', sender: 'Anselmo', direction: 'INCOMING' },
  ];
  assert.equal(isRelayStillNeeded({ relay, messages }), false);
  assert.equal(isRelayStillNeeded({
    relay,
    messages: messages.slice(0, 1),
  }), true);
});

test('a relay counts as delivered only when it names both people', () => {
  const relay = { sender: 'Katsuyo', recipient: 'Anselmo', sourceMessageId: 'm-1' };
  assert.equal(relayWasDelivered('Anselmo, Katsuyo is calling you.', relay), true);
  assert.equal(relayWasDelivered('Anselmo, check this out.', relay), false);
});

test('targeting instructions explain relay and forbid impersonation', () => {
  const instruction = buildMessageTargetingInstruction(classify('Anselmo?'));
  assert.match(instruction, /explicitly addresses Anselmo/);
  assert.match(instruction, /Relay this call naturally to Anselmo/);
  assert.match(instruction, /do not invent an answer for them/);
});

test('targeting instructions are appended once when no marker exists', () => {
  const context = classify('Anselmo?');
  const instruction = buildMessageTargetingInstruction(context);

  assert.equal(
    appendMessageTargetingInstruction('Base instruction.', context),
    `Base instruction.\n\n${instruction}`,
  );
});

test('a duplicate targeting marker replaces only the first matching section', () => {
  const context = classify('Anselmo?');
  const instruction = buildMessageTargetingInstruction(context);
  const existing = [
    'Base instruction.',
    `${MESSAGE_TARGETING_INSTRUCTION_MARKER} Stale first.`,
    'Unrelated middle section.',
    `  ${MESSAGE_TARGETING_INSTRUCTION_MARKER} Stale second.`,
  ].join('\n\n');

  assert.equal(
    appendMessageTargetingInstruction(existing, context),
    [
      'Base instruction.',
      instruction,
      'Unrelated middle section.',
      `  ${MESSAGE_TARGETING_INSTRUCTION_MARKER} Stale second.`,
    ].join('\n\n'),
  );
});

test('generic trailing questions are removed without removing meaningful questions', () => {
  assert.equal(stripGenericTrailingQuestions('That is fair. What about you?'), 'That is fair.');
  assert.equal(
    stripGenericTrailingQuestions('Cool cool. Anything new going on, or just checking in?'),
    'Cool cool.',
  );
  assert.equal(stripGenericTrailingQuestions('I am fine, what is up?'), 'I am fine');
  assert.equal(stripGenericTrailingQuestions('What is up?'), 'What is up?');
  assert.equal(
    stripGenericTrailingQuestions('I can meet at 7. What time works for you?'),
    'I can meet at 7. What time works for you?',
  );
});

test('a mention packet keeps its original trigger when later messages arrive', () => {
  const first = buildPacketTurn({
    newMessages: [{
      messageId: 'm-1',
      message: 'Yukinon, first?',
      mention: true,
      sender: 'Katsuyo',
      direction: 'INCOMING',
    }],
    state: createPacketBuilderState(),
  });
  assert.equal(first.pendingPacket?.triggerMessageId, 'm-1');

  const second = buildPacketTurn({
    newMessages: [{
      messageId: 'm-2',
      message: 'a later message',
      sender: 'Blair',
      direction: 'INCOMING',
    }],
    state: first.state,
  });
  assert.equal(second.packet?.triggerMessageId, 'm-1');
});

test('an RNG packet records the latest incoming message as its trigger', () => {
  const packet = buildRngPacket([
    { messageId: 'm-1', message: 'first', sender: 'Katsuyo', direction: 'INCOMING' },
    { messageId: 'm-2', message: 'second', sender: 'Blair', direction: 'INCOMING' },
  ]);
  assert.equal(packet.triggerMessageId, 'm-2');
});

test('mentionsParticipant recognizes normalized participant forms without substring matches', () => {
  assert.equal(mentionsParticipant(['Alice Smith'], 'Alice Smith'), true);
  assert.equal(mentionsParticipant(['@Alice Smith'], 'Alice Smith'), true);
  assert.equal(mentionsParticipant(['ALICE'], 'Alice Smith'), true);
  assert.equal(mentionsParticipant(['AliceSmith'], 'Alice Smith'), true);
  assert.equal(mentionsParticipant(['Alicia Smith'], 'Alice Smith'), false);
  assert.equal(mentionsParticipant(['Malice'], 'Alice'), false);
  assert.equal(mentionsParticipant(['AliceInWonderland'], 'Alice'), false);
  assert.equal(mentionsParticipant(['Alice_In'], 'Alice'), false);
  assert.equal(mentionsParticipant(['Bob'], 'Alice'), false);
});

test('duplicate roster names remain one addressable participant while their identity is ambiguous', () => {
  const duplicateAwareness = buildParticipantAwareness({
    bot: { name: 'Yukinon' },
    roster: {
      status: 'partial',
      members: [
        { firstName: 'Sam', isPuppet: false },
        { firstName: 'Sam', isPuppet: false },
      ],
      puppet: null,
      duplicateFirstNames: ['Sam'],
    },
  });

  assert.equal(duplicateAwareness.participants[0]?.ambiguous, true);
  const context = classifyMessageTargeting({
    message: {
      messageId: 'current',
      message: 'Sam?',
      sender: 'Katsuyo',
      direction: 'INCOMING',
    },
    awareness: duplicateAwareness,
  });

  assert.equal(context.kind, 'participant');
  assert.equal(context.addressedTo, 'Sam');
  assert.deepEqual(context.mentionedParticipants, ['Sam']);
  assert.equal(context.relay?.recipient, 'Sam');
});

test('overlapping participant names resolve to the longest matching identity', () => {
  const overlapAwareness = buildParticipantAwareness({
    bot: { name: 'Yukinon' },
    messages: [
      { sender: 'Alice Smith', direction: 'INCOMING' },
      { sender: 'Alice', direction: 'INCOMING' },
    ],
  });

  const long = classifyMessageTargeting({
    message: {
      messageId: 'current',
      message: 'Alice Smith?',
      sender: 'Katsuyo',
      direction: 'INCOMING',
    },
    awareness: overlapAwareness,
  });
  assert.equal(long.kind, 'participant');
  assert.equal(long.addressedTo, 'Alice Smith');
  assert.deepEqual(long.mentionedParticipants, ['Alice Smith']);

  const short = classifyMessageTargeting({
    message: {
      messageId: 'current',
      message: 'Alice?',
      sender: 'Katsuyo',
      direction: 'INCOMING',
    },
    awareness: overlapAwareness,
  });
  assert.equal(short.kind, 'participant');
  assert.equal(short.addressedTo, 'Alice Smith');
});

test('a bot and participant name collision is classified as ambiguous', () => {
  const collisionAwareness = buildParticipantAwareness({
    bot: { name: 'Alice' },
    messages: [{ sender: 'Alice Smith', direction: 'INCOMING' }],
  });

  const context = classifyMessageTargeting({
    message: {
      messageId: 'current',
      message: 'Alice?',
      sender: 'Katsuyo',
      direction: 'INCOMING',
    },
    awareness: collisionAwareness,
  });

  assert.equal(context.kind, 'ambiguous');
  assert.equal(context.addressedTo, null);
  assert.deepEqual(context.mentionedParticipants, []);
  assert.equal(context.relay, null);
});

test('relay delivery still recognizes case-insensitive normalized names', () => {
  const relay = {
    sender: 'Katsuyo',
    recipient: 'Alice Smith',
    sourceMessageId: 'm-1',
  };

  assert.equal(
    relayWasDelivered('alice smith, katsuyo is calling', relay),
    true,
  );
  assert.equal(
    relayWasDelivered('Alicia Smith, Katsuyo is calling', relay),
    false,
  );
});
