import { isUnknownConversationDirection } from './conversation-context.js';

const OBSERVED_MESSAGE_LIMIT = 200;

export interface PacketBuilderMessage {
  messageId: string;
  message: string;
  mention?: boolean;
  sender?: unknown;
  direction?: unknown;
}

export interface PacketBuilderPacket {
  packetId: string;
  newMessages: PacketBuilderMessage[];
  mentionMessages: PacketBuilderMessage[];
  contextMessages: PacketBuilderMessage[];
  triggerMessageId?: string;
}

export interface PacketBuilderState {
  observedMessages: PacketBuilderMessage[];
  nextPacketNumber: number;
  pendingPacket: PacketBuilderPacket | null;
}

export function createPacketBuilderState(): PacketBuilderState {
  return {
    observedMessages: [],
    nextPacketNumber: 1,
    pendingPacket: null,
  };
}

function normalizeMessage(message: PacketBuilderMessage): PacketBuilderMessage {
  if (!message || typeof message !== 'object' ||
      typeof message.messageId !== 'string' || !message.messageId ||
      typeof message.message !== 'string') {
    throw new TypeError('Each message must include a non-empty messageId and message string.');
  }
  if (message.mention !== undefined && typeof message.mention !== 'boolean') {
    throw new TypeError('The optional mention property must be a boolean.');
  }

  return {
    messageId: message.messageId,
    message: message.message,
    mention: message.mention === true,
    ...(message.sender === undefined ? {} : { sender: message.sender }),
    ...(message.direction === undefined ? {} : { direction: message.direction }),
  };
}

function isMentionTrigger(message: PacketBuilderMessage): boolean {
  return message.direction === 'INCOMING' && message.mention === true;
}

function syncObservedMessage(
  target: PacketBuilderMessage,
  incoming: PacketBuilderMessage,
): void {
  target.message = incoming.message;
  if (incoming.sender === undefined) {
    delete target.sender;
  } else {
    target.sender = incoming.sender;
  }
  if (incoming.direction === undefined) {
    delete target.direction;
  } else {
    target.direction = incoming.direction;
  }
}

export function buildPacketTurn({
  newMessages,
  recentContext = [],
  state = createPacketBuilderState(),
  contextLimit,
  observedLimit = OBSERVED_MESSAGE_LIMIT,
}: {
  newMessages: PacketBuilderMessage[];
  recentContext?: PacketBuilderMessage[];
  state?: PacketBuilderState;
  contextLimit?: number;
  observedLimit?: number;
}): {
  packet: PacketBuilderPacket | null;
  pendingPacket: PacketBuilderPacket | null;
  state: PacketBuilderState;
} {
  if (!Array.isArray(newMessages) || !Array.isArray(recentContext)) {
    throw new TypeError('newMessages and recentContext must be arrays.');
  }
  if (!state || !Array.isArray(state.observedMessages) ||
      !Number.isInteger(state.nextPacketNumber) || state.nextPacketNumber < 1) {
    throw new TypeError('state must be created by createPacketBuilderState().');
  }
  if (contextLimit !== undefined && (!Number.isInteger(contextLimit) || contextLimit < 1)) {
    throw new TypeError('contextLimit must be a positive integer when provided.');
  }
  if (!Number.isInteger(observedLimit) || observedLimit < 1) {
    throw new TypeError('observedLimit must be a positive integer.');
  }

  const observedById = new Map(
    state.observedMessages.map(message => [message.messageId, { ...message }]),
  );
  const messagesById = new Map();
  const uniqueNewMessages = [];

  for (const rawMessage of newMessages) {
    const message = normalizeMessage(rawMessage);
    if (isUnknownConversationDirection(message.direction)) {
      continue;
    }
    const inBatch = messagesById.get(message.messageId);
    if (inBatch) {
      syncObservedMessage(inBatch, message);
      inBatch.mention ||= message.mention;
      continue;
    }

    const previouslyObserved = observedById.get(message.messageId);
    if (previouslyObserved) {
      syncObservedMessage(previouslyObserved, message);
      continue;
    }

    messagesById.set(message.messageId, message);
    uniqueNewMessages.push(message);
    observedById.set(message.messageId, { ...message });
  }

  const contextById = new Map();
  for (const rawMessage of recentContext) {
    const message = normalizeMessage(rawMessage);
    if (isUnknownConversationDirection(message.direction)) {
      continue;
    }
    const inContext = contextById.get(message.messageId);
    if (inContext) {
      contextById.delete(message.messageId);
      contextById.set(message.messageId, message);
      continue;
    }

    const inBatch = messagesById.get(message.messageId);
    if (inBatch) {
      syncObservedMessage(inBatch, message);
      continue;
    }

    contextById.set(message.messageId, message);
    const previouslyObserved = observedById.get(message.messageId);
    if (previouslyObserved) {
      syncObservedMessage(previouslyObserved, message);
    } else {
      observedById.set(message.messageId, { ...message });
    }
  }

  let nextPacketNumber = state.nextPacketNumber;
  let pendingPacket = state.pendingPacket
    ? {
        ...state.pendingPacket,
        newMessages: state.pendingPacket.newMessages.map(message => ({ ...message })),
        mentionMessages: state.pendingPacket.mentionMessages.map(message => ({ ...message })),
        contextMessages: state.pendingPacket.contextMessages.map(message => ({ ...message })),
      }
    : null;
  let packet = null;

  if (pendingPacket) {
    pendingPacket.newMessages.push(...uniqueNewMessages.map(message => ({ ...message })));
    pendingPacket.mentionMessages.push(
      ...uniqueNewMessages.filter(isMentionTrigger).map(message => ({ ...message })),
    );
    const newMessageIds = new Set(pendingPacket.newMessages.map(message => message.messageId));
    pendingPacket.contextMessages = pendingPacket.contextMessages
      .filter(message => !newMessageIds.has(message.messageId));
    packet = pendingPacket;
    pendingPacket = null;
  } else if (uniqueNewMessages.some(isMentionTrigger)) {
    pendingPacket = {
      packetId: `packet-${String(nextPacketNumber).padStart(3, '0')}`,
      newMessages: uniqueNewMessages.map(message => ({ ...message })),
      mentionMessages: uniqueNewMessages
        .filter(isMentionTrigger)
        .map(message => ({ ...message })),
      contextMessages: [...contextById.values()]
        .slice(contextLimit === undefined ? 0 : -contextLimit)
        .map(message => ({ ...message })),
      triggerMessageId: uniqueNewMessages.find(isMentionTrigger)?.messageId,
    };
    nextPacketNumber += 1;
  }

  const observedMessages = [...observedById.values()].map(message => ({ ...message }));
  while (observedMessages.length > observedLimit) {
    observedMessages.shift();
  }

  const nextState = {
    observedMessages,
    nextPacketNumber,
    pendingPacket,
  };

  return { packet, pendingPacket, state: nextState };
}
