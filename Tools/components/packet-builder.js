function createPacketBuilderState() {
  return {
    observedMessages: [],
    nextPacketNumber: 1,
    pendingPacket: null,
  };
}

function normalizeMessage(message) {
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

function assertMatchingContent(existing, incoming) {
  if (existing.message !== incoming.message) {
    throw new Error(`Message ID ${incoming.messageId} was observed with different content.`);
  }
}

function buildPacketTurn({
  newMessages,
  recentContext = [],
  state = createPacketBuilderState(),
}) {
  if (!Array.isArray(newMessages) || !Array.isArray(recentContext)) {
    throw new TypeError('newMessages and recentContext must be arrays.');
  }
  if (!state || !Array.isArray(state.observedMessages) ||
      !Number.isInteger(state.nextPacketNumber) || state.nextPacketNumber < 1) {
    throw new TypeError('state must be created by createPacketBuilderState().');
  }

  const observedById = new Map(
    state.observedMessages.map(message => [message.messageId, { ...message }]),
  );
  const messagesById = new Map();
  const uniqueNewMessages = [];

  for (const rawMessage of newMessages) {
    const message = normalizeMessage(rawMessage);
    const inBatch = messagesById.get(message.messageId);
    if (inBatch) {
      assertMatchingContent(inBatch, message);
      inBatch.mention ||= message.mention;
      continue;
    }

    const previouslyObserved = observedById.get(message.messageId);
    if (previouslyObserved) {
      assertMatchingContent(previouslyObserved, message);
      continue;
    }

    messagesById.set(message.messageId, message);
    uniqueNewMessages.push(message);
    observedById.set(message.messageId, { ...message });
  }

  const contextById = new Map();
  for (const rawMessage of recentContext) {
    const message = normalizeMessage(rawMessage);
    const inContext = contextById.get(message.messageId);
    if (inContext) {
      assertMatchingContent(inContext, message);
      continue;
    }

    const inBatch = messagesById.get(message.messageId);
    if (inBatch) {
      assertMatchingContent(inBatch, message);
      continue;
    }

    contextById.set(message.messageId, message);
    const previouslyObserved = observedById.get(message.messageId);
    if (previouslyObserved) {
      assertMatchingContent(previouslyObserved, message);
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
      ...uniqueNewMessages.filter(message => message.mention).map(message => ({ ...message })),
    );
    packet = pendingPacket;
    pendingPacket = null;
  } else if (uniqueNewMessages.some(message => message.mention)) {
    pendingPacket = {
      packetId: `packet-${String(nextPacketNumber).padStart(3, '0')}`,
      newMessages: uniqueNewMessages.map(message => ({ ...message })),
      mentionMessages: uniqueNewMessages
        .filter(message => message.mention)
        .map(message => ({ ...message })),
      contextMessages: [...contextById.values()].map(message => ({ ...message })),
    };
    nextPacketNumber += 1;
  }

  const nextState = {
    observedMessages: [...observedById.values()].map(message => ({ ...message })),
    nextPacketNumber,
    pendingPacket,
  };

  return { packet, pendingPacket, state: nextState };
}

module.exports = { buildPacketTurn, createPacketBuilderState };