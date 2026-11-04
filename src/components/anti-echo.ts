import { extractConversationMessageBody } from './conversation-context.js';

export interface AntiEchoMessage {
  message: string;
  messageId?: string;
  direction?: unknown;
  sender?: unknown;
  replyBatchId?: unknown;
}

export const ANTI_ECHO_RETRY_INSTRUCTION =
  'Your previous draft repeated the incoming message instead of answering it, so it was rejected. ' +
  'Write a different, conversational reply to the latest incoming message, in your own words. ' +
  'Do not copy, quote, restate, translate, or continue that message, do not prepend a participant ' +
  'name, and do not write a "Name: message" line: respond as yourself instead of continuing the ' +
  'transcript.';

export const SELF_REPETITION_RETRY_INSTRUCTION =
  'Your previous draft repeated something you already said in this conversation, so it was rejected. ' +
  'Write a different reply that responds to the latest incoming message and moves the conversation ' +
  'forward. Do not reuse, paraphrase, or send the same reply again, and do not merely repeat the ' +
  'same question or offer.';

const COMMON_SHORT_REPLY_PHRASES = new Set([
  'no way',
  'oh no',
  'i know',
  'for real',
  'me too',
  'you too',
  'sounds good',
  'that sucks',
]);

const PARTICIPANT_PREFIX =
  /^\s*@?(\p{L}[\p{L}\p{N}._'’@-]*(?:\s+\p{L}[\p{L}\p{N}._'’@-]*){0,2})\s*[:：]\s*/u;
