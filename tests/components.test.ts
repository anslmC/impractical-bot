import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextStore } from '../src/components/context-store.js';
import {
  buildPacketTurn,
  createPacketBuilderState,
} from '../src/components/mention-packet-builder.js';
import { extractMessageDetails } from '../src/components/message-extraction.js';
import {
  PacketStaleError,
  createPacketProcessor,
} from '../src/components/packet-processor.js';
import { createBoundedIdSet } from '../src/components/bounded-id-set.js';
import { createMentionMatcher } from '../src/components/mention-matcher.js';
import { createPacketScheduler } from '../src/components/packet-scheduler.js';
import { createPauseGate } from '../src/components/pause-gate.js';
import { ENGLISH_ONLY_INSTRUCTION } from '../src/components/english-only.js';
import {
  CONVERSATIONAL_INITIATIVE_INSTRUCTION_MARKER,
  MEMORY_HONESTY_INSTRUCTION_MARKER,
  appendConversationalInitiativeInstruction,
  appendGroupRosterInstruction,
  appendMemoryHonestyInstruction,
  composeProductionSystemInstruction,
  composeSystemInstruction,
  getBotIdentityInstruction,
  getConversationalInitiativeInstruction,
  getGroupRosterInstruction,
  getConversationPolicyInstruction,
  getDefaultBehavioralInstruction,
  getDefaultPersonalityInstruction,
  getMemoryHonestyInstruction,
  getOutputGuidanceInstruction,
  getPersonalityInstruction,
} from '../src/components/personality.js';
import { buildRngPacket } from '../src/components/rng-packet-builder.js';
import type { GroupRoster } from '../src/browser/group-roster.js';
import { formatPollSummary, formatTerminalText } from '../src/components/terminal-formatting.js';
import { generateNvidiaReply } from '../src/ai/nvidia.js';

const testIdentity = { name: 'Ada', aliases: ['@Ada'] };

function composeTestPrompt(
  personalityMode: 'default' | 'custom' = 'default',
  customPersonalityInstruction?: string,
): string {
  return composeProductionSystemInstruction({
    identity: testIdentity,
    personalityMode,
    customPersonalityInstruction,
  });
}

test('terminal text formatting respects TTY, NO_COLOR, and TERM=dumb', () => {
  assert.equal(formatTerminalText('poll', 'cyan', { isTTY: false }), 'poll');
  assert.equal(formatTerminalText('poll', 'cyan', { isTTY: true, noColor: true }), 'poll');
  assert.equal(formatTerminalText('poll', 'cyan', { isTTY: true, term: 'dumb' }), 'poll');
  assert.equal(
    formatTerminalText('poll', 'cyan', { isTTY: true, noColor: false, term: 'xterm' }),
    '\u001b[36mpoll\u001b[0m',
  );
});

test('poll summaries keep idle polls visible and emphasize activity', () => {
  assert.equal(
    formatPollSummary(0, 0, { isTTY: false }),
    '  [poll] Poll: 0 new messages checked; 0 mention detected.',
  );
  assert.equal(
    formatPollSummary(2, 1, { isTTY: false }),
    '\n[poll] Poll: 2 new messages checked; 1 mention detected.',
  );
});

test('context store keeps observation order and returns cloned messages', () => {
  const store = createContextStore({ maxMessages: 2 });
  const messages = [
    { messageId: 'm-1', message: 'first', participant: 'other' },
    { messageId: 'm-2', message: 'second', participant: 'bot' },
  ];

  store.add(messages);
  const returned = store.getRecent(2);
  returned[0].message = 'changed';
  store.add([{ messageId: 'm-3', message: 'third' }]);

  assert.deepEqual(store.getState(), {
    maxMessages: 2,
    size: 2,
    messageIds: ['m-2', 'm-3'],
  });
  assert.equal(store.getRecent(2)[0].message, 'second');
});

test('context store retains Backread sender and direction metadata when seeded', () => {
  const backreadMessages = [{
    id: 'incoming-1',
    message: 'Hello',
    sender: 'Alex',
    direction: 'INCOMING',
  }];
  const store = createContextStore();

  store.add(backreadMessages.map(message => ({
    messageId: message.id,
    message: message.message,
    sender: message.sender,
    direction: message.direction,
  })));

  assert.deepEqual(store.getRecent(1), [{
    messageId: 'incoming-1',
    message: 'Hello',
    sender: 'Alex',
    direction: 'INCOMING',
  }]);
});

test('context store clear removes all retained conversation state', () => {
  const store = createContextStore();
  store.add([
    { messageId: 'm-1', message: 'first' },
    { messageId: 'm-2', message: 'second' },
  ]);

  store.clear();

  assert.deepEqual(store.getState().messageIds, []);
  assert.deepEqual(store.getRecent(2), []);
});

test('packet builder holds a mention turn until the next poll', () => {
  const firstTurn = buildPacketTurn({
    newMessages: [{
      messageId: 'm-1', message: '@Bot help', mention: true, direction: 'INCOMING',
    }],
    recentContext: [{ messageId: 'context-1', message: 'Earlier context' }],
  });
  const secondTurn = buildPacketTurn({
    newMessages: [{ messageId: 'm-2', message: 'More details' }],
    state: firstTurn.state,
  });

  assert.equal(firstTurn.packet, null);
  assert.equal(firstTurn.pendingPacket?.packetId, 'packet-001');
  assert.deepEqual(secondTurn.packet?.newMessages.map(message => message.messageId), ['m-1', 'm-2']);
  assert.deepEqual(secondTurn.packet?.mentionMessages.map(message => message.messageId), ['m-1']);
  assert.deepEqual(secondTurn.packet?.contextMessages.map(message => message.messageId), ['context-1']);
});

test('packet builder applies the twenty-message context limit after deduplicating history', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    messageId: `context-${index + 1}`,
    message: `context message ${index + 1}`,
  }));
  const renderedOnly = { messageId: 'rendered-only', message: 'Only in the rendered window' };
  const result = buildPacketTurn({
    newMessages: [{
      messageId: 'in-1', message: '@Bot still on?', mention: true, direction: 'INCOMING',
    }],
    recentContext: [...history, ...history.slice(-6), renderedOnly],
    contextLimit: 20,
  });

  assert.deepEqual(
    result.pendingPacket?.contextMessages.map(message => message.messageId),
    [
      ...history.slice(-19).map(message => message.messageId),
      'rendered-only',
    ],
    'the newest twenty distinct messages survive a rendered/store merge',
  );
  assert.deepEqual(
    result.pendingPacket?.newMessages.map(message => message.messageId),
    ['in-1'],
    'the trigger is new work, not history',
  );
  assert.throws(
    () => buildPacketTurn({ newMessages: [], contextLimit: 0 }),
    /contextLimit must be a positive integer/,
  );
});

test('packet builder opens a mention packet only for INCOMING messages', () => {
  const incoming = buildPacketTurn({
    newMessages: [{
      messageId: 'in-1', message: '@Bot help', mention: true, direction: 'INCOMING',
    }],
  });

  assert.deepEqual(
    incoming.pendingPacket?.mentionMessages.map(message => message.messageId),
    ['in-1'],
  );

  for (const direction of ['OUTGOING', 'UNKNOWN']) {
    const result = buildPacketTurn({
      newMessages: [{
        messageId: `not-a-trigger-${direction}`,
        message: '@Bot help',
        mention: true,
        direction,
      }],
    });

    assert.equal(result.packet, null);
    assert.equal(result.pendingPacket, null);
    assert.deepEqual(
      result.state.observedMessages.map(message => message.messageId),
      [`not-a-trigger-${direction}`],
    );
  }
});

test('packet builder ignores every supported alias format on outgoing messages', () => {
  let state = buildPacketTurn({ newMessages: [] }).state;
  const outgoingAliases = [
    '@PleaseGetout Daily',
    '@PleaseGetoutDaily',
    '@PleaseGetout_Daily',
  ];

  for (const [index, alias] of outgoingAliases.entries()) {
    const result = buildPacketTurn({
      newMessages: [{
        messageId: `out-${index}`,
        message: `${alias}, that's what I meant.`,
        mention: true,
        direction: 'OUTGOING',
      }],
      state,
    });
    state = result.state;
    assert.equal(result.packet, null);
    assert.equal(result.pendingPacket, null);
  }

  assert.deepEqual(
    state.observedMessages.map(message => message.messageId),
    ['out-0', 'out-1', 'out-2'],
  );
});

test('an outgoing alias never joins the mention list of a pending packet', () => {
  const first = buildPacketTurn({
    newMessages: [{
      messageId: 'in-1', message: '@Bot help', mention: true, direction: 'INCOMING',
    }],
  });
  const second = buildPacketTurn({
    newMessages: [{
      messageId: 'out-1',
      message: "@Bot, that's what I meant.",
      mention: true,
      direction: 'OUTGOING',
    }],
    state: first.state,
  });

  assert.equal(second.pendingPacket, null);
  assert.deepEqual(
    second.packet?.newMessages.map(message => message.messageId),
    ['in-1', 'out-1'],
  );
  assert.deepEqual(
    second.packet?.mentionMessages.map(message => message.messageId),
    ['in-1'],
  );
});

