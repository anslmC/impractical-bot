import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextStore } from '../src/components/context-store.js';
import { buildPacketTurn } from '../src/components/mention-packet-builder.js';
import { extractMessageDetails } from '../src/components/message-extraction.js';
import { createPacketProcessor } from '../src/components/packet-processor.js';
import { createPacketScheduler } from '../src/components/packet-scheduler.js';
import { createPauseGate } from '../src/components/pause-gate.js';
import {
  composeSystemInstruction,
  getBotIdentityInstruction,
  getDefaultBehavioralInstruction,
  getDefaultPersonalityInstruction,
  getPersonalityInstruction,
} from '../src/components/personality.js';
import { buildRngPacket } from '../src/components/rng-packet-builder.js';
import { formatPollSummary, formatTerminalText } from '../src/components/terminal-formatting.js';
import { generateNvidiaReply } from '../src/ai/nvidia.js';

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

test('packet builder still rejects a genuine same-ID content change', () => {
  const firstPoll = buildPacketTurn({
    newMessages: [{ messageId: 'genuine-change', message: 'first content' }],
  });

  assert.throws(
    () => buildPacketTurn({
      newMessages: [{ messageId: 'genuine-change', message: 'second content' }],
      state: firstPoll.state,
    }),
    /Message ID genuine-change was observed with different content\./,
  );
});

