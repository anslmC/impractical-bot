import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextStore } from '../src/components/context-store.js';
import { buildPacketTurn } from '../src/components/mention-packet-builder.js';
import { extractMessageDetails } from '../src/components/message-extraction.js';
import { createPacketProcessor } from '../src/components/packet-processor.js';
import { createPacketScheduler } from '../src/components/packet-scheduler.js';
import { createPauseGate } from '../src/components/pause-gate.js';
import { getDefaultPersonalityInstruction, getDefaultBehavioralInstruction, getPersonalityInstruction } from '../src/components/personality.js';
import { buildRngPacket } from '../src/components/rng-packet-builder.js';
import { formatPollSummary, formatTerminalText } from '../src/components/terminal-formatting.js';

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
    newMessages: [{ messageId: 'm-1', message: '@Bot help', mention: true }],
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
    newMessages: [{ messageId: 'm-2', message: '@Bot next', mention: true }],
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
    'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Adapt to the group\'s languages, slang, expressions, and conversational style. Match its tone and social context: keep your playful, warm, spontaneous style, using emojis selectively when they add genuine nuance, humor, or emphasis and fit the group\'s tone and moment; let many replies rely on words alone, avoid stacked or chained emojis, vary their use naturally rather than following a fixed frequency or quota, and do not compensate with repeated interjections, exaggerated reactions, or filler; use humor, sarcasm, or teasing only when the conversation calls for it, respond normally when it is serious, simple, or informational, and keep the wording understandable rather than quirky, forced, or incoherent. Prioritize clear, natural phrasing in a language you handle well; do not force a language you handle less naturally or insert foreign words merely to appear culturally familiar, mix languages only when natural, and use a particular language when the context clearly calls for it and you can do so naturally. Do not add filler, repeat a point, or ask a follow-up question just to keep the conversation going; a short reply or no additional message is fine when nothing useful remains. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
  );
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