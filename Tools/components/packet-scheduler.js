function createPacketScheduler(processPacket) {
  if (typeof processPacket !== 'function') {
    throw new TypeError('processPacket must be a function.');
  }

  const pendingPackets = [];
  const submittedPacketIds = new Set();
  const completedPacketIds = [];
  const failedPacketIds = [];
  const idleWaiters = [];
  let activePacket = null;
  let processing = false;

  function notifyIdle() {
    while (idleWaiters.length > 0) {
      idleWaiters.shift()();
    }
  }

  async function drain() {
    if (processing) {
      return;
    }
    processing = true;

    try {
      while (pendingPackets.length > 0) {
        activePacket = pendingPackets.shift();
        try {
          await processPacket(activePacket);
          completedPacketIds.push(activePacket.packetId);
        } catch {
          failedPacketIds.push(activePacket.packetId);
        } finally {
          activePacket = null;
        }
      }
    } finally {
      processing = false;
      notifyIdle();
    }
  }

  return {
    submit(packet) {
      if (!packet || typeof packet.packetId !== 'string' || !packet.packetId) {
        throw new TypeError('packet must include a non-empty packetId.');
      }
      if (submittedPacketIds.has(packet.packetId)) {
        return false;
      }

      submittedPacketIds.add(packet.packetId);
      pendingPackets.push(packet);
      void drain();
      return true;
    },
    getState() {
      return {
        activePacket,
        pendingPackets: [...pendingPackets],
        completedPacketIds: [...completedPacketIds],
        failedPacketIds: [...failedPacketIds],
      };
    },
    waitForIdle() {
      if (!processing && pendingPackets.length === 0) {
        return Promise.resolve();
      }
      return new Promise(resolve => idleWaiters.push(resolve));
    },
  };
}

module.exports = { createPacketScheduler };