import { createHash } from 'node:crypto';

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
  timestamp?: unknown;
}

function normalizedField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedTimestamp(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const timestamp = value as Record<string, unknown>;
  return normalizedField(timestamp.normalized) || normalizedField(timestamp.original);
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
  const leftTimestamp = normalizedTimestamp(left.timestamp);
  const rightTimestamp = normalizedTimestamp(right.timestamp);
  if (leftTimestamp && rightTimestamp && leftTimestamp !== rightTimestamp) {
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

export interface ReconciledMessageEdit {
  observedMessageId: string;
  previousPhysicalMessageId: string;
  canonicalMessageId: string;
  sender: string;
  direction: 'INCOMING' | 'OUTGOING';
  matchSignals: string[];
  previousMessage: string;
  updatedMessage: string;
  confidence: string;
}

export interface MessageIdentityDiagnostics {
  candidates: number;
  reconciled: number;
  rejected: number;
  ambiguous: number;
  invalid: number;
  duplicatesSuppressed: number;
}

export interface ReconciledMessages<T extends IdentifiableMessage> {
  messages: T[];
  duplicates: DuplicateMessageRecord[];
  reconciledEdits: ReconciledMessageEdit[];
  diagnostics: MessageIdentityDiagnostics;
}

export interface MessageObservationMetadata {
  timestamp?: unknown;
}

export interface ReconcileOptions {
  observations?: readonly (MessageObservationMetadata | undefined)[];
}

export interface MessageIdentityTracker {
  reconcile<T extends IdentifiableMessage>(
    messages: readonly T[],
    options?: ReconcileOptions,
  ): ReconciledMessages<T>;
  clear(): void;
}

const DEFAULT_MAX_TRACKED_ALIASES = 256;
const DEFAULT_MAX_RECENT_MESSAGES = 128;
const EDIT_OBSERVATION_WINDOW = 3;

interface ObservationRecord {
  sequence: number;
  index: number;
  previousMessageId: string | null;
  nextMessageId: string | null;
  timestamp: string;
  lastPhysicalMessageId: string;
}

interface EditObservation {
  sequence: number;
  index: number;
  previousMessageId: string | null;
  nextMessageId: string | null;
  timestamp: string;
}

interface EditCandidateEvaluation {
  candidate: IdentifiableMessage;
  record: ObservationRecord;
  confident: boolean;
  timestampCompatible: boolean;
  matchSignals: string[];
  confidence: string;
}

function boundedIdentityPreview(text: unknown, limit = 80): string {
  const value = typeof text === 'string' ? text : '';
  const truncated = value.length > limit ? `${value.slice(0, limit)}...` : value;
  return JSON.stringify(truncated);
}

export function formatReconciledEditDiagnostic(edit: ReconciledMessageEdit): string {
  return 'MESSAGE_EDIT_RECONCILED | ' +
    `previous=${edit.previousPhysicalMessageId} ` +
    `replacement=${edit.observedMessageId} ` +
    `canonical=${edit.canonicalMessageId} ` +
    `sender=${boundedIdentityPreview(edit.sender, 40)} ` +
    `direction=${edit.direction} ` +
    `signals=${edit.matchSignals.join(',')} ` +
    `confidence=${edit.confidence} ` +
    `before=${boundedIdentityPreview(edit.previousMessage)} ` +
    `after=${boundedIdentityPreview(edit.updatedMessage)}`;
}

export function formatMessageIdentitySummary(
  diagnostics: MessageIdentityDiagnostics,
): string | null {
  const total = diagnostics.candidates +
    diagnostics.reconciled +
    diagnostics.rejected +
    diagnostics.ambiguous +
    diagnostics.invalid +
    diagnostics.duplicatesSuppressed;
  if (total === 0) {
    return null;
  }
  return 'MESSAGE IDENTITY SUMMARY | ' +
    `candidates=${diagnostics.candidates} ` +
    `reconciled=${diagnostics.reconciled} ` +
    `rejected=${diagnostics.rejected} ` +
    `ambiguous=${diagnostics.ambiguous} ` +
    `invalid=${diagnostics.invalid} ` +
    `duplicates_suppressed=${diagnostics.duplicatesSuppressed}`;
}

function isLikelyTextEdit(before: string, after: string): boolean {
  const left = before.toLowerCase().replace(/\s+/gu, ' ').trim();
  const right = after.toLowerCase().replace(/\s+/gu, ' ').trim();
  if (!left || !right || left === right) {
    return false;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 3 && longer.includes(shorter);
}

export function createMessageIdentityTracker({
  maxAliases = DEFAULT_MAX_TRACKED_ALIASES,
  maxRecentMessages = DEFAULT_MAX_RECENT_MESSAGES,
}: {
  maxAliases?: number;
  maxRecentMessages?: number;
} = {}): MessageIdentityTracker {
  if (!Number.isInteger(maxAliases) || maxAliases < 1) {
    throw new TypeError('maxAliases must be a positive integer.');
  }
  if (!Number.isInteger(maxRecentMessages) || maxRecentMessages < 1) {
    throw new TypeError('maxRecentMessages must be a positive integer.');
  }

  const aliases = new Map<string, string>();
  const canonicalAliasCounts = new Map<string, number>();
  const recentCanonical: IdentifiableMessage[] = [];
  const observationsById = new Map<string, ObservationRecord>();
  let reconcileSequence = 0;

  const canonicalHasAlias = (messageId: string): boolean =>
    (canonicalAliasCounts.get(messageId) ?? 0) > 0;

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
    const target = resolve(canonicalMessageId);
    if (target === observedMessageId) {
      return;
    }
    aliases.set(observedMessageId, target);
    canonicalAliasCounts.set(
      target,
      (canonicalAliasCounts.get(target) ?? 0) + 1,
    );
    while (aliases.size > maxAliases) {
      const oldestObservedId = aliases.keys().next().value;
      if (oldestObservedId === undefined) {
        break;
      }
      const evictedCanonicalId = aliases.get(oldestObservedId);
      aliases.delete(oldestObservedId);
      if (evictedCanonicalId !== undefined) {
        const remaining = (canonicalAliasCounts.get(evictedCanonicalId) ?? 1) - 1;
        if (remaining > 0) {
          canonicalAliasCounts.set(evictedCanonicalId, remaining);
        } else {
          canonicalAliasCounts.delete(evictedCanonicalId);
        }
      }
    }
  };

  const rememberRecent = (message: IdentifiableMessage): void => {
    const existingIndex = recentCanonical.findIndex(
      candidate => candidate.messageId === message.messageId,
    );
    if (existingIndex !== -1) {
      recentCanonical.splice(existingIndex, 1);
    }
    recentCanonical.push({ ...message });
    while (recentCanonical.length > maxRecentMessages) {
      const evicted = recentCanonical.shift();
      if (evicted) {
        observationsById.delete(resolve(evicted.messageId));
      }
    }
  };

  const findPreviouslyObservedCopy = (
    message: IdentifiableMessage,
    renderedCanonicalIds: ReadonlySet<string>,
  ): IdentifiableMessage | null => {
    for (let index = recentCanonical.length - 1; index >= 0; index -= 1) {
      const candidate = recentCanonical[index];
      if (renderedCanonicalIds.has(candidate.messageId) ||
          canonicalHasAlias(candidate.messageId)) {
        continue;
      }
      if (isSameLogicalMessage(candidate, message)) {
        return candidate;
      }
    }
    return null;
  };

  const evaluateNeighborEvidence = (
    record: ObservationRecord,
    observation: EditObservation,
  ): { confident: boolean; used: boolean } => {
    const oldPrevious = record.previousMessageId === null
      ? null
      : resolve(record.previousMessageId);
    const oldNext = record.nextMessageId === null
      ? null
      : resolve(record.nextMessageId);
    const currentPrevious = observation.previousMessageId === null
      ? null
      : resolve(observation.previousMessageId);
    const currentNext = observation.nextMessageId === null
      ? null
      : resolve(observation.nextMessageId);
    const oldHasNeighbor = oldPrevious !== null || oldNext !== null;
    if (!oldHasNeighbor) {
      return { confident: false, used: false };
    }
    const currentHasNeighbor = currentPrevious !== null || currentNext !== null;
    if (!currentHasNeighbor) {
      return { confident: false, used: true };
    }
    if ((oldPrevious === null) !== (currentPrevious === null) ||
        (oldNext === null) !== (currentNext === null)) {
      return { confident: false, used: true };
    }
    return {
      confident: oldPrevious === currentPrevious && oldNext === currentNext,
      used: true,
    };
  };

  const findChangedIdEditCandidate = (
    message: IdentifiableMessage,
    observation: EditObservation,
    renderedCanonicalIds: ReadonlySet<string>,
    diagnostics: MessageIdentityDiagnostics,
  ): EditCandidateEvaluation | null => {
    const text = typeof message.message === 'string' ? message.message.trim() : '';
    const direction = normalizedField(message.direction);
    if (!text || (direction !== 'INCOMING' && direction !== 'OUTGOING')) {
      return null;
    }
    const sender = normalizedField(message.sender);
    const currentTimestamp = observation.timestamp;
    const potential: EditCandidateEvaluation[] = [];

    for (let index = recentCanonical.length - 1; index >= 0; index -= 1) {
      const candidate = recentCanonical[index];
      const candidateCanonicalId = resolve(candidate.messageId);
      if (renderedCanonicalIds.has(candidateCanonicalId)) {
        continue;
      }
      const candidateText = typeof candidate.message === 'string'
        ? candidate.message.trim()
        : '';
      if (!candidateText || candidateText === text) {
        continue;
      }
      if (normalizedField(candidate.sender) !== sender ||
          normalizedField(candidate.direction) !== direction) {
        continue;
      }
      const record = observationsById.get(candidateCanonicalId);
      if (!record) {
        continue;
      }
      const observationAge = observation.sequence - record.sequence;
      if (observationAge < 1 || observationAge > EDIT_OBSERVATION_WINDOW) {
        continue;
      }
      if (Math.abs(record.index - observation.index) > 1) {
        continue;
      }

      const candidateTimestamp = record.timestamp;
      const timestampCompatible = !(candidateTimestamp &&
        currentTimestamp &&
        candidateTimestamp !== currentTimestamp);
      const neighborEvidence = evaluateNeighborEvidence(record, observation);
      const matchSignals = [
        'same-sender',
        'same-direction',
        'dom-position',
        'observation-proximity',
      ];
      if (candidateTimestamp && currentTimestamp) {
        matchSignals.push('timestamp-match');
      }
      if (neighborEvidence.confident) {
        matchSignals.push('stable-neighbors');
      }
      const strongMatch = timestampCompatible && neighborEvidence.confident;
      const weakMatch = timestampCompatible &&
        !neighborEvidence.used &&
        record.index === observation.index &&
        isLikelyTextEdit(candidateText, text);
      if (weakMatch) {
        matchSignals.push('text-edit-evidence');
      }
      potential.push({
        candidate,
        record,
        confident: strongMatch || weakMatch,
        timestampCompatible,
        matchSignals,
        confidence: strongMatch
          ? 'stable-neighbors'
          : weakMatch
            ? 'isolated-text-edit'
            : 'insufficient-evidence',
      });
    }

    if (potential.length === 0) {
      return null;
    }
    diagnostics.candidates += 1;
    const matches = potential.filter(candidate => candidate.confident);
    if (matches.length === 1) {
      diagnostics.reconciled += 1;
      return matches[0];
    }
    if (matches.length > 1 ||
        potential.filter(candidate => candidate.timestampCompatible).length > 1) {
      diagnostics.ambiguous += 1;
      return null;
    }
    diagnostics.rejected += 1;
    return null;
  };

  return {
    reconcile<T extends IdentifiableMessage>(
      messages: readonly T[],
      options: ReconcileOptions = {},
    ): ReconciledMessages<T> {
      if (!Array.isArray(messages)) {
        throw new TypeError('messages must be an array.');
      }

      reconcileSequence += 1;
      const diagnostics: MessageIdentityDiagnostics = {
        candidates: 0,
        reconciled: 0,
        rejected: 0,
        ambiguous: 0,
        invalid: 0,
        duplicatesSuppressed: 0,
      };
      const validEntries: Array<{
        message: T;
        inputIndex: number;
        index: number;
      }> = [];
      for (let inputIndex = 0; inputIndex < messages.length; inputIndex += 1) {
        const message = messages[inputIndex];
        if (!message || typeof message !== 'object' ||
            typeof message.messageId !== 'string' ||
            !message.messageId.trim() ||
            typeof message.message !== 'string') {
          diagnostics.invalid += 1;
          continue;
        }
        validEntries.push({
          message,
          inputIndex,
          index: validEntries.length,
        });
      }

      const reconciled: T[] = [];
      const duplicates: DuplicateMessageRecord[] = [];
      const reconciledEdits: ReconciledMessageEdit[] = [];
      const supportsEditObservation = Array.isArray(options.observations);
      const emittedMessageIds = new Set<string>();
      const pendingObservations = new Map<string, ObservationRecord>();
      const renderedCanonicalIds = new Set(
        validEntries.map(entry => resolve(entry.message.messageId)),
      );

      for (const entry of validEntries) {
        const { message, inputIndex, index } = entry;
        const observationMetadata = options.observations?.[inputIndex];
        const timestamp = normalizedTimestamp(observationMetadata?.timestamp) ||
          normalizedTimestamp(message.timestamp);
        const observation: EditObservation = {
          sequence: reconcileSequence,
          index,
          previousMessageId: index > 0
            ? validEntries[index - 1].message.messageId
            : null,
          nextMessageId: index + 1 < validEntries.length
            ? validEntries[index + 1].message.messageId
            : null,
          timestamp,
        };
        const observedMessageId = message.messageId;
        const knownCanonicalId = resolve(observedMessageId);
        let canonicalMessageId = knownCanonicalId;
        let editMatch: EditCandidateEvaluation | null = null;
        let newlyLearned = false;

        if (canonicalMessageId === observedMessageId) {
          for (let index = reconciled.length - 1; index >= 0; index -= 1) {
            const candidate = reconciled[index];
            if (canonicalHasAlias(candidate.messageId)) {
              continue;
            }
            if (isSameLogicalMessage(candidate, message)) {
              canonicalMessageId = candidate.messageId;
              break;
            }
          }
        }

        if (canonicalMessageId === observedMessageId) {
          const previouslyObserved = findPreviouslyObservedCopy(message, renderedCanonicalIds);
          if (previouslyObserved) {
            canonicalMessageId = previouslyObserved.messageId;
          }
        }

        const observedPreviously = recentCanonical.some(
          candidate => candidate.messageId === observedMessageId,
        );
        if (canonicalMessageId === observedMessageId &&
            !observedPreviously &&
            supportsEditObservation) {
          editMatch = findChangedIdEditCandidate(
            message,
            observation,
            renderedCanonicalIds,
            diagnostics,
          );
          if (editMatch) {
            canonicalMessageId = resolve(editMatch.candidate.messageId);
          }
        }

        newlyLearned = canonicalMessageId !== observedMessageId &&
          knownCanonicalId === observedMessageId;
        if (canonicalMessageId !== observedMessageId) {
          remember(observedMessageId, canonicalMessageId);
          if (newlyLearned && !editMatch) {
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

        if (editMatch && editMatch.candidate.message !== message.message) {
          reconciledEdits.push({
            observedMessageId,
            previousPhysicalMessageId: editMatch.record.lastPhysicalMessageId ||
              editMatch.candidate.messageId,
            canonicalMessageId,
            sender: normalizedField(message.sender),
            direction: normalizedField(message.direction) === 'OUTGOING'
              ? 'OUTGOING'
              : 'INCOMING',
            matchSignals: editMatch.matchSignals,
            previousMessage: editMatch.candidate.message,
            updatedMessage: message.message,
            confidence: editMatch.confidence,
          });
        }

        const trackedMessage = canonicalMessageId === observedMessageId
          ? { ...message }
          : { ...message, messageId: canonicalMessageId };
        pendingObservations.set(canonicalMessageId, {
          sequence: observation.sequence,
          index: observation.index,
          previousMessageId: observation.previousMessageId,
          nextMessageId: observation.nextMessageId,
          timestamp: observation.timestamp,
          lastPhysicalMessageId: observedMessageId,
        });

        if (emittedMessageIds.has(canonicalMessageId)) {
          if (!newlyLearned) {
            diagnostics.duplicatesSuppressed += 1;
          }
          continue;
        }
        emittedMessageIds.add(canonicalMessageId);
        reconciled.push(trackedMessage);
        rememberRecent(trackedMessage);
      }

      for (const [messageId, record] of pendingObservations) {
        observationsById.set(messageId, record);
      }
      diagnostics.duplicatesSuppressed += duplicates.length;
      return { messages: reconciled, duplicates, reconciledEdits, diagnostics };
    },
    clear() {
      aliases.clear();
      canonicalAliasCounts.clear();
      recentCanonical.length = 0;
      observationsById.clear();
      reconcileSequence = 0;
    },
  };
}