test('ordinary incoming messages do not open mention packets', () => {
  const result = buildPacketTurn({
    newMessages: [{ messageId: 'in-ordinary', message: 'just chatting', direction: 'INCOMING' }],
  });

  assert.equal(result.packet, null);
  assert.equal(result.pendingPacket, null);
  assert.deepEqual(
    result.state.observedMessages.map(message => message.messageId),
    ['in-ordinary'],
  );
});

test('message extraction preserves the parsed sender and message body', () => {
  assert.deepEqual(extractMessageDetails({
    messageId: 'incoming-1',
    ariaLabel: 'At January 5, 2025, 7:30 PM, Alex Smith: hello',
    textWithoutSenderHeading: 'hello',
  }), {
    messageId: 'incoming-1',
    message: 'hello',
    sender: 'Alex Smith',
    direction: 'INCOMING',
  });
});

test('message extraction attributes outgoing presentation when the label is unusable', () => {
  assert.deepEqual(extractMessageDetails({
    messageId: 'outgoing-fallback',
    ariaLabel: null,
    textWithoutSenderHeading: "You sent Gg it's borken Seen",
  }), {
    messageId: 'outgoing-fallback',
    message: "Gg it's borken",
    sender: 'You',
    direction: 'OUTGOING',
  });
  assert.deepEqual(extractMessageDetails({
    messageId: 'outgoing-unrecognized-label',
    ariaLabel: 'unrecognized label',
    textWithoutSenderHeading: 'You: hello there',
  }), {
    messageId: 'outgoing-unrecognized-label',
    message: 'hello there',
    sender: 'You',
    direction: 'OUTGOING',
  });
  assert.deepEqual(extractMessageDetails({
    messageId: 'incoming-with-sender',
    ariaLabel: 'At 1:15 PM, Alex: You sent me a file',
    textWithoutSenderHeading: 'You sent me a file',
  }), {
    messageId: 'incoming-with-sender',
    message: 'You sent me a file',
    sender: 'Alex',
    direction: 'INCOMING',
  });
  assert.deepEqual(extractMessageDetails({
    messageId: 'outgoing-without-label',
    ariaLabel: null,
    textWithoutSenderHeading: 'You sent me a file',
  }), {
    messageId: 'outgoing-without-label',
    message: 'me a file',
    sender: 'You',
    direction: 'OUTGOING',
  });
  assert.deepEqual(extractMessageDetails({
    messageId: 'unknown-no-presentation',
    ariaLabel: null,
    textWithoutSenderHeading: 'me a file',
  }), {
    messageId: 'unknown-no-presentation',
    message: 'me a file',
    sender: 'UNKNOWN',
    direction: 'UNKNOWN',
  });
});

test('message extraction ignores a directly attached Sent delivery status', () => {
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
  assert.equal(statusObservation.message, 'Hahaha!');
  assert.equal(extractMessageDetails({
    messageId: 'fallback-1',
    ariaLabel: null,
    textWithoutSenderHeading: 'Hahaha!Sent',
  }).message, 'Hahaha!');
  assert.equal(extractMessageDetails({
    messageId: 'genuine-sent-word',
    ariaLabel: null,
    textWithoutSenderHeading: 'I have Sent',
  }).message, 'I have Sent');
});

test('message extraction ignores a whitespace-separated Sent delivery status', () => {
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

test('message extraction ignores a newline-separated Sent delivery status', () => {
  assert.equal(extractMessageDetails({
    messageId: 'newline-status',
    ariaLabel: null,
    textWithoutSenderHeading: 'haha look it up yourself\nSent',
  }).message, 'haha look it up yourself');
});

test('message extraction preserves the legitimate phrase "I have Sent"', () => {
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

test('message extraction normalizes delivery statuses in every supported format', () => {
  const statuses = ['Sent', 'Delivered', 'Seen', 'Sending'];
  const formats: Array<{ name: string; render: (status: string) => string }> = [
    { name: 'attached', render: status => `Hahaha!${status}` },
    { name: 'whitespace', render: status => `Hahaha! ${status}` },
    { name: 'newline', render: status => `Hahaha!\n${status}` },
    { name: 'trailing line', render: status => `Hahaha!\n· ${status}` },
    { name: 'punctuated', render: status => `Hahaha! — ${status}.` },
  ];

  for (const status of statuses) {
    for (const format of formats) {
      const rendered = format.render(status);
      assert.equal(
        extractMessageDetails({
          messageId: `status-${status}-${format.name}`,
          ariaLabel: `At October 18, 2026, 1:15 PM, You: ${rendered}`,
          textWithoutSenderHeading: `You sent ${rendered}`,
        }).message,
        'Hahaha!',
        `${status} ${format.name}`,
      );
    }
  }
});

test('message extraction preserves legitimate status-like body endings', () => {
  const legitimateBodies = [
    'I have Sent',
    'She has Delivered',
    'They had Seen',
    'He was Sending',
  ];

  for (const body of legitimateBodies) {
    assert.equal(
      extractMessageDetails({
        messageId: `legitimate-${body}`,
        ariaLabel: `At October 18, 2026, 1:15 PM, You: ${body}`,
        textWithoutSenderHeading: `You sent ${body}`,
      }).message,
      body,
    );
  }

  assert.equal(
    extractMessageDetails({
      messageId: 'standalone-status',
      ariaLabel: null,
      textWithoutSenderHeading: 'Seen',
    }).message,
    'Seen',
  );
});

test('accessibility-label and fallback extraction produce identical normalized content', () => {
  const messageId = 'mid.$gAAW_kanMS16nveVCpGhjJ_5kQXYs';
  const clean = extractMessageDetails({
    messageId,
    ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken",
    textWithoutSenderHeading: "You sent Gg it's borken",
  });
  const equivalents = [
    {
      ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken Sent",
      textWithoutSenderHeading: "You sent Gg it's borken Sent",
    },
    {
      ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken Delivered",
      textWithoutSenderHeading: "You sent Gg it's borken Delivered",
    },
    {
      ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken\nSeen",
      textWithoutSenderHeading: "You sent Gg it's borken\nSeen",
    },
    {
      ariaLabel: null,
      textWithoutSenderHeading: "You sent Gg it's borken",
    },
    {
      ariaLabel: null,
      textWithoutSenderHeading: "You sent Gg it's borken Sending",
    },
    {
      ariaLabel: "At October 18, 2026, 1:15 PM, Gg it's borken Delivered",
      textWithoutSenderHeading: "You sent Gg it's borken Delivered",
    },
    {
      ariaLabel: null,
      textWithoutSenderHeading: "You: Gg it's borken Seen",
    },
  ];

  for (const equivalent of equivalents) {
    assert.equal(
      extractMessageDetails({ messageId, ...equivalent }).message,
      clean.message,
      `variant should normalize to the clean body: ${JSON.stringify(equivalent)}`,
    );
  }

  assert.equal(
    extractMessageDetails({
      messageId,
      ariaLabel: 'At October 18, 2026, 1:15 PM, You: You sent me a file',
      textWithoutSenderHeading: 'You sent You sent me a file',
    }).message,
    'You sent me a file',
  );
});

test('message extraction still distinguishes a genuine content edit', () => {
  const first = extractMessageDetails({
    messageId: 'genuine-edit',
    ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken",
    textWithoutSenderHeading: "You sent Gg it's borken",
  });

  assert.notEqual(
    extractMessageDetails({
      messageId: 'genuine-edit',
      ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's fixed",
      textWithoutSenderHeading: "You sent Gg it's fixed",
    }).message,
    first.message,
  );
});

test('packet builder accepts a delivery-status-only difference once normalized', () => {
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
    repeatedPoll.state.observedMessages.map(message => message.message),
    ['haha look it up yourself'],
  );
});

test('packet builder updates an edited message in place without new work', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [{ messageId: 'edited-change', message: 'first content', direction: 'INCOMING' }],
  });
  const editedPoll = buildPacketTurn({
    newMessages: [],
    recentContext: [{ messageId: 'edited-change', message: 'second content', direction: 'INCOMING' }],
    state: firstPoll.state,
  });

  assert.equal(editedPoll.packet, null);
  assert.equal(editedPoll.state.observedMessages.length, 1);
  assert.equal(editedPoll.state.observedMessages[0].message, 'second content');

  const nextPoll = buildPacketTurn({
    newMessages: [{
      messageId: 'edited-change-trigger',
      message: '@Bot hello',
      mention: true,
      direction: 'INCOMING',
    }],
    recentContext: [{ messageId: 'edited-change', message: 'second content', direction: 'INCOMING' }],
    state: editedPoll.state,
  });

  assert.deepEqual(
    nextPoll.pendingPacket?.newMessages.map(message => message.messageId),
    ['edited-change-trigger'],
  );
  assert.equal(
    nextPoll.pendingPacket?.contextMessages
      .find(message => message.messageId === 'edited-change')?.message,
    'second content',
    'later packets use the edited text',
  );
});

