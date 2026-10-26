let nextPacketNumber = 1;

function buildRngPacket(recentMessages) {
  if (!Array.isArray(recentMessages)) {
    throw new TypeError('recentMessages must be an array.');
  }

  const contextMessages = recentMessages.slice(-10).map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        typeof message.messageId !== 'string' || !message.messageId ||
        typeof message.message !== 'string') {
      throw new TypeError('Each message must include a non-empty messageId and message string.');
    }
    return structuredClone(message);
  });
  const packetId = `rng-packet-${String(nextPacketNumber).padStart(3, '0')}`;
  nextPacketNumber += 1;

  return {
    packetId,
    contextMessages,
    newMessages: [],
  };
}

module.exports = { buildRngPacket };