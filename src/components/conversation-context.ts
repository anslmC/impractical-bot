import type { MessageTimestamp } from './backread.js';
import type { MessageTargetKind, MessageTargetingContext } from './message-targeting.js';

export type ConversationDirection = 'INCOMING' | 'OUTGOING' | 'UNKNOWN';

export interface ConversationMessage {
  id?: string;
  messageId?: string;
  timestamp?: MessageTimestamp | null;
  sender?: unknown;
  direction?: unknown;
  message: string;
  ariaLabel?: string | null;
}

export interface ConversationTriggerInfo {
  messageId: string | null;
  timestamp: MessageTimestamp | null;
  sender: string;
  participant: string;
  direction: ConversationDirection;
  addressedTo: string | null;
  targetKind: MessageTargetKind | null;
  text: string;
  presentInHistory: boolean;
}

export interface ConversationMessageHeader {
  id: string | null;
  timestamp: MessageTimestamp | null;
  sender: string;
  participant: string;
  direction: ConversationDirection;
  addressedTo: string | null;
  isTrigger: boolean;
}

export const CURRENT_TRIGGER_INSTRUCTION_MARKER = 'CURRENT TRIGGER';
export const CONVERSATION_METADATA_RETRY_INSTRUCTION =
  'Your previous draft included a [MESSAGE ...] transcript envelope instead of only the reply text. ' +
  'Return only the final message to send, with no message id, timestamp, sender, participant, ' +
  'direction, addressed_to, trigger, bracket header, or other metadata. ' +
  'Do not use emojis, emoticons, pictographs, flags, or decorative symbols.';

export function resolveConversationMessageId(
  message: ConversationMessage,
): string | null {
  const id = typeof message.messageId === 'string'
    ? message.messageId
    : typeof message.id === 'string'
      ? message.id
      : '';
  const trimmed = id.trim();
  return trimmed || null;
}

export function normalizeConversationDirection(
  value: unknown,
): ConversationDirection {
  if (typeof value !== 'string') {
    return 'UNKNOWN';
  }
  const normalized = value.trim().toUpperCase();
  return normalized === 'INCOMING' || normalized === 'OUTGOING'
    ? normalized
    : 'UNKNOWN';
}

export function normalizeConversationSender(value: unknown): string {
  if (typeof value !== 'string') {
    return 'UNKNOWN';
  }
  const trimmed = value.trim();
  return trimmed || 'UNKNOWN';
}

export function formatConversationTimestamp(
  timestamp: MessageTimestamp | null | undefined,
): string {
  const normalized = timestamp?.normalized?.trim();
  if (normalized) {
    return normalized;
  }
  const original = timestamp?.original?.trim();
  return original || 'unknown';
}

export function participantLabelForSender(
  sender: string,
  fallback: string,
): string {
  return sender && sender !== 'UNKNOWN' ? sender : fallback;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export function serializeConversationMessage(
  header: ConversationMessageHeader,
  text: string,
): string {
  const fields = [
    `id=${quoted(header.id ?? 'unavailable')}`,
    `time=${quoted(formatConversationTimestamp(header.timestamp))}`,
    `sender=${quoted(header.sender)}`,
    `participant=${quoted(header.participant)}`,
    `direction=${header.direction}`,
  ];
  if (header.addressedTo) {
    fields.push(`addressed_to=${quoted(header.addressedTo)}`);
  }
  if (header.isTrigger) {
    fields.push('trigger=true');
  }
  return `[MESSAGE ${fields.join(' ')}]\n${text}`;
}

const CONVERSATION_MESSAGE_ENVELOPE_PATTERN =
  /^\s*\[MESSAGE\s+id="(?:[^"\\]|\\.)*"\s+time="(?:[^"\\]|\\.)*"\s+sender="(?:[^"\\]|\\.)*"\s+participant="(?:[^"\\]|\\.)*"\s+direction=(?:INCOMING|OUTGOING|UNKNOWN)(?:\s+addressed_to="(?:[^"\\]|\\.)*")?(?:\s+trigger=true)?\]\s*(?:\r?\n)?/u;

export interface ConversationMessageEnvelopeExtraction {
  text: string;
  hadEnvelope: boolean;
}

export function extractConversationMessageBody(
  text: string,
): ConversationMessageEnvelopeExtraction {
  if (typeof text !== 'string') {
    return { text: '', hadEnvelope: false };
  }
  const match = CONVERSATION_MESSAGE_ENVELOPE_PATTERN.exec(text);
  if (!match) {
    return { text, hadEnvelope: false };
  }
  return {
    text: text.slice(match[0].length).trim(),
    hadEnvelope: true,
  };
}

export function targetingForTrigger(
  targeting: MessageTargetingContext | undefined,
  triggerId: string | null,
): MessageTargetingContext | null {
  if (!targeting) {
    return null;
  }
  if (targeting.messageId && triggerId && targeting.messageId !== triggerId) {
    return null;
  }
  return targeting;
}

export function appendCurrentTriggerInstruction(
  systemInstruction: string,
  trigger: ConversationTriggerInfo,
): string {
  const section = buildCurrentTriggerInstruction(trigger);
  const markerIndex = systemInstruction.search(
    /(?:^|\n)CURRENT TRIGGER\n/u,
  );
  const base = markerIndex === -1
    ? systemInstruction.trimEnd()
    : systemInstruction.slice(0, markerIndex).trimEnd();
  return `${base}\n\n${section}`;
}

export function buildCurrentTriggerInstruction(
  trigger: ConversationTriggerInfo,
): string {
  const position = trigger.presentInHistory
    ? 'present in the conversation history; the entry marked trigger=true is this exact message'
    : 'outside the recent conversation history; messages in the history occurred after this trigger';
  const addressedTo = trigger.addressedTo ?? 'not confidently identified';
  const targetKind = trigger.targetKind ?? 'not classified';

  return [
    'CURRENT TRIGGER',
    'A trigger is the message that caused this reply opportunity. It is not necessarily the newest message in the transcript.',
    `MESSAGE ID: ${trigger.messageId ?? 'unavailable'}`,
    `TIME: ${formatConversationTimestamp(trigger.timestamp)}`,
    `SENDER: ${trigger.sender}`,
    `PARTICIPANT: ${trigger.participant}`,
    `DIRECTION: ${trigger.direction}`,
    `ADDRESSED TO: ${addressedTo}`,
    `TARGET: ${targetKind}`,
    `HISTORY POSITION: ${position}`,
    'TEXT:',
    trigger.text,
  ].join('\n');
}