test('context store keeps distinct IDs with identical text and updates an edit in place', () => {
  const store = createContextStore();
  store.add([
    { messageId: '7521145770279674844', message: 'same visible text', sender: 'Alex' },
    { messageId: 'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc', message: 'same visible text', sender: 'Alex' },
  ]);

  assert.deepEqual(store.getState().messageIds, [
    '7521145770279674844',
    'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc',
  ]);

  store.add([{ messageId: '7521145770279674844', message: 'genuinely different', sender: 'Alex' }]);

  assert.deepEqual(store.getState().messageIds, [
    '7521145770279674844',
    'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc',
  ]);
  assert.equal(store.getState().size, 2, 'an edit does not create a second entry');
  assert.equal(store.getRecent(2)[0].message, 'genuinely different');
});

test('a context store batch with an invalid message leaves stored state unchanged', () => {
  const store = createContextStore();
  store.add([{ messageId: 'kept-1', message: 'first' }]);

  assert.throws(
    () => store.add([
      { messageId: 'kept-2', message: 'second' },
      { messageId: 'broken-1', message: 'invalid mention', mention: 'yes' as unknown as boolean },
    ]),
    /optional mention property must be a boolean/,
  );
  assert.deepEqual(store.getState().messageIds, ['kept-1']);
});

test('packet builder does not reprocess repeated messages and still accepts the next message', () => {
  const first = buildPacketTurn({
    newMessages: [{ messageId: 'm-1', message: 'hello' }],
  });
  const repeated = buildPacketTurn({
    newMessages: [],
    recentContext: [{ messageId: 'm-1', message: 'hello' }],
    state: first.state,
  });
  const next = buildPacketTurn({
    newMessages: [{
      messageId: 'm-2', message: '@Bot next', mention: true, direction: 'INCOMING',
    }],
    recentContext: [{ messageId: 'm-1', message: 'hello' }],
    state: repeated.state,
  });
  const released = buildPacketTurn({
    newMessages: [],
    recentContext: [{ messageId: 'm-1', message: 'hello' }],
    state: next.state,
  });

  assert.equal(repeated.packet, null);
  assert.deepEqual(repeated.state.observedMessages.map(message => message.messageId), ['m-1']);
  assert.equal(next.packet, null);
  assert.deepEqual(next.pendingPacket?.newMessages.map(message => message.messageId), ['m-2']);
  assert.deepEqual(released.packet?.newMessages.map(message => message.messageId), ['m-2']);
  assert.deepEqual(released.packet?.mentionMessages.map(message => message.messageId), ['m-2']);
});

test('packet processor sends context before new messages', async () => {
  const calls: unknown[][] = [];
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    generateReply: async (_apiKey, messages) => {
      calls.push(['generate', messages]);
      return 'reply';
    },
    composeReply: async (_page, reply) => {
      calls.push(['compose', reply]);
      return { status: 'sent' };
    },
  });

  const result = await processPacket({
    packetId: 'packet-001',
    contextMessages: [{ messageId: 'context-1', message: 'context' }],
    newMessages: [{ messageId: 'new-1', message: 'new' }],
  });

  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(calls, [
    ['generate', [
      { messageId: 'context-1', message: 'context' },
      { messageId: 'new-1', message: 'new' },
    ]],
    ['compose', 'reply'],
  ]);
});

test('packet scheduler rejects duplicate IDs and processes packets in order', async () => {
  const processed: string[] = [];
  const scheduler = createPacketScheduler(async packet => {
    processed.push(packet.packetId);
  });

  assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
  assert.equal(scheduler.submit({ packetId: 'packet-1' }), false);
  assert.equal(scheduler.submit({ packetId: 'packet-2' }), true);
  await scheduler.waitForIdle();

  assert.deepEqual(processed, ['packet-1', 'packet-2']);
  assert.deepEqual(scheduler.getState().completedPacketIds, ['packet-1', 'packet-2']);
});

test('packet scheduler holds queued packets while paused and resumes them in FIFO order', async () => {
  const pauseGate = createPauseGate();
  const processed: string[] = [];
  const scheduler = createPacketScheduler(async packet => {
    processed.push(packet.packetId);
  }, { pauseGate });

  pauseGate.pause();
  assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
  assert.equal(scheduler.submit({ packetId: 'packet-2' }), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(processed, []);
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    ['packet-1', 'packet-2'],
  );

  pauseGate.resume();
  await scheduler.waitForIdle();
  assert.deepEqual(processed, ['packet-1', 'packet-2']);
});

test('packet scheduler finishes the active packet before holding the next one while paused', async () => {
  const pauseGate = createPauseGate();
  const processed: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstStart = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  const firstRelease = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const scheduler = createPacketScheduler(async packet => {
    if (packet.packetId === 'packet-1') {
      firstStarted();
      await firstRelease;
    }
    processed.push(packet.packetId);
  }, { pauseGate });

  assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
  await firstStart;
  pauseGate.pause();
  assert.equal(scheduler.submit({ packetId: 'packet-2' }), true);
  releaseFirst();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(processed, ['packet-1']);
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    ['packet-2'],
  );

  pauseGate.resume();
  await scheduler.waitForIdle();
  assert.deepEqual(processed, ['packet-1', 'packet-2']);
});

test('packet scheduler cancels pending work when stopped while paused', async () => {
  const pauseGate = createPauseGate();
  const processed: string[] = [];
  const scheduler = createPacketScheduler(async packet => {
    processed.push(packet.packetId);
  }, { pauseGate });

  pauseGate.pause();
  assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
  assert.equal(scheduler.submit({ packetId: 'packet-2' }), true);
  await new Promise<void>(resolve => setImmediate(resolve));

  pauseGate.cancel();
  await scheduler.waitForIdle();
  assert.deepEqual(processed, []);
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    ['packet-1', 'packet-2'],
  );
});

test('packet scheduler discards queued work without interrupting the active packet', async () => {
  const processed: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstStart = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  const firstRelease = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const scheduler = createPacketScheduler(async packet => {
    if (packet.packetId === 'packet-1') {
      firstStarted();
      await firstRelease;
    }
    processed.push(packet.packetId);
  });

  assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
  await firstStart;
  assert.equal(scheduler.submit({ packetId: 'packet-2' }), true);
  assert.equal(scheduler.submit({ packetId: 'packet-3' }), true);
  assert.deepEqual(scheduler.discardPending(), ['packet-2', 'packet-3']);
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    [],
  );

  releaseFirst();
  await scheduler.waitForIdle();
  assert.deepEqual(processed, ['packet-1']);
});

test('packet scheduler survives work discarded while paused before resume', async () => {
  const pauseGate = createPauseGate();
  const processed: string[] = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const scheduler = createPacketScheduler(async packet => {
      processed.push(packet.packetId);
    }, { pauseGate });

    pauseGate.pause();
    assert.equal(scheduler.submit({ packetId: 'packet-1' }), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(scheduler.discardPending(), ['packet-1']);

    pauseGate.resume();
    await scheduler.waitForIdle();
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    assert.deepEqual(processed, []);
    assert.equal(scheduler.getState().activePacket, null);
    assert.deepEqual(scheduler.getState().pendingPackets, []);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('packet processor abandons a stale packet after reply generation', async () => {
  const calls: string[] = [];
  let destinationEpoch = 0;
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    isCurrent: packet => packet.packetId === 'packet-current' && destinationEpoch === 0,
    generateReply: async () => {
      calls.push('generate');
      destinationEpoch += 1;
      return 'reply';
    },
    composeReply: async () => {
      calls.push('compose');
      return { status: 'sent' };
    },
    logError: () => undefined,
  });

  await assert.rejects(
    processPacket({ packetId: 'packet-current' }),
    /destination changed/,
  );
  assert.deepEqual(calls, ['generate']);
});

test('packet processor rechecks the destination inside the send gate', async () => {
  const calls: string[] = [];
  const pauseGate = createPauseGate();
  let destinationEpoch = 0;
  let generationComplete!: () => void;
  const generated = new Promise<void>(resolve => {
    generationComplete = resolve;
  });
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    pauseGate,
    isCurrent: () => destinationEpoch === 0,
    generateReply: async () => {
      calls.push('generate');
      generationComplete();
      return 'reply';
    },
    composeReply: async (_page, _reply, options) => {
      calls.push('compose');
      destinationEpoch += 1;
      await options?.beforeSend?.();
      calls.push('send');
      return { status: 'sent' };
    },
    logError: () => undefined,
  });

  pauseGate.pause();
  const processing = processPacket({ packetId: 'packet-paused' });
  await generated;
  pauseGate.resume();

  await assert.rejects(processing, /destination changed/);
  assert.deepEqual(calls, ['generate', 'compose']);
});

