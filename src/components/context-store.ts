export interface ContextMessage {
  messageId: string;
  message: string;
  sender?: string;
  mention?: boolean;
  [key: string]: unknown;
}

export interface ContextStore {
  add(incomingMessages: ContextMessage[]): void;
  clear(): void;
  getRecent(limit: number): ContextMessage[];
  getState(): { maxMessages: number; size: number; messageIds: string[] };
}

function cloneMessage(message: ContextMessage): ContextMessage {
  return structuredClone(message);
}

function validateMessage(message: ContextMessage): void {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      typeof message.messageId !== 'string' || !message.messageId ||
      typeof message.message !== 'string') {
    throw new TypeError('Each message must include a non-empty messageId and message string.');
  }
  if (message.mention !== undefined && typeof message.mention !== 'boolean') {
    throw new TypeError('The optional mention property must be a boolean.');
  }
}

export function createContextStore({ maxMessages = 60 }: { maxMessages?: number } = {}): ContextStore {
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError('maxMessages must be a positive integer.');
  }

  const messages: ContextMessage[] = [];
  const messagesById = new Map<string, ContextMessage>();

  return {
    add(incomingMessages) {
      if (!Array.isArray(incomingMessages)) {
        throw new TypeError('messages must be an array.');
      }

      const validatedMessages = incomingMessages.map(message => {
        validateMessage(message);
        return message;
      });

      for (const message of validatedMessages) {
        const existing = messagesById.get(message.messageId);
        if (existing) {
          if (existing.message !== message.message) {
            const updatedMessage = cloneMessage(message);
            const existingIndex = messages.indexOf(existing);
            if (existingIndex !== -1) {
              messages[existingIndex] = updatedMessage;
            }
            messagesById.set(updatedMessage.messageId, updatedMessage);
          }
          continue;
        }

        const retainedMessage = cloneMessage(message);
        messages.push(retainedMessage);
        messagesById.set(retainedMessage.messageId, retainedMessage);

        if (messages.length > maxMessages) {
          const evictedMessage = messages.shift();
          messagesById.delete(evictedMessage!.messageId);
        }
      }
    },
    clear() {
      messages.length = 0;
      messagesById.clear();
    },
    getRecent(limit) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new TypeError('limit must be a non-negative integer.');
      }
      return messages.slice(Math.max(0, messages.length - limit)).map(cloneMessage);
    },
    getState() {
      return {
        maxMessages,
        size: messages.length,
        messageIds: messages.map(message => message.messageId),
      };
    },
  };
}