const LEADING_MENTION = /^@[\p{L}\p{N}_.-]+\s*/u;
const TRAILING_PUNCTUATION = /[\s.!?,;:…~"'“”‘’`*_\-–—()[\]{}<>/\\|]+$/u;
const TRAILING_EMOJI =
  /[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\u{20E3}\p{Regional_Indicator}]+$/u;

export interface EchoNormalizationOptions {
  participantNames?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeParticipantName(name: string): string {
  return name.trim().replace(/^@+/u, '').replace(/\s+/gu, ' ');
}

function stripParticipantPrefix(
  text: string,
  participantNames: readonly string[],
): string {
  const knownNames = participantNames
    .map(normalizeParticipantName)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const name of knownNames) {
    const pattern = new RegExp(
      `^\\s*@?${escapeRegExp(name).replace(/\s+/gu, '\\s+')}` +
        `(?![\\p{L}\\p{N}_])\\s*[:：]\\s*`,
      'iu',
    );
    if (pattern.test(text)) {
      return text.replace(pattern, '');
    }
  }
  return text.replace(PARTICIPANT_PREFIX, '');
}

function stripLeadingMentions(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    const next = current.replace(LEADING_MENTION, '').trim();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

export function normalizeForEchoComparison(
  text: string,
  { participantNames = [] }: EchoNormalizationOptions = {},
): string {
  if (typeof text !== 'string') {
    return '';
  }
  let normalized = extractConversationMessageBody(text).text.normalize('NFKC').trim();
  normalized = stripParticipantPrefix(normalized, participantNames);
  normalized = stripLeadingMentions(normalized);
  normalized = normalized.replace(/\s+/gu, ' ').trim();
  for (;;) {
    const next = normalized
      .replace(TRAILING_EMOJI, '')
      .replace(TRAILING_PUNCTUATION, '')
      .trim();
    if (next === normalized) {
      break;
    }
    normalized = next;
  }
  return normalized.toLocaleLowerCase();
}

function tokenizeNormalized(normalized: string): string[] {
  return normalized
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

function containsTokenSequence(
  longer: readonly string[],
  shorter: readonly string[],
): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) {
    return false;
  }
  for (let start = 0; start <= longer.length - shorter.length; start += 1) {
    if (shorter.every((token, offset) => longer[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

function diceCoefficient(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const token of left) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let overlap = 0;
  for (const token of right) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

export function isEchoReply(
  reply: string,
  incoming: string,
  options: EchoNormalizationOptions = {},
): boolean {
  const normalizedIncoming = normalizeForEchoComparison(incoming, options);
  if (!normalizedIncoming) {
    return false;
  }
  const normalizedReply = normalizeForEchoComparison(reply, options);
  if (normalizedReply === normalizedIncoming) {
    return true;
  }

  const incomingTokens = tokenizeNormalized(normalizedIncoming);
  const replyTokens = tokenizeNormalized(normalizedReply);
  if (incomingTokens.length >= 3 && replyTokens.length >= 3) {
    if (replyTokens.length >= incomingTokens.length &&
        replyTokens.length - incomingTokens.length <= 2 &&
        containsTokenSequence(replyTokens, incomingTokens)) {
      return true;
    }
    if (Math.abs(replyTokens.length - incomingTokens.length) <= 1 &&
        diceCoefficient(incomingTokens, replyTokens) >= 0.8) {
      return true;
    }
  }
  return false;
}

export function isSelfRepetitionReply(
  reply: string,
  recentReplies: readonly (string | AntiEchoMessage)[],
  options: EchoNormalizationOptions = {},
): boolean {
  const normalizedReply = normalizeForEchoComparison(reply, options);
  const replyTokens = tokenizeNormalized(normalizedReply);
  if (replyTokens.length < 2) {
    return false;
  }
  if (COMMON_SHORT_REPLY_PHRASES.has(normalizedReply)) {
    return false;
  }
  return recentReplies.some(candidate => {
    const text = typeof candidate === 'string' ? candidate : candidate.message;
    const normalizedCandidate = normalizeForEchoComparison(text, options);
    if (!normalizedCandidate) {
      return false;
    }
    if (normalizedCandidate === normalizedReply) {
      return replyTokens.length >= 3 || reply.trim().endsWith('?');
    }
    const candidateTokens = tokenizeNormalized(normalizedCandidate);
    return replyTokens.length >= 4 &&
      candidateTokens.length >= 4 &&
      Math.abs(replyTokens.length - candidateTokens.length) <= 2 &&
      diceCoefficient(replyTokens, candidateTokens) >= 0.8;
  });
}

export function collectRecentAssistantMessages(
  messages: readonly AntiEchoMessage[],
  limit = 3,
): AntiEchoMessage[] {
  const collected: AntiEchoMessage[] = [];
  const seenBatches = new Set<string>();
  let groups = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.direction !== 'OUTGOING' ||
        typeof message.message !== 'string' ||
        message.message.trim().length === 0) {
      continue;
    }
    const batchId = typeof message.replyBatchId === 'string' &&
      message.replyBatchId.trim().length > 0
      ? message.replyBatchId
      : null;
    if (batchId !== null && seenBatches.has(batchId)) {
      collected.push(message);
      continue;
    }
    if (groups >= limit) {
      continue;
    }
    if (batchId !== null) {
      seenBatches.add(batchId);
    }
    groups += 1;
    collected.push(message);
  }
  return collected;
}

export function findLatestIncomingMessage(
  messages: readonly AntiEchoMessage[],
): AntiEchoMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.direction === 'INCOMING' &&
        typeof message.message === 'string' &&
        message.message.trim().length > 0) {
      return message;
    }
  }
  return null;
}

export function collectParticipantNames({
  messages,
  names = [],
}: {
  messages: readonly AntiEchoMessage[];
  names?: readonly string[];
}): string[] {
  const collected = new Set<string>();
  for (const name of names) {
    const normalized = normalizeParticipantName(name);
    if (normalized) {
      collected.add(normalized);
    }
  }
  for (const message of messages) {
    if (typeof message.sender !== 'string') {
      continue;
    }
    const normalized = normalizeParticipantName(message.sender);
    if (normalized && normalized.toUpperCase() !== 'UNKNOWN') {
      collected.add(normalized);
    }
  }
  return [...collected];
}

export class AntiEchoSuppressedError extends Error {
  constructor(message = 'An echoed reply was suppressed after one retry.') {
    super(message);
    this.name = 'AntiEchoSuppressedError';
  }
}

export type AntiEchoRetryReason = 'repeat-echo' | 'repeat-self';

export interface AntiEchoGuardOptions<Reply> {
  generate: (attempt: {
    retry: boolean;
    reason?: AntiEchoRetryReason | 'multiple';
  }) => Promise<Reply>;
  isEcho: (reply: Reply) => boolean;
  isRepeat?: (reply: Reply) => boolean;
  log?: (message: string) => void;
}

export type AntiEchoGuardResult<Reply> =
  | { status: 'accepted'; reply: Reply; attempts: 1 | 2 }
  | { status: 'suppressed'; reason: 'repeat-echo' | 'repeat-self'; attempts: 2 };

export async function generateReplyWithAntiEchoGuard<Reply>({
  generate,
  isEcho,
  isRepeat,
  log,
}: AntiEchoGuardOptions<Reply>): Promise<AntiEchoGuardResult<Reply>> {
  const firstReply = await generate({ retry: false });
  const firstEcho = isEcho(firstReply);
  const firstRepeat = isRepeat?.(firstReply) ?? false;
  if (!firstEcho && !firstRepeat) {
    return { status: 'accepted', reply: firstReply, attempts: 1 };
  }
  if (firstEcho) {
    log?.(
      'Rejected a reply that echoed the incoming message; retrying once with an ' +
        'anti-echo instruction.',
    );
  }
  if (firstRepeat) {
    log?.(
      'Rejected a reply that repeated an earlier reply; retrying once with a ' +
        'self-repetition instruction.',
    );
  }
  const reason: AntiEchoRetryReason | 'multiple' = firstEcho && firstRepeat
    ? 'multiple'
    : firstEcho
      ? 'repeat-echo'
      : 'repeat-self';

  const retryReply = await generate({ retry: true, reason });
  const retryEcho = isEcho(retryReply);
  const retryRepeat = isRepeat?.(retryReply) ?? false;
  if (!retryEcho && !retryRepeat) {
    return { status: 'accepted', reply: retryReply, attempts: 2 };
  }
  return {
    status: 'suppressed',
    reason: firstEcho || retryEcho ? 'repeat-echo' : 'repeat-self',
    attempts: 2,
  };
}