test('packet processor waits for resume before composing a reply', async () => {
  const pauseGate = createPauseGate();
  const calls: string[] = [];
  let generationComplete!: () => void;
  const generated = new Promise<void>(resolve => {
    generationComplete = resolve;
  });
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    pauseGate,
    generateReply: async () => {
      calls.push('generate');
      generationComplete();
      return 'reply';
    },
    composeReply: async () => {
      calls.push('compose');
      return { status: 'sent' };
    },
  });

  pauseGate.pause();
  const processing = processPacket({ packetId: 'packet-paused' });
  await generated;
  assert.deepEqual(calls, ['generate']);

  pauseGate.resume();
  assert.deepEqual(await processing, { status: 'sent' });
  assert.deepEqual(calls, ['generate', 'compose']);
});

test('packet processor cancels waiting work when the engine stops while paused', async () => {
  const pauseGate = createPauseGate();
  let generationComplete!: () => void;
  const generated = new Promise<void>(resolve => {
    generationComplete = resolve;
  });
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    pauseGate,
    generateReply: async () => {
      generationComplete();
      return 'reply';
    },
    composeReply: async () => ({ status: 'sent' }),
    logError: () => undefined,
  });

  pauseGate.pause();
  const processing = processPacket({ packetId: 'packet-cancelled' });
  await generated;
  pauseGate.cancel();

  await assert.rejects(processing, /cancelled/);
});

test('production prompt keeps the active reply instruction and the shared constraints', () => {
  const instruction = composeTestPrompt();

  assert.match(instruction, /You are Ada/);
  assert.match(instruction, /natural, conversational Messenger participant/);
  assert.match(instruction, /roughly 3–12 words/);
  assert.match(instruction, /Return only the reply text/);
  assert.match(instruction, /This reply is a proposal until the application sends it/);
  assert.match(instruction, /Strict English-only output rule/);
  assert.doesNotMatch(instruction, /sounds like the personality configured for you/);
});


test('conversation policy makes the request win over commentary and repetition', () => {
  const instruction = getConversationPolicyInstruction();

  assert.match(
    instruction,
    /do not argue with, complain about, negotiate, or comment on a clear request/,
  );
  assert.match(
    instruction,
    /repeating what you are asked to repeat and dropping anything you are asked to stop saying/,
  );
  assert.match(instruction, /finish once the request is satisfied/);
  assert.doesNotMatch(
    instruction,
    /(?:always|feel free to) (?:argue|complain)/i,
    'the policy layer never licenses arguing with the request',
  );
});

test('custom personality stays in its layer while production keeps the request-first rule', () => {
  const voice = getPersonalityInstruction('custom', 'Sarcastic, deadpan, and blunt.');
  const production = composeTestPrompt('custom', 'Sarcastic, deadpan, and blunt.');

  assert.match(voice, /Sarcastic, deadpan, and blunt\./);
  assert.doesNotMatch(voice, /do not argue with, complain about/);
  assert.match(
    production,
    /do not argue with, complain about, negotiate, or comment on a clear request/,
  );
  assert.match(production, /repeating what you are asked to repeat/);
  assert.match(production, /dropping anything you are asked to stop saying/);
  assert.match(production, /finish once the request is satisfied/);
  assert.match(production, /Sarcastic, deadpan, and blunt\./);
});

test('default personality mode keeps the default instruction unchanged', () => {
  assert.equal(
    getPersonalityInstruction('default'),
    getDefaultPersonalityInstruction(),
  );
  assert.equal(
    getPersonalityInstruction('default', 'ignored custom text'),
    getDefaultPersonalityInstruction(),
  );
});

test('custom personality replaces only the personality layer', () => {
  const instruction = getPersonalityInstruction('custom', '  Sarcastic, deadpan, and blunt.  ');

  assert.match(instruction, /primary voice/);
  assert.match(instruction, /Sarcastic, deadpan, and blunt\./);
  assert.doesNotMatch(instruction, /Do not add filler or repeat a point/);
  assert.doesNotMatch(instruction, /roughly 3–12 words/);
  assert.doesNotMatch(instruction, /Never stack or chain emojis/);
  assert.doesNotMatch(instruction, /Return only the reply text/);
  assert.doesNotMatch(instruction, /Strict English-only output rule/);
  assert.ok(!instruction.includes(getDefaultPersonalityInstruction()));
});

test('custom personality rejects an empty or whitespace-only instruction', () => {
  assert.throws(() => getPersonalityInstruction('custom'), /non-empty custom personality instruction/);
  assert.throws(() => getPersonalityInstruction('custom', '   \n  '), /non-empty custom personality instruction/);
});

test('shared identity states boundaries without dictating a conversational personality', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada', aliases: ['@Ada'] });

  assert.doesNotMatch(identity, /playful, warm, spontaneous/);
  assert.doesNotMatch(identity, /tsundere|sarcastic|deadpan/i);
  assert.doesNotMatch(identity, /sounds like the personality configured for you/);
  assert.doesNotMatch(identity, /roughly one reply in ten/);
  assert.doesNotMatch(identity, /Strict English-only output rule/);
  assert.match(composeTestPrompt(), /Strict English-only output rule/);
});

test('custom personality stays authoritative within the English-only constraint', () => {
  const custom = 'Tsundere: prickly on the surface, quietly warm underneath.';
  const personality = getPersonalityInstruction('custom', custom);
  const composed = composeTestPrompt('custom', custom);

  assert.ok(personality.includes(custom), 'the configured personality is preserved');
  assert.doesNotMatch(personality, /Strict English-only output rule/);
  assert.ok(composed.startsWith(getBotIdentityInstruction(testIdentity)));
  assert.ok(composed.includes(ENGLISH_ONLY_INSTRUCTION));
  assert.equal(
    composed.split(ENGLISH_ONLY_INSTRUCTION).length - 1,
    1,
    'the English-only rule appears exactly once',
  );
  assert.match(composed, /never replace your configured personality/);
  assert.equal(getPersonalityInstruction('default'), getDefaultPersonalityInstruction());
});

test('custom personality is framed as the primary voice beside shared guardrails', () => {
  const custom = 'Tsundere: prickly and teasing, reluctantly warm, embarrassed when teased.';
  const instruction = getPersonalityInstruction('custom', custom);
  const behavioral = getConversationPolicyInstruction();

  assert.ok(instruction.includes(custom));
  assert.match(instruction, /configured personality below is your primary voice/);
  assert.match(instruction, /Embody its attitude, word choice, humor, and reactions/);
  assert.match(behavioral, /configured personality is the primary source of your voice/);
  assert.match(behavioral, /These guardrails never replace your configured personality/);
  assert.match(composeTestPrompt('custom', custom), /configured personality below is your primary voice/);
});

