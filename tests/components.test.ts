import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextStore } from '../src/components/context-store.js';
import { buildPacketTurn } from '../src/components/mention-packet-builder.js';
import { extractMessageDetails } from '../src/components/message-extraction.js';
import { createPacketProcessor } from '../src/components/packet-processor.js';
import { createPacketScheduler } from '../src/components/packet-scheduler.js';
import { createPauseGate } from '../src/components/pause-gate.js';
import { getDefaultPersonalityInstruction } from '../src/components/personality.js';
import { buildRngPacket } from '../src/components/rng-packet-builder.js';

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
    'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
  );
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