test('context store keeps distinct IDs with identical text and rejects genuine conflicts', () => {
  const store = createContextStore();
  store.add([
    { messageId: '7521145770279674844', message: 'same visible text' },
    { messageId: 'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc', message: 'same visible text' },
  ]);

  assert.deepEqual(store.getState().messageIds, [
    '7521145770279674844',
    'mid.$gAAW_kanMS16nsy41p2hgejq1c6Pc',
  ]);
  assert.throws(
    () => store.add([{ messageId: '7521145770279674844', message: 'genuinely different' }]),
    /Message ID 7521145770279674844 was observed with different content\./,
  );
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

test('default personality keeps the active reply instruction', () => {
  assert.equal(
    getDefaultPersonalityInstruction(),
    'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Adapt to the group\'s languages, slang, expressions, and conversational style. Match its tone and social context: keep your playful, warm, spontaneous style, using emojis selectively when they add genuine nuance, humor, or emphasis and fit the group\'s tone and moment; let many replies rely on words alone, avoid stacked or chained emojis, vary their use naturally rather than following a fixed frequency or quota, and do not compensate with repeated interjections, exaggerated reactions, or filler; use humor, sarcasm, or teasing only when the conversation calls for it, respond normally when it is serious, simple, or informational, and keep the wording understandable rather than quirky, forced, or incoherent. Personality is style, not the answer: when a request is clear, do it without arguing, complaining, negotiating, or commenting on the request, and follow the latest instruction — repeat what you are asked to repeat, and if asked to stop saying something, stop — then finish once the request is satisfied instead of restating it or extending the bit. Prioritize clear, natural phrasing in a language you handle well; do not force a language you handle less naturally or insert foreign words merely to appear culturally familiar, mix languages only when natural, and use a particular language when the context clearly calls for it and you can do so naturally. Do not add filler, repeat a point, or ask a follow-up question just to keep the conversation going; a short reply or no additional message is fine when nothing useful remains. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
  );
});

test('default personality makes the request win over commentary and repetition', () => {
  const instruction = getDefaultPersonalityInstruction();

  assert.match(
    instruction,
    /when a request is clear, do it without arguing, complaining, negotiating, or commenting on the request/,
  );
  assert.match(
    instruction,
    /follow the latest instruction — repeat what you are asked to repeat, and if asked to stop saying something, stop/,
  );
  assert.match(instruction, /finish once the request is satisfied/);
  assert.doesNotMatch(
    instruction,
    /(?:always|feel free to) (?:argue|complain)/i,
    'the personality layer never licenses arguing with the request',
  );
});

test('custom personality behavioral layer carries the same request-first rule', () => {
  const instruction = getPersonalityInstruction('custom', 'Sarcastic, deadpan, and blunt.');

  assert.match(
    instruction,
    /do not argue with, complain about, negotiate, or comment on a clear request/,
  );
  assert.match(instruction, /repeating what you are asked to repeat/);
  assert.match(instruction, /dropping anything you are asked to stop saying/);
  assert.match(instruction, /finish once the request is satisfied/);
  assert.match(instruction, /Sarcastic, deadpan, and blunt\./, 'the custom tone is preserved');
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

test('custom personality replaces only the personality layer and preserves behavioral instructions', () => {
  const instruction = getPersonalityInstruction('custom', '  Sarcastic, deadpan, and blunt.  ');

  assert.equal(instruction, `Sarcastic, deadpan, and blunt.\n\n${getDefaultBehavioralInstruction()}`);
  assert.ok(instruction.startsWith('Sarcastic, deadpan, and blunt.'));
  assert.ok(!instruction.includes('playful, warm, spontaneous'));
  assert.ok(!instruction.includes(getDefaultPersonalityInstruction()));
  assert.match(instruction, /Do not add filler, repeat a point, or ask a follow-up question/);
  assert.match(instruction, /roughly 3–12 words/);
  assert.match(instruction, /avoid stacked or chained emojis/);
  assert.match(instruction, /Return only the reply text/);
});

test('custom personality rejects an empty or whitespace-only instruction', () => {
  assert.throws(() => getPersonalityInstruction('custom'), /non-empty custom personality instruction/);
  assert.throws(() => getPersonalityInstruction('custom', '   \n  '), /non-empty custom personality instruction/);
});

test('RNG packet keeps only the latest ten messages in their existing order', () => {
  const recentMessages = Array.from({ length: 12 }, (_, index) => ({
    messageId: `m-${index + 1}`,
    message: `Message ${index + 1}`,
    sender: 'Alex',
  }));
  const packet = buildRngPacket(recentMessages);

  assert.deepEqual(packet.contextMessages, recentMessages.slice(-10));
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
  assert.match(identity, /never as a default prefix to an ordinary response/);
  assert.match(
    identity,
    /when someone asks you to say, repeat, quote, or write a specific phrase, reproduce it exactly/i,
  );
  assert.match(identity, /This includes reproducing your own name or alias when it is explicitly requested/);
  assert.match(identity, /quoting text the user asked for, not announcing yourself/);
  assert.match(identity, /You are PleaseGetout Daily/);
});

test('bot identity keeps the self-mention rule when the configured identity has no aliases', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });

  assert.match(identity, /Your Messenger name is exactly "Ada"\./);
  assert.match(identity, /Do not begin an ordinary reply with your own name or alias/);
  assert.ok(!identity.includes('all refer to you'), 'no alias list is invented');
});

test('the default composed system prompt carries the self-mention restriction', () => {
  const composed = composeSystemInstruction(
    getBotIdentityInstruction({
      name: 'PleaseGetout Daily',
      aliases: ['@PleaseGetout Daily', '@PleaseGetoutDaily'],
    }),
    getPersonalityInstruction('default'),
  );

  assert.match(composed, /Do not begin an ordinary reply with your own name or alias/);
  assert.match(composed, /never as a default prefix to an ordinary response/);
  assert.match(composed, /that newer instruction wins over any earlier request to say it/);
  assert.match(composed, /finish once the request is satisfied/);
  assert.ok(composed.indexOf('You are PleaseGetout Daily') === 0);
});

test('a runtime personality change cannot remove the identity self-mention rule', () => {
  const identity = getBotIdentityInstruction({
    name: 'PleaseGetout Daily',
    aliases: ['@PleaseGetout Daily'],
  });
  const conflictingPersonality = getPersonalityInstruction(
    'custom',
    'Begin every reply with your own @-mention.',
  );

  const composed = composeSystemInstruction(identity, conflictingPersonality);

  assert.ok(composed.startsWith(identity), 'the identity layer stays ahead of the personality layer');
  assert.match(composed, /Do not begin an ordinary reply with your own name or alias/);
  assert.match(composed, /never as a default prefix to an ordinary response/);
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
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }), { status: 200 });
    },
  });

  assert.equal(body?.messages[0].role, 'system');
  assert.equal(body?.messages[0].content, systemInstruction);
  assert.match(body?.messages[0].content ?? '', /Do not begin an ordinary reply with your own name or alias/);
  assert.match(body?.messages[0].content ?? '', /This includes reproducing your own name or alias/);
  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: 'Alex: @PleaseGetout Daily nice' },
    { role: 'assistant', content: '@PleaseGetout Daily an earlier reply' },
    { role: 'user', content: "Blair: say '@PleaseGetout Daily'" },
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

test('composeSystemInstruction keeps identity ahead of any personality layer', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada' });
  const composed = composeSystemInstruction(identity, getPersonalityInstruction('custom', 'Deadpan.'));

  assert.ok(composed.startsWith(identity));
  assert.ok(composed.includes('Deadpan.'));
  assert.ok(composed.includes(getDefaultBehavioralInstruction()));
  assert.equal(
    composeSystemInstruction('', getDefaultPersonalityInstruction()),
    getDefaultPersonalityInstruction(),
  );
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
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }), { status: 200 });
      },
    },
  );

  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: 'Blair: planning the trip' },
    { role: 'user', content: 'Alex: @Bot are you around?' },
    { role: 'assistant', content: 'Yep, what do you need?' },
    { role: 'user', content: 'Alex: @Bot summarise the plan' },
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
