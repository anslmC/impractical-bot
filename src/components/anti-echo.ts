export interface AntiEchoMessage {
  message: string;
  messageId?: string;
  direction?: unknown;
  sender?: unknown;
}

export const ANTI_ECHO_RETRY_INSTRUCTION =
  'Your previous draft repeated the incoming message instead of answering it, so it was rejected. ' +
  'Write a different, conversational reply to the latest incoming message, in your own words. ' +
  'Do not copy, quote, restate, translate, or continue that message, do not prepend a participant ' +
  'name, and do not write a "Name: message" line: respond as yourself instead of continuing the ' +
  'transcript.';

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
  let normalized = text.normalize('NFKC').trim();
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

export function isEchoReply(
  reply: string,
  incoming: string,
  options: EchoNormalizationOptions = {},
): boolean {
  const normalizedIncoming = normalizeForEchoComparison(incoming, options);
  if (!normalizedIncoming) {
    return false;
  }
  return normalizeForEchoComparison(reply, options) === normalizedIncoming;
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

export interface AntiEchoGuardOptions<Reply> {
  generate: (attempt: { retry: boolean }) => Promise<Reply>;
  isEcho: (reply: Reply) => boolean;
  log?: (message: string) => void;
}

export type AntiEchoGuardResult<Reply> =
  | { status: 'accepted'; reply: Reply; attempts: 1 | 2 }
  | { status: 'suppressed'; reason: 'repeat-echo'; attempts: 2 };

export async function generateReplyWithAntiEchoGuard<Reply>({
  generate,
  isEcho,
  log,
}: AntiEchoGuardOptions<Reply>): Promise<AntiEchoGuardResult<Reply>> {
  const firstReply = await generate({ retry: false });
  if (!isEcho(firstReply)) {
    return { status: 'accepted', reply: firstReply, attempts: 1 };
  }
  log?.(
    'Rejected a reply that echoed the incoming message; retrying once with an ' +
      'anti-echo instruction.',
  );

  const retryReply = await generate({ retry: true });
  if (!isEcho(retryReply)) {
    return { status: 'accepted', reply: retryReply, attempts: 2 };
  }
  return { status: 'suppressed', reason: 'repeat-echo', attempts: 2 };
}