test('shared guardrails forbid assistant-style interviewing without forcing questions', () => {
  const behavioral = getConversationPolicyInstruction();

  assert.match(behavioral, /do not ask what is happening, how someone's day is going/i);
  assert.match(behavioral, /do not end nearly every reply with a question/i);
  assert.match(behavioral, /a reaction, a tease, a disagreement, or a short statement is a complete reply/i);
  assert.match(behavioral, /Questions are welcome when they genuinely fit/);
  assert.match(behavioral, /do not ask what is happening, how someone's day is going, or whether anything exciting happened/i);
  assert.match(behavioral, /do not open with lines like "What's on your mind/i);
  assert.match(behavioral, /a conversation may simply end/);
  assert.match(behavioral, /customer-service acknowledgements or excessive politeness/);
  assert.doesNotMatch(getDefaultPersonalityInstruction(), /do not ask what is happening/i);
});

test('tsundere guidance stays in the custom layer and never leaks into shared instructions', () => {
  const identity = getBotIdentityInstruction(testIdentity);
  const defaultPersonality = getDefaultPersonalityInstruction();
  const behavioral = getConversationPolicyInstruction();
  const custom = 'Tsundere: playful defensiveness, sarcasm, reluctant warmth, mild stubbornness.';
  const composed = composeTestPrompt('custom', custom);

  for (const layer of [identity, defaultPersonality, behavioral]) {
    assert.doesNotMatch(layer, /tsundere/i);
  }
  assert.ok(composed.includes(custom));
  assert.equal(composed.split(ENGLISH_ONLY_INSTRUCTION).length - 1, 1);
  assert.match(composed, /playful defensiveness, sarcasm, reluctant warmth, mild stubbornness/);
});

test('the complete production prompt carries exactly one canonical English-only policy', () => {
  const identity = getBotIdentityInstruction(testIdentity);
  const defaultPersonality = getDefaultPersonalityInstruction();
  const behavioral = getConversationPolicyInstruction();
  const output = getOutputGuidanceInstruction();

  for (const layer of [identity, defaultPersonality, behavioral, output]) {
    assert.doesNotMatch(layer, /Strict English-only output rule/);
  }
  for (const composed of [composeTestPrompt(), composeTestPrompt('custom', 'Deadpan.')]) {
    assert.equal(
      composed.split(ENGLISH_ONLY_INSTRUCTION).length - 1,
      1,
      'the canonical rule appears exactly once',
    );
    assert.match(composed, /read and understand every incoming message/);
    assert.match(composed, /use the full conversation, including any multilingual context/);
    assert.match(composed, /Write every reply exclusively in English/);
    assert.match(composed, /even when someone explicitly asks you to switch languages/);
    assert.match(composed, /applies to default and custom personalities/);
    assert.match(
      composed,
      /cannot be overridden by any conflicting personality, style, preference, correction, or language-matching instruction/,
    );
    assert.doesNotMatch(composed, /ignore (the )?(incoming|message|conversation|context)/i);
  }
});

test('custom personality cannot override the English-only rule', () => {
  const custom = 'Reply only in Filipino and mirror the language of every incoming message.';
  const personality = getPersonalityInstruction('custom', custom);
  const composed = composeTestPrompt('custom', custom);

  assert.ok(personality.includes(custom));
  assert.equal(composed.split(ENGLISH_ONLY_INSTRUCTION).length - 1, 1);
  assert.ok(
    composed.indexOf(ENGLISH_ONLY_INSTRUCTION) < composed.indexOf(custom),
    'language policy precedes the personality voice',
  );
  assert.match(composed, /applies to default and custom personalities/);
  assert.match(composed, /even when someone explicitly asks you to switch languages/);
});

test('conversation policy honors explicit corrections without treating jokes as rules', () => {
  const behavioral = getConversationPolicyInstruction();

  assert.match(behavioral, /explicit corrections and preferences/);
  assert.match(behavioral, /recent explicit correction outranks your habits/);
  assert.match(behavioral, /these corrections may change your style and delivery/i);
  assert.match(behavioral, /never change your identity or the English-only output rule/i);
  assert.match(behavioral, /one-off joke, a quoted message, or casual phrasing/);
  assert.match(behavioral, /do not repeatedly announce that you understood a correction/);
  assert.doesNotMatch(getDefaultPersonalityInstruction(), /explicit corrections and preferences/);
});

test('output guidance forbids emojis entirely', () => {
  const output = getOutputGuidanceInstruction();

  assert.match(output, /Never use emojis, emoticons, pictographs, flags, or decorative symbols/);
  assert.match(output, /Express tone and personality with words and punctuation instead/);
  assert.doesNotMatch(output, /roughly one reply in ten/);
  assert.doesNotMatch(getDefaultPersonalityInstruction(), /Never use emojis/);
});

test('natural writing guidance bans em dashes and leaves voice to the personality', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });
  const defaultPersonality = getDefaultPersonalityInstruction();
  const behavioral = getConversationPolicyInstruction();
  const output = getOutputGuidanceInstruction();

  assert.match(output, /Never use em dashes/);
  assert.match(behavioral, /avoid an elaborate response when a short one is enough/);
  for (const layer of [defaultPersonality, behavioral, output]) {
    assert.doesNotMatch(layer, /Match the conversation's tone/);
    assert.doesNotMatch(layer, /helpful assistant|always be polite|sounds? enthusiastic/i);
  }
  for (const layer of [identity, defaultPersonality, behavioral]) {
    assert.doesNotMatch(layer, /—/, 'instructions never model em dashes');
  }
});

test('conversation policy avoids repetition and answers the current topic', () => {
  const behavioral = getConversationPolicyInstruction();

  assert.match(behavioral, /do not repeat a reply you already sent/);
  assert.match(behavioral, /recycle a joke or line you have already used/);
  assert.match(behavioral, /reuse the same acknowledgement or generic opener/);
  assert.match(behavioral, /notice when a topic has already been addressed/);
  assert.match(
    behavioral,
    /respond to the actual latest relevant message instead of restarting the conversation/,
  );
  assert.doesNotMatch(getDefaultPersonalityInstruction(), /do not repeat a reply you already sent/);
});

test('configured personality stays the primary voice in the assembled instruction', () => {
  const custom = 'Tsundere: prickly and teasing, reluctantly warm.';
  const personality = getPersonalityInstruction('custom', custom);
  const behavioral = getConversationPolicyInstruction();
  const composed = composeTestPrompt('custom', custom);

  assert.ok(composed.startsWith(getBotIdentityInstruction(testIdentity)));
  assert.ok(composed.includes(custom));
  assert.equal(composed.split(ENGLISH_ONLY_INSTRUCTION).length - 1, 1);
  assert.match(personality, /configured personality below is your primary voice/);
  assert.doesNotMatch(personality, /do not argue with, complain about/i);
  assert.doesNotMatch(behavioral, /Match the conversation's tone/);
  assert.doesNotMatch(behavioral, /helpful assistant|always be polite|sounds? enthusiastic/i);
  assert.doesNotMatch(behavioral, /tsundere/i);
});

test('RNG packet keeps only the latest twenty-five messages in their existing order', () => {
  const recentMessages = Array.from({ length: 30 }, (_, index) => ({
    messageId: `m-${index + 1}`,
    message: `Message ${index + 1}`,
    sender: 'Alex',
  }));
  const packet = buildRngPacket(recentMessages);

  assert.deepEqual(packet.contextMessages, recentMessages.slice(-25));
  assert.deepEqual(packet.newMessages, []);
});

test('bot identity instruction is derived from the configured puppet name and its aliases', () => {
  const aliases = ['@PleaseGetout Daily', '@PleaseGetoutDaily', '@PleaseGetout_Daily'];
  const identity = getBotIdentityInstruction({ name: 'PleaseGetout Daily', aliases });

  assert.match(identity, /You are PleaseGetout Daily/);
  assert.ok(identity.includes('"PleaseGetout Daily"'));
  assert.ok(identity.includes('@PleaseGetout Daily'));
  assert.ok(identity.includes('@PleaseGetoutDaily'));
  assert.ok(identity.includes('@PleaseGetout_Daily'));
  assert.match(identity, /assistant role/);
  assert.match(identity, /assistant messages are posts you already wrote/);
  assert.match(identity, /reproduce it exactly/);
  assert.match(identity, /Never reorder, translate, or shorten a name/);
  assert.match(identity, /Never invent @-mentions/);
  assert.ok(!identity.includes('Geoff'), 'no participant is invented');
});

test('bot identity forbids routine self-mention prefixes without blocking requested quotes', () => {
  const aliases = ['@PleaseGetout Daily', '@PleaseGetoutDaily', '@PleaseGetout_Daily'];
  const identity = getBotIdentityInstruction({ name: 'PleaseGetout Daily', aliases });

  assert.match(identity, /Your name and aliases establish who you are; they do not need to be announced/);
  assert.match(identity, /Do not begin an ordinary reply with your own name or alias, with or without an @/);
  assert.match(identity, /do not use a self-mention as a greeting or as a prefix to a response/);
  assert.match(identity, /never use an @ mention as a default prefix to an ordinary response/);
  assert.match(
    identity,
    /when someone asks you to say, repeat, quote, or write a specific phrase, reproduce it exactly/i,
  );
  assert.match(identity, /This includes reproducing your own name or alias when it is explicitly requested/);
  assert.match(identity, /quoting text the user asked for, not announcing yourself/);
  assert.match(identity, /You are PleaseGetout Daily/);
});

test('both personality modes forbid Messenger-style mentions without banning names', () => {
  const instructions = [
    composeTestPrompt(),
    composeTestPrompt('custom', 'Sarcastic, deadpan, and blunt.'),
  ];

  for (const instruction of instructions) {
    assert.match(instruction, /Do not write Messenger-style @participant mentions/);
    assert.match(instruction, /address people by their ordinary name without an @/);
    assert.match(instruction, /address someone by their ordinary name without an @/);
    assert.match(instruction, /Only reproduce an @ mention when the user explicitly asks/);
    assert.match(instruction, /never use an @ mention as a default prefix to an ordinary response/);
    assert.doesNotMatch(instruction, /Use an @-mention only when it addresses someone else/);
  }
});

test('bot identity never forbids answering about its own name', () => {
  const identity = getBotIdentityInstruction({
    name: 'PleaseGetout Daily',
    aliases: ['@PleaseGetout Daily'],
  });

  assert.doesNotMatch(
    identity,
    /Do not mention or address yourself by name/,
    'an absolute self-name ban contradicts the rule that requested text is reproduced verbatim',
  );
  assert.match(identity, /a direct question about your name is answered plainly with the name itself, once/);
  assert.match(identity, /it is never a reason to refuse, dodge, or debate a request/);
});

test('bot identity follows a new subject instead of continuing an old argument', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });

  assert.match(identity, /treat a change of subject as the new subject/);
  assert.match(identity, /do not keep restating, defending, or re-arguing it/);
  assert.match(identity, /do not comment on how often you have been asked/);
  assert.match(identity, /Do not resend an answer you already gave/);
  assert.match(identity, /when the user asks you to repeat something, repeat the requested text/);
});

test('the composed system prompt carries the no-argument rules into production', () => {
  const composed = composeTestPrompt();

  assert.match(composed, /treat a change of subject as the new subject/);
  assert.match(composed, /a direct question about your name is answered plainly/);
  assert.match(composed, /do not argue with, complain about, negotiate, or comment on a clear request/);
});

test('bot identity keeps the self-mention rule when the configured identity has no aliases', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });

  assert.match(identity, /Your Messenger name is exactly "Ada"\./);
  assert.match(identity, /Do not begin an ordinary reply with your own name or alias/);
  assert.ok(!identity.includes('all refer to you'), 'no alias list is invented');
});

