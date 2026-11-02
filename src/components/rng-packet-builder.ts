let nextPacketNumber = 1;

export interface RngPacketMessage {
  messageId: string;
  message: string;
  [key: string]: unknown;
}

export interface RngPacket {
  packetId: string;
  contextMessages: RngPacketMessage[];
  newMessages: never[];
  triggerMessageId?: string;
}

export function buildRngPacket(
  recentMessages: RngPacketMessage[],
  triggerMessageId?: string,
): RngPacket {
  if (!Array.isArray(recentMessages)) {
    throw new TypeError('recentMessages must be an array.');
  }

  const contextMessages = recentMessages.slice(-25).map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        typeof message.messageId !== 'string' || !message.messageId ||
        typeof message.message !== 'string') {
      throw new TypeError('Each message must include a non-empty messageId and message string.');
    }
    return structuredClone(message);
  });
  const packetId = `rng-packet-${String(nextPacketNumber).padStart(3, '0')}`;
  nextPacketNumber += 1;
  const resolvedTriggerId = triggerMessageId ??
    [...contextMessages].reverse().find(message =>
      message.direction === 'INCOMING' &&
      typeof message.messageId === 'string' &&
      message.messageId !== ''
    )?.messageId;

  return {
    packetId,
    contextMessages,
    newMessages: [],
    ...(resolvedTriggerId === undefined ? {} : { triggerMessageId: resolvedTriggerId }),
  };
}
