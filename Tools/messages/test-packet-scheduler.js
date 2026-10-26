const assert = require('node:assert/strict');
const {
  buildPacketTurn,
  createPacketBuilderState,
} = require('../components/mention-packet-builder');
const { createPacketScheduler } = require('../components/packet-scheduler');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function message(messageId, text, mention = false) {
  return { messageId, message: text, mention };
}

async function main() {
  const processingOrder = [];
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const scheduler = createPacketScheduler(async packet => {
    activeOperations += 1;
    maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
    processingOrder.push(packet.packetId);
    console.log(
      `[processor] ${packet.packetId} is active; ` +
      '10-second choke timer started.'
    );
    try {
      await delay(10_000);
    } finally {
      activeOperations -= 1;
    }
    console.log(`[processor] ${packet.packetId} released/completed after 10 seconds.`);
  });

  const logSchedulerState = () => {
    const state = scheduler.getState();
    console.log(
      `[queue] active=${state.activePacket?.packetId ?? '(none)'} ` +
      `(${state.activePacket ? 'processing' : 'idle'}); ` +
      `waiting=${state.pendingPackets.length}; ` +
      `waiting IDs (FIFO)=${state.pendingPackets.map(packet => packet.packetId).join(' -> ') || '(none)'}; ` +
      `completed=${state.completedPacketIds.join(' -> ') || '(none)'}`
    );
  };
  const submitPacket = packet => {
    const accepted = scheduler.submit(packet);
    if (!accepted) {
      console.log(`[queue] ignored duplicate ${packet.packetId}`);
    } else {
      logSchedulerState();
    }
    return accepted;
  };

  let builderState = createPacketBuilderState();
  const seenMessageIds = new Set();
  const poll = messages => {
    const newMessages = messages.filter(item => {
      if (seenMessageIds.has(item.messageId)) {
        return false;
      }
      seenMessageIds.add(item.messageId);
      return true;
    });
    const hadPendingPacket = builderState.pendingPacket !== null;
    const result = buildPacketTurn({ newMessages, state: builderState });
    builderState = result.state;

    if (result.pendingPacket && !hadPendingPacket) {
      console.log(`[poll] opened ${result.pendingPacket.packetId}; not queueable yet`);
    }
    if (result.pendingPacket && hadPendingPacket) {
      console.log(`[poll] pending ${result.pendingPacket.packetId}`);
    }
    if (result.packet) {
      assert.ok(Array.isArray(result.packet.newMessages));
      assert.ok(Array.isArray(result.packet.mentionMessages));
      assert.ok(Array.isArray(result.packet.contextMessages));
      console.log(
        `[poll] finalized ${result.packet.packetId}; ` +
        `new=${result.packet.newMessages.length}; ` +
        `mentions=${result.packet.mentionMessages.length}; ` +
        `context=${result.packet.contextMessages.length}`
      );
      submitPacket(result.packet);
    }
    return result;
  };

  const firstOpening = poll([message('mention-1', '@bot first request', true)]);
  assert.equal(firstOpening.packet, null);
  assert.equal(scheduler.getState().activePacket, null);
  assert.deepEqual(scheduler.getState().pendingPackets, []);
  assert.deepEqual(processingOrder, []);
  const firstFinalization = poll([]);
  const firstPacket = firstFinalization.packet;
  assert.equal(scheduler.getState().activePacket.packetId, 'packet-001');
  assert.equal(submitPacket(firstPacket), false);

  const secondOpening = poll([message('mention-2', '@bot second request', true)]);
  assert.equal(secondOpening.packet, null);
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    [],
  );
  const secondFinalization = poll([]);
  const secondPacket = secondFinalization.packet;
  assert.equal(scheduler.getState().activePacket.packetId, 'packet-001');
  assert.deepEqual(
    scheduler.getState().pendingPackets.map(packet => packet.packetId),
    ['packet-002'],
  );
  assert.equal(submitPacket(secondPacket), false);

  await scheduler.waitForIdle();
  assert.equal(maximumActiveOperations, 1);
  assert.deepEqual(processingOrder, ['packet-001', 'packet-002']);

  assert.equal(submitPacket(firstPacket), false);
  await scheduler.waitForIdle();
  assert.deepEqual(processingOrder, ['packet-001', 'packet-002']);
  assert.deepEqual(scheduler.getState().completedPacketIds, ['packet-001', 'packet-002']);

  console.log(`[result] max active=${maximumActiveOperations}; order=${processingOrder.join(' -> ')}`);
  console.log('[result] scheduler experiment passed');
}

main().catch(error => {
  console.error(`Packet scheduler experiment failed: ${error.message}`);
  process.exitCode = 1;
});