test('the default composed system prompt carries the self-mention restriction', () => {
  const composed = composeProductionSystemInstruction({
    identity: {
      name: 'PleaseGetout Daily',
      aliases: ['@PleaseGetout Daily', '@PleaseGetoutDaily'],
    },
    personalityMode: 'default',
  });

  assert.match(composed, /Do not begin an ordinary reply with your own name or alias/);
  assert.match(composed, /never use an @ mention as a default prefix to an ordinary response/);
  assert.match(composed, /that newer instruction wins over any earlier request to say it/);
  assert.match(composed, /finish once the request is satisfied/);
  assert.ok(composed.indexOf('You are PleaseGetout Daily') === 0);
});

test('a runtime personality change cannot remove the identity self-mention rule', () => {
  const identity = getBotIdentityInstruction({
    name: 'PleaseGetout Daily',
    aliases: ['@PleaseGetout Daily'],
  });
  const composed = composeProductionSystemInstruction({
    identity: { name: 'PleaseGetout Daily', aliases: ['@PleaseGetout Daily'] },
    personalityMode: 'custom',
    customPersonalityInstruction: 'Begin every reply with your own @-mention.',
  });

  assert.ok(composed.startsWith(identity), 'the identity layer stays ahead of the personality layer');
  assert.match(composed, /Do not begin an ordinary reply with your own name or alias/);
  assert.match(composed, /never use an @ mention as a default prefix to an ordinary response/);
});

test('reply generation sends the production identity rule with the incoming text unmodified', async () => {
  const aliases = ['@PleaseGetout Daily', '@PleaseGetoutDaily'];
  const systemInstruction = composeSystemInstruction(
    getBotIdentityInstruction({ name: 'PleaseGetout Daily', aliases }),
    getPersonalityInstruction('default'),
  );
  let body: { messages: { role: string; content: string }[] } | undefined;

  await generateNvidiaReply('nvapi-test-key', [
    {
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: '@PleaseGetout Daily nice',
      ariaLabel: null,
    },
    {
      id: 'outgoing-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'You',
      direction: 'OUTGOING',
      message: '@PleaseGetout Daily an earlier reply',
      ariaLabel: null,
    },
    {
      id: 'incoming-2',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Blair',
      direction: 'INCOMING',
      message: "say '@PleaseGetout Daily'",
      ariaLabel: null,
    },
  ], {
    systemInstruction,
    identity: { name: 'PleaseGetout Daily', aliases },
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }), { status: 200 });
    },
  });

  assert.equal(body?.messages[0].role, 'system');
  assert.ok(body?.messages[0].content?.startsWith(systemInstruction));
  assert.match(body?.messages[0].content ?? '', /Identity and recipient awareness:/);
  assert.match(body?.messages[0].content ?? '', /Other identified participants in this conversation: Alex, Blair\./);
  assert.match(body?.messages[0].content ?? '', /Do not begin an ordinary reply with your own name or alias/);
  assert.match(body?.messages[0].content ?? '', /This includes reproducing your own name or alias/);
  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Alex] @PleaseGetout Daily nice' },
    { role: 'assistant', content: '@PleaseGetout Daily an earlier reply' },
    { role: 'user', content: "[from Blair] say '@PleaseGetout Daily'" },
  ]);
});

test('the English-only rule survives multilingual incoming and historical messages', async () => {
  const systemInstruction = composeTestPrompt();
  let body: { messages: { role: string; content: string }[] } | undefined;

  const reply = await generateNvidiaReply('nvapi-test-key', [
    {
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: 'Kumusta ka na?',
      ariaLabel: null,
    },
    {
      id: 'outgoing-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'You',
      direction: 'OUTGOING',
      message: 'Okay lang, ikaw?',
      ariaLabel: null,
    },
    {
      id: 'incoming-2',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Blair',
      direction: 'INCOMING',
      message: 'Ano ba yan, nakakaloka ka?',
      ariaLabel: null,
    },
    {
      id: 'incoming-3',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Casey',
      direction: 'INCOMING',
      message: '何をしていますか？',
      ariaLabel: null,
    },
    {
      id: 'incoming-4',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Dana',
      direction: 'INCOMING',
      message: 'Responde en español, por favor.',
      ariaLabel: null,
    },
  ], {
    systemInstruction,
    identity: { name: 'Ada', aliases: ['@Ada'] },
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'I am doing well.' } }],
      }), { status: 200 });
    },
  });

  assert.equal(reply, 'I am doing well.');
  assert.match(body?.messages[0].content ?? '', /You are Ada/);
  assert.match(
    body?.messages[0].content ?? '',
    /Other identified participants in this conversation: Alex, Blair, Casey, Dana\./,
  );
  assert.equal(
    body?.messages[0].content?.split(ENGLISH_ONLY_INSTRUCTION).length,
    2,
    'the English-only rule appears exactly once',
  );
  assert.match(body?.messages[0].content ?? '', /read and understand every incoming message/);
  assert.match(body?.messages[0].content ?? '', /use the full conversation, including any multilingual context/);
  assert.match(body?.messages[0].content ?? '', /even when someone explicitly asks you to switch languages/);
  assert.match(body?.messages[0].content ?? '', /does not reduce your understanding of the conversation/);
  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Alex] Kumusta ka na?' },
    { role: 'assistant', content: 'Okay lang, ikaw?' },
    { role: 'user', content: '[from Blair] Ano ba yan, nakakaloka ka?' },
    { role: 'user', content: '[from Casey] 何をしていますか？' },
    { role: 'user', content: '[from Dana] Responde en español, por favor.' },
  ]);
});

test('bot identity asks for one plain reproduction and lets a later stop instruction win', () => {
  const identity = getBotIdentityInstruction({
    name: 'PleaseGetout Daily',
    aliases: ['@PleaseGetout Daily'],
  });

  assert.match(
    identity,
    /Give the requested text once, plainly, without repeating it or wrapping it in commentary/,
  );
  assert.match(identity, /that newer instruction wins over any earlier request to say it/);
  assert.match(
    identity,
    /do not include it in your reply, not even to quote the request back or to promise that you are stopping/,
  );
});

test('bot identity still repeats requested text without resending an old answer', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });

  assert.match(identity, /Do not resend an answer you already gave/);
  assert.match(identity, /when the user asks you to repeat something, repeat the requested text/);
  assert.doesNotMatch(
    identity,
    /Do not repeat a reply you already gave/,
    'a repeat request must not be treated as disallowed replying',
  );
});

test('bot identity instruction is empty without a configured puppet name', () => {
  assert.equal(getBotIdentityInstruction({ name: '' }), '');
  assert.equal(getBotIdentityInstruction({ name: '   ' }), '');
  assert.equal(
    getBotIdentityInstruction({ name: '', aliases: ['@Bot'] }),
    '',
    'aliases alone do not establish an identity',
  );
});

test('composeSystemInstruction joins only supplied layers', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });
  const personality = getPersonalityInstruction('custom', 'Deadpan.');
  const composed = composeSystemInstruction(identity, personality);

  assert.equal(composed, `${identity}\n\n${personality}`);
  assert.ok(composed.startsWith(identity));
  assert.ok(composed.includes('Deadpan.'));
  assert.doesNotMatch(composed, /do not argue with, complain about/);
  assert.doesNotMatch(composed, /Strict English-only output rule/);
  assert.equal(
    composeSystemInstruction('', getDefaultPersonalityInstruction()),
    getDefaultPersonalityInstruction(),
  );
});

test('composeProductionSystemInstruction orders identity, language, policy, voice, and output', () => {
  const composed = composeTestPrompt('custom', 'Deadpan.');

  assert.ok(composed.indexOf('You are Ada') < composed.indexOf(ENGLISH_ONLY_INSTRUCTION));
  assert.ok(composed.indexOf(ENGLISH_ONLY_INSTRUCTION) < composed.indexOf('Deadpan.'));
  assert.ok(composed.indexOf('Deadpan.') < composed.indexOf('roughly 3–12 words'));
});

test('production prompt requires honest handling of memory and supplied history', () => {
  const composed = composeTestPrompt();

  assert.ok(composed.includes(getMemoryHonestyInstruction()));
  assert.match(composed, new RegExp(MEMORY_HONESTY_INSTRUCTION_MARKER));
  assert.match(composed, /Distinguish the current conversation from any explicitly supplied historical context/u);
  assert.match(composed, /only text present in the supplied transcript as known conversation history/u);
  assert.match(composed, /Do not claim to remember a previous conversation/u);
  assert.match(composed, /Recognizing a participant.*not the same as remembering their personal history/u);
  assert.match(composed, /Never turn a plausible inference into a claimed memory/u);
  assert.match(composed, /say naturally that you cannot see it or do not remember it/u);
});

