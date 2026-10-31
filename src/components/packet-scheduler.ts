import type { PauseGate } from './pause-gate.js';

export interface ScheduledPacket {
  packetId: string;
}

export function createPacketScheduler<Packet extends ScheduledPacket>(
  processPacket: (packet: Packet) => unknown,
  { pauseGate }: { pauseGate?: PauseGate } = {},
) {
  if (typeof processPacket !== 'function') {
    throw new TypeError('processPacket must be a function.');
  }

  const pendingPackets: Packet[] = [];
  const submittedPacketIds = new Set();
  const completedPacketIds: string[] = [];
  const failedPacketIds: string[] = [];
  const idleWaiters: (() => void)[] = [];
  let activePacket: Packet | null = null;
  let processing = false;

  function notifyIdle() {
    while (idleWaiters.length > 0) {
      idleWaiters.shift()!();
    }
  }

  async function drain() {
    if (processing) {
      return;
    }
    processing = true;

    try {
      while (pendingPackets.length > 0) {
        if (pauseGate) {
          const result = await pauseGate.waitUntilResumed();
          if (result === 'cancelled') {
            break;
          }
          if (pauseGate.isPaused()) {
            continue;
          }
        }
        const packet = pendingPackets.shift();
        if (!packet) {
          break;
        }
        activePacket = packet;
        try {
          await processPacket(packet);
          completedPacketIds.push(packet.packetId);
        } catch {
          failedPacketIds.push(packet.packetId);
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
    submit(packet: Packet): boolean {
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
    discardPending(): string[] {
      const discardedPacketIds = pendingPackets.map(packet => packet.packetId);
      pendingPackets.length = 0;
      if (!processing) {
        notifyIdle();
      }
      return discardedPacketIds;
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
      if (!processing && (pendingPackets.length === 0 || pauseGate?.isCancelled())) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => idleWaiters.push(() => resolve()));
    },
  };
}
