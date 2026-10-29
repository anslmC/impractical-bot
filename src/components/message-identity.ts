import { createHash } from 'node:crypto';

// Messenger can expose one logical message under more than one
// `data-message-id`. A live smoke test showed the same reply retained twice in
// the Context Store: once under a numeric id and once under a `mid.$...` id.
// Both are per-message ids in different namespaces (the sender-side echo and the
// server-side id), so treating every `data-message-id` as a separate message
// turns one reply into two Context Store records, two assistant turns in the
// NVIDIA request, and — for an incoming mention — a second packet and a second
// reply.
//
// Reconciliation is deliberately narrow so it can never remove a legitimate
// message. Two observed records are the same logical message only when they are
// adjacent in rendered order, share sender, direction and text, and their ids
// come from *different* id namespaces. A legitimate repeated message is rendered
// in one namespace, so it stays a distinct message.

export type MessageIdNamespace = 'numeric' | 'mid' | 'other';

const NUMERIC_MESSAGE_ID = /^\d+$/;
const MID_MESSAGE_ID = /^mid\.\S+$/;

export function getMessageIdNamespace(messageId: string): MessageIdNamespace {
  const trimmed = typeof messageId === 'string' ? messageId.trim() : '';
  if (NUMERIC_MESSAGE_ID.test(trimmed)) {
    return 'numeric';
  }
  if (MID_MESSAGE_ID.test(trimmed)) {
    return 'mid';
  }
  return 'other';
}

export interface IdentifiableMessage {
  messageId: string;
  message: string;
  sender?: unknown;
  direction?: unknown;
}

function normalizedField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSameLogicalMessage(
  left: IdentifiableMessage,
  right: IdentifiableMessage,
): boolean {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') {
    return false;
  }
  if (typeof left.messageId !== 'string' || typeof right.messageId !== 'string') {
    return false;
  }
  if (!left.messageId || !right.messageId || left.messageId === right.messageId) {
    return false;
  }
  if (typeof left.message !== 'string' || typeof right.message !== 'string') {
    return false;
  }
  const text = left.message.trim();
  if (!text || text !== right.message.trim()) {
    return false;
  }
  // Direction is what makes a record a conversation turn. Without a known
  // direction there is nothing to reconcile, and a duplicate must never be
  // inferred across a sender change.
  const direction = normalizedField(left.direction);
  if (direction !== 'INCOMING' && direction !== 'OUTGOING') {
    return false;
  }
  if (direction !== normalizedField(right.direction)) {
    return false;
  }
  if (normalizedField(left.sender) !== normalizedField(right.sender)) {
    return false;
  }
  const leftNamespace = getMessageIdNamespace(left.messageId);
  const rightNamespace = getMessageIdNamespace(right.messageId);
  return leftNamespace !== 'other' &&
    rightNamespace !== 'other' &&
    leftNamespace !== rightNamespace;
}

export function fingerprintMessageText(message: string): string {
  return createHash('sha1').update(message).digest('hex').slice(0, 12);
}

export interface DuplicateMessageRecord {
  observedMessageId: string;
  canonicalMessageId: string;
  direction: 'INCOMING' | 'OUTGOING';
  sender: string;
  message: string;
}

export interface ReconciledMessages<T extends IdentifiableMessage> {
  messages: T[];
  duplicates: DuplicateMessageRecord[];
}

export interface MessageIdentityTracker {
  reconcile<T extends IdentifiableMessage>(messages: readonly T[]): ReconciledMessages<T>;
  clear(): void;
}

const DEFAULT_MAX_TRACKED_ALIASES = 256;

export function createMessageIdentityTracker({
  maxAliases = DEFAULT_MAX_TRACKED_ALIASES,
}: { maxAliases?: number } = {}): MessageIdentityTracker {
  if (!Number.isInteger(maxAliases) || maxAliases < 1) {
    throw new TypeError('maxAliases must be a positive integer.');
  }

  // Observed id -> canonical id. Kept for the conversation so a copy that was
  // already merged cannot become "new work" again on a later poll if the DOM
  // keeps only the other representation.
  const aliases = new Map<string, string>();

  const resolve = (messageId: string): string => {
    let current = messageId;
    const visited = new Set<string>();
    while (aliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = aliases.get(current)!;
    }
    return current;
  };

  const remember = (observedMessageId: string, canonicalMessageId: string): void => {
    if (observedMessageId === canonicalMessageId || aliases.has(observedMessageId)) {
      return;
    }
    aliases.set(observedMessageId, canonicalMessageId);
    while (aliases.size > maxAliases) {
      const oldestObservedId = aliases.keys().next().value;
      if (oldestObservedId === undefined) {
        break;
      }
      aliases.delete(oldestObservedId);
    }
  };

  return {
    reconcile<T extends IdentifiableMessage>(messages: readonly T[]): ReconciledMessages<T> {
      if (!Array.isArray(messages)) {
        throw new TypeError('messages must be an array.');
      }

      const reconciled: T[] = [];
      const duplicates: DuplicateMessageRecord[] = [];
      const emittedMessageIds = new Set<string>();
      let previous: IdentifiableMessage | null = null;

      for (const message of messages) {
        if (!message || typeof message !== 'object' ||
            typeof message.messageId !== 'string' || !message.messageId) {
          throw new TypeError('Each message must include a non-empty messageId string.');
        }

        const observedMessageId = message.messageId;
        const knownCanonicalId = resolve(observedMessageId);
        let canonicalMessageId = knownCanonicalId;

        if (canonicalMessageId === observedMessageId &&
            previous !== null &&
            isSameLogicalMessage(previous, message)) {
          canonicalMessageId = previous.messageId;
        }

        const newlyLearned = canonicalMessageId !== observedMessageId &&
          knownCanonicalId === observedMessageId;
        if (canonicalMessageId !== observedMessageId) {
          remember(observedMessageId, canonicalMessageId);
          if (newlyLearned) {
            duplicates.push({
              observedMessageId,
              canonicalMessageId,
              direction: normalizedField(message.direction) === 'OUTGOING'
                ? 'OUTGOING'
                : 'INCOMING',
              sender: normalizedField(message.sender),
              message: message.message,
            });
          }
        }

        if (emittedMessageIds.has(canonicalMessageId)) {
          // The other namespace's copy of a message already emitted in this
          // snapshot. One snapshot never contains the same logical message twice.
          continue;
        }
        emittedMessageIds.add(canonicalMessageId);

        const trackedMessage = canonicalMessageId === observedMessageId
          ? { ...message }
          : { ...message, messageId: canonicalMessageId };
        reconciled.push(trackedMessage);
        previous = trackedMessage;
      }

      return { messages: reconciled, duplicates };
    },
    clear() {
      aliases.clear();
    },
  };
}