test('production prompt defaults to ending a complete turn without a follow-up question', () => {
  const composed = composeTestPrompt('custom', 'Deadpan.');
  const initiative = getConversationalInitiativeInstruction();

  assert.ok(composed.includes(initiative));
  assert.match(composed, new RegExp(CONVERSATIONAL_INITIATIVE_INSTRUCTION_MARKER));
  assert.match(composed, /Default to ending your reply when the thought is complete/u);
  assert.match(composed, /Do not ask a question just to keep the conversation going/u);
  assert.match(composed, /Never add a generic engagement question/u);
  assert.match(composed, /Ask only when you genuinely need information, clarification, or a decision/u);
  assert.ok(composed.indexOf('Deadpan.') < composed.indexOf(initiative));
  assert.ok(composed.indexOf('roughly 3–12 words') < composed.indexOf(initiative));
});

test('memory and initiative instructions are appended once and stay idempotent', () => {
  const initial = appendConversationalInitiativeInstruction(
    appendMemoryHonestyInstruction('Base instruction.'),
  );
  const repeated = appendConversationalInitiativeInstruction(
    appendMemoryHonestyInstruction(initial),
  );

  assert.equal(repeated, initial);
  assert.equal(initial.match(/Memory and conversational history:/gu)?.length, 1);
  assert.equal(initial.match(/Conversational initiative:/gu)?.length, 1);
  assert.ok(initial.startsWith('Base instruction.'));
  assert.ok(initial.indexOf(MEMORY_HONESTY_INSTRUCTION_MARKER) <
    initial.indexOf(CONVERSATIONAL_INITIATIVE_INSTRUCTION_MARKER));
});

test('composeProductionSystemInstruction places roster context after identity and before language', () => {
  const roster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'Ada', isPuppet: true },
      { firstName: 'Alex', isPuppet: false },
    ],
    puppet: { firstName: 'Ada', isPuppet: true },
    duplicateFirstNames: [],
  };
  const composed = composeProductionSystemInstruction({
    identity: testIdentity,
    personalityMode: 'default',
    roster,
  });

  assert.match(composed, /Group membership context: partial\./u);
  assert.match(composed, /Observed first names: Ada \(you\), Alex\./u);
  assert.ok(composed.indexOf('You are Ada') < composed.indexOf('Group membership context:'));
  assert.ok(composed.indexOf('Group membership context:') < composed.indexOf(ENGLISH_ONLY_INSTRUCTION));
});

test('appendGroupRosterInstruction replaces existing roster context instead of duplicating it', () => {
  const initial: GroupRoster = {
    status: 'partial',
    members: [{ firstName: 'Ada', isPuppet: true }],
    puppet: { firstName: 'Ada', isPuppet: true },
    duplicateFirstNames: [],
  };
  const refreshed: GroupRoster = {
    status: 'unavailable',
    members: [],
    puppet: null,
    duplicateFirstNames: [],
    reason: 'panel unavailable',
  };
  const composed = composeProductionSystemInstruction({
    identity: testIdentity,
    personalityMode: 'default',
    roster: initial,
  });
  const appended = appendGroupRosterInstruction(composed, refreshed);

  assert.equal(appended.match(/Group membership context:/gu)?.length, 1);
  assert.match(appended, /Group membership context: unavailable\./u);
  assert.match(appended, /Do not assume the conversation has no other participants/u);
  assert.equal(appended.includes('Observed first names: Ada'), false);
});

test('getGroupRosterInstruction omits roster context when no roster is supplied', () => {
  assert.equal(getGroupRosterInstruction(), '');
});

test('getGroupRosterInstruction keeps only first names from runtime roster input', () => {
  const instruction = getGroupRosterInstruction({
    status: 'partial',
    members: [
      { firstName: 'Anselmo Calderon', isPuppet: true },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
    ],
    puppet: { firstName: 'Anselmo Calderon', isPuppet: true },
    duplicateFirstNames: [],
  });

  assert.match(instruction, /Observed first names: Anselmo \(you\), Geoff\./u);
  for (const surname of ['Calderon', 'Markus', 'Del Rio']) {
    assert.equal(instruction.includes(surname), false);
  }
});

test('the behavioral layer requires literal requests to be answered plainly', () => {
  assert.match(getDefaultBehavioralInstruction(), /literal request plainly and accurately/);
  assert.doesNotMatch(getDefaultBehavioralInstruction(), /playful, warm, spontaneous/);
});

test('packet builder never repeats a trigger that also arrived as context', () => {
  const first = buildPacketTurn({
    newMessages: [{
      messageId: 'in-1', message: '@Bot help', mention: true, direction: 'INCOMING',
    }],
    recentContext: [{ messageId: 'older-1', message: 'Earlier context' }],
  });
  // The second poll re-supplies the trigger from the Context Store alongside
  // genuinely older history.
  const second = buildPacketTurn({
    newMessages: [{ messageId: 'in-2', message: 'more', direction: 'INCOMING' }],
    recentContext: [
      { messageId: 'older-1', message: 'Earlier context' },
      { messageId: 'in-1', message: '@Bot help', mention: true, direction: 'INCOMING' },
    ],
    state: first.state,
  });

  assert.deepEqual(second.packet?.newMessages.map(message => message.messageId), ['in-1', 'in-2']);
  assert.deepEqual(second.packet?.contextMessages.map(message => message.messageId), ['older-1']);
  assert.deepEqual(second.packet?.mentionMessages.map(message => message.messageId), ['in-1']);
});

test('packet scheduler records a failed packet, keeps draining, and never retries it', async () => {
  const processed: string[] = [];
  const scheduler = createPacketScheduler(async packet => {
    processed.push(packet.packetId);
    if (packet.packetId === 'packet-fail') {
      throw new Error('generation failed');
    }
  });

  assert.equal(scheduler.submit({ packetId: 'packet-fail' }), true);
  assert.equal(scheduler.submit({ packetId: 'packet-ok' }), true);
  await scheduler.waitForIdle();

  const state = scheduler.getState();
  assert.deepEqual(processed, ['packet-fail', 'packet-ok']);
  assert.deepEqual(state.failedPacketIds, ['packet-fail']);
  assert.deepEqual(state.completedPacketIds, ['packet-ok']);
  assert.equal(state.activePacket, null);
  assert.deepEqual(state.pendingPackets, []);
  assert.equal(
    scheduler.submit({ packetId: 'packet-fail' }),
    false,
    'a failed packet is not resubmitted',
  );
});

test('a follow-up mention keeps the previous user turn, the bot reply, and one trigger', async () => {
  const incoming = (messageId: string, message: string, mention = false) => ({
    messageId,
    message,
    mention,
    sender: 'Alex',
    direction: 'INCOMING' as const,
  });
  const earlier = {
    messageId: 'ctx-1',
    message: 'planning the trip',
    sender: 'Blair',
    direction: 'INCOMING' as const,
  };
  const firstMention = incoming('in-1', '@Bot are you around?', true);
  const botReply = {
    messageId: 'out-1',
    message: 'Yep, what do you need?',
    sender: 'You',
    direction: 'OUTGOING' as const,
  };
  const followUp = incoming('in-2', '@Bot summarise the plan', true);

  const opened = buildPacketTurn({ newMessages: [firstMention], recentContext: [earlier] });
  const first = buildPacketTurn({
    newMessages: [botReply],
    recentContext: [earlier, firstMention],
    state: opened.state,
  });
  assert.deepEqual(first.packet?.newMessages.map(message => message.messageId), ['in-1', 'out-1']);

  const followUpOpened = buildPacketTurn({
    newMessages: [followUp],
    recentContext: [earlier, firstMention, botReply],
    state: first.state,
  });
  const followUpPacket = buildPacketTurn({
    newMessages: [],
    recentContext: [earlier, firstMention, botReply],
    state: followUpOpened.state,
  }).packet;

  assert.deepEqual(
    followUpPacket?.contextMessages.map(message => message.messageId),
    ['ctx-1', 'in-1', 'out-1'],
    'the previous user turn and the bot reply are context, not new work',
  );
  assert.deepEqual(followUpPacket?.newMessages.map(message => message.messageId), ['in-2']);
  assert.deepEqual(followUpPacket?.mentionMessages.map(message => message.messageId), ['in-2']);

  const requestMessages = [
    ...followUpPacket!.contextMessages,
    ...followUpPacket!.newMessages,
  ];
  assert.equal(
    requestMessages.filter(message => message.messageId === 'in-2').length,
    1,
    'the follow-up trigger appears exactly once',
  );

  let body: { messages: { role: string; content: string }[] } | undefined;
  await generateNvidiaReply(
    'nvapi-test-key',
    requestMessages as unknown as Parameters<typeof generateNvidiaReply>[1],
    {
      systemInstruction: 'Test instruction.',
      identity: { name: 'TestBot' },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }), { status: 200 });
      },
    },
  );

  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Blair] planning the trip' },
    { role: 'user', content: '[from Alex] @Bot are you around?' },
    { role: 'assistant', content: 'Yep, what do you need?' },
    { role: 'user', content: '[from Alex] @Bot summarise the plan' },
  ]);
});

