const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPacketScheduler } = require('../components/packet-scheduler');
const {
  createPacketProcessor,
  DEBUG_RELIABILITY_WARNING,
} = require('../components/packet-processor');

function packet(packetId, overrides = {}) {
  return {
    packetId,
    contextMessages: [{
      messageId: 'context-1',
      message: 'Earlier context',
      sender: 'Casey',
      direction: 'INCOMING',
    }],
    newMessages: [{
      messageId: 'mention-1',
      message: '@Bot please help',
      mention: true,
      sender: 'Jordan',
      direction: 'INCOMING',
    }],
    mentionMessages: [{ messageId: 'mention-1' }],
    ...overrides,
  };
}

test('sends context followed by new messages and passes NVIDIA reply to Composer', async () => {
  const calls = [];
  const processor = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-api-key',
    generateReply: async (apiKey, messages) => {
      calls.push({ type: 'generate', apiKey, messages });
      return 'Generated reply';
    },
    composeReply: async (page, reply) => {
      calls.push({ type: 'compose', page, reply });
      return { status: 'sent' };
    },
    logError: message => calls.push({ type: 'error', message }),
    logWarning: message => calls.push({ type: 'warning', message }),
  });

  const result = await processor(packet('packet-001'));

  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(calls, [
    {
      type: 'generate',
      apiKey: 'mock-api-key',
      messages: [
        packet('packet-001').contextMessages[0],
        packet('packet-001').newMessages[0],
      ],
    },
    { type: 'compose', page: 'mock-page', reply: 'Generated reply' },
  ]);
});

test('treats send-blocked as a failed packet and Scheduler proceeds to the next one', async () => {
  const composeResults = [
    { status: 'send-blocked', reason: 'disabled' },
    { status: 'sent' },
  ];
  const errors = [];
  const processor = createPacketProcessor({
    page: 'mock-page',
    apiKey: 'mock-api-key',
    generateReply: async () => 'Generated reply',
    composeReply: async () => composeResults.shift(),
    logError: message => errors.push(message),
    logWarning: () => assert.fail('Debug warning should not be emitted outside debug mode.'),
  });
  const scheduler = createPacketScheduler(processor);

  scheduler.submit(packet('packet-blocked'));
  scheduler.submit(packet('packet-next'));
  await scheduler.waitForIdle();

  const state = scheduler.getState();
  assert.equal(state.activePacket, null);
  assert.deepEqual(state.failedPacketIds, ['packet-blocked']);
  assert.deepEqual(state.completedPacketIds, ['packet-next']);
  assert.match(errors[0], /Composer send blocked: disabled/);
});

test('logs processing details, redacts the API key, and warns only in debug mode', async () => {
  const apiKey = 'secret-test-key';
  const failure = new Error(`NVIDIA request failed with credential ${apiKey}`);
  const logs = [];
  let callCount = 0;
  const processor = createPacketProcessor({
    page: 'mock-page',
    apiKey,
    debugMode: true,
    generateReply: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw failure;
      }
      return 'Generated reply';
    },
    composeReply: async () => ({ status: 'sent' }),
    logError: message => logs.push({ type: 'error', message }),
    logWarning: message => logs.push({ type: 'warning', message }),
  });
  const scheduler = createPacketScheduler(processor);

  scheduler.submit(packet('packet-failed'));
  scheduler.submit(packet('packet-after-failure'));
  await scheduler.waitForIdle();

  const state = scheduler.getState();
  assert.equal(state.activePacket, null);
  assert.deepEqual(state.failedPacketIds, ['packet-failed']);
  assert.deepEqual(state.completedPacketIds, ['packet-after-failure']);
  assert.equal(logs[0].type, 'error');
  assert.match(logs[0].message, /NVIDIA request failed/);
  assert.match(logs[0].message, /\[REDACTED\]/);
  assert.doesNotMatch(logs[0].message, /secret-test-key/);
  assert.deepEqual(logs[1], { type: 'warning', message: DEBUG_RELIABILITY_WARNING });
});