test('a mention arriving while a packet is in flight becomes a queued second packet', async () => {
  const incoming = (messageId: string, message: string) => ({
    messageId,
    message,
    mention: true,
    sender: 'Alex',
    direction: 'INCOMING' as const,
  });
  const firstMention = incoming('a-1', '@Bot first');
  const secondMention = incoming('a-2', '@Bot second');

  const firstOpen = buildPacketTurn({ newMessages: [firstMention] });
  const firstFinal = buildPacketTurn({ newMessages: [], state: firstOpen.state });
  const secondOpen = buildPacketTurn({
    newMessages: [secondMention],
    recentContext: [firstMention],
    state: firstFinal.state,
  });
  const secondFinal = buildPacketTurn({
    newMessages: [],
    recentContext: [firstMention],
    state: secondOpen.state,
  });

  assert.equal(firstFinal.packet?.packetId, 'packet-001');
  assert.equal(secondFinal.packet?.packetId, 'packet-002');
  assert.deepEqual(secondFinal.packet?.newMessages.map(message => message.messageId), ['a-2']);
  assert.deepEqual(
    secondFinal.packet?.contextMessages.map(message => message.messageId),
    ['a-1'],
    'the first mention is history for the second packet, not a trigger',
  );

  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const started: string[] = [];
  const scheduler = createPacketScheduler(async packet => {
    started.push(packet.packetId);
    if (packet.packetId === 'packet-001') {
      await firstRelease;
    }
  });

  assert.equal(scheduler.submit(firstFinal.packet!), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['packet-001']);

  assert.equal(scheduler.submit(secondFinal.packet!), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['packet-001'], 'the second packet waits for the active one');

  releaseFirst();
  await scheduler.waitForIdle();
  assert.deepEqual(started, ['packet-001', 'packet-002'], 'the follow-up is not lost');
  assert.deepEqual(scheduler.getState().completedPacketIds, ['packet-001', 'packet-002']);
});

test('packet processor generates and composes without an adjudication step', async () => {
  const calls: string[] = [];
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    generateReply: async () => {
      calls.push('generate');
      return 'reply';
    },
    composeReply: async () => {
      calls.push('compose');
      return { status: 'sent' };
    },
  });
  const packet = {
    packetId: 'packet-direct',
    newMessages: [{ messageId: 'in-1', message: 'hey Alex' }],
  };

  assert.deepEqual(await processPacket(packet), { status: 'sent' });
  assert.deepEqual(calls, ['generate', 'compose']);
  assert.equal('reply' in packet, false);
});

test('RNG packets do not carry an adjudication decision', () => {
  const rngPacket = buildRngPacket([{
    messageId: 'in-1',
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'hello',
    timestamp: null,
  }]);

  assert.equal('reply' in rngPacket, false);
});

test('mention packets do not carry an adjudication decision', () => {
  const result = buildPacketTurn({
    newMessages: [{
      messageId: 'in-1', message: '@Bot help', mention: true, direction: 'INCOMING',
    }],
  });

  assert.ok(result.pendingPacket);
  assert.equal('reply' in result.pendingPacket, false);
});

test('mention matcher accepts bare, prefixed, and mixed-case identity forms', () => {
  const matcher = createMentionMatcher({ name: 'Yukinon', aliases: ['@Yukinon', 'Yuki'] });

  assert.equal(matcher('Yukinon are you good?'), true);
  assert.equal(matcher('yukinon'), true);
  assert.equal(matcher('YUKINON, you there?'), true);
  assert.equal(matcher('@Yukinon hi'), true);
  assert.equal(matcher('hey yuki, what now'), true);
  assert.equal(matcher('good morning'), false);
  assert.equal(matcher('Katsuyo can you hear me?'), false);
});

test('mention matcher rejects substring and word-boundary false positives', () => {
  const matcher = createMentionMatcher({ name: 'Bot', aliases: ['@Bot'] });

  assert.equal(matcher('@Bot, still there?'), true);
  assert.equal(matcher('Bot?'), true);
  assert.equal(matcher('@Botany is a plant'), false);
  assert.equal(matcher('the robotics club meets today'), false);
  assert.equal(matcher('bottle of water'), false);
});

test('mention matcher honours multiword configured identities and existing aliases', () => {
  const aliases = ['@PleaseGetout Daily', '@PleaseGetoutDaily', '@PleaseGetout_Daily'];
  const matcher = createMentionMatcher({ name: 'PleaseGetout Daily', aliases });

  assert.equal(matcher('@PleaseGetout Daily can you check this?'), true);
  assert.equal(matcher('PleaseGetout Daily can you check this?'), true);
  assert.equal(matcher('pleasegetoutdaily are you there'), true);
  assert.equal(matcher('@PleaseGetout_Daily explain'), true);
  assert.equal(matcher('@PleaseGetoutDailyX explain'), false);
  assert.equal(matcher('PleaseGetoutDailybreak is not the name'), false);
});

test('mention matcher recognizes the configured short name without a separate alias', () => {
  const matcher = createMentionMatcher({
    name: 'Yukinon Yukinoshita',
    aliases: ['@Yukinon Yukinoshita'],
  });

  assert.equal(matcher('Yukinon, what do you think?'), true);
  assert.equal(matcher('@Yukinon hello'), true);
  assert.equal(matcher('Yukinon Yukinoshita, what do you think?'), true);
  assert.equal(matcher('Yukinoshita hello'), false);
});

test('mention matcher follows the configured identity and never matches without one', () => {
  const matcher = createMentionMatcher({ name: 'Anselmo', aliases: ['@Anselmo'] });
  assert.equal(matcher('anselmo hello'), true);
  assert.equal(matcher('@Anselmo hello'), true);
  assert.equal(matcher('yukinon hello'), false);

  assert.equal(createMentionMatcher({ name: '', aliases: [] })('anything at all'), false);
});

test('bounded id tracking enforces its limit, evicts oldest first, and keeps retained duplicates', () => {
  const ids = createBoundedIdSet(3);
  ids.add('one');
  ids.add('two');
  ids.add('three');
  ids.add('two');
  assert.deepEqual(ids.values(), ['one', 'two', 'three'], 're-adding a known id does not reorder');

  ids.add('four');
  assert.deepEqual(ids.values(), ['two', 'three', 'four']);
  assert.equal(ids.has('one'), false);
  assert.equal(ids.has('three'), true);
  assert.equal(ids.size, 3);

  ids.clear();
  assert.equal(ids.size, 0);
});

test('packet builder bounds observed message retention and evicts oldest first', () => {
  let state = createPacketBuilderState();
  for (let index = 1; index <= 5; index += 1) {
    state = buildPacketTurn({
      newMessages: [{ messageId: `bounded-${index}`, message: `message ${index}` }],
      state,
      observedLimit: 3,
    }).state;
  }

  assert.deepEqual(
    state.observedMessages.map(message => message.messageId),
    ['bounded-3', 'bounded-4', 'bounded-5'],
  );

  const repeated = buildPacketTurn({
    newMessages: [{ messageId: 'bounded-4', message: 'message 4' }],
    state,
    observedLimit: 3,
  });
  assert.equal(repeated.packet, null, 'a retained id is not reprocessed');
  assert.equal(repeated.state.observedMessages.length, 3);
});

test('packet processor discards a stale packet before generation', async () => {
  const calls: string[] = [];
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    generateReply: async () => {
      calls.push('generate');
      return 'reply';
    },
    composeReply: async () => {
      calls.push('compose');
      return { status: 'sent' };
    },
    isStale: () => true,
    logError: () => undefined,
  });

  await assert.rejects(
    processPacket({
      packetId: 'packet-stale-before-generation',
      newMessages: [{ messageId: 'in-1', message: 'hello' }],
    }),
    PacketStaleError,
  );
  assert.deepEqual(calls, []);
});

test('packet processor rechecks freshness immediately before sending', async () => {
  const calls: string[] = [];
  let stale = false;
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    generateReply: async () => {
      calls.push('generate');
      return 'reply';
    },
    composeReply: async (_page, _reply, options) => {
      calls.push('compose');
      stale = true;
      await options?.beforeSend?.();
      return { status: 'sent' };
    },
    isStale: () => stale,
    logError: () => undefined,
  });

  await assert.rejects(
    processPacket({
      packetId: 'packet-stale-before-send',
      newMessages: [{ messageId: 'in-1', message: 'hello' }],
    }),
    PacketStaleError,
  );
  assert.deepEqual(calls, ['generate', 'compose']);
});

test('packet processor delivers a packet that stays fresh', async () => {
  const calls: string[] = [];
  const processPacket = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-key',
    generateReply: async () => {
      calls.push('generate');
      return 'reply';
    },
    composeReply: async (_page, _reply, options) => {
      calls.push('compose');
      await options?.beforeSend?.();
      return { status: 'sent' };
    },
    isStale: () => false,
    logError: () => undefined,
  });

  assert.deepEqual(
    await processPacket({
      packetId: 'packet-fresh',
      newMessages: [{ messageId: 'in-1', message: 'hello' }],
    }),
    { status: 'sent' },
  );
  assert.deepEqual(calls, ['generate', 'compose']);
});