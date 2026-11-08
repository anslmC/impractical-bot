import { escapeRegExp } from './escape-regexp.js';

export interface SelfIdentity {
  name: string;
  aliases?: readonly string[];
}

export interface ReplyContextMessage {
  message: string;
  direction?: unknown;
}

const REPRODUCTION_CUE =
  /\b(?:say|saying|repeat|repeating|write|writing|quote|quoting|type|typing|send|sending|mention|mentioning|spell|spelling)\b/i;
const PROHIBITION_CUE =
  /\b(?:not|never|stop|dont|don't|doesn't|quit|anymore)\b|\bno more\b/i;
const CONTINUATION_CUE =
  /^(?:no,?\s+)?(?:again|repeat(?:\s+it)?|one more(?:\s+time)?|once more|say it again|do it again)\b/i;

function selfReferenceForms({ name, aliases = [] }: SelfIdentity): string[] {
  const forms = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    forms.add(trimmed);
    forms.add(trimmed.startsWith('@') ? trimmed.slice(1) : `@${trimmed}`);
  };

  add(name);
  for (const alias of aliases) {
    add(alias);
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

function participantForms(participantNames: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const participantName of participantNames) {
    const normalized = participantName
      .trim()
      .replace(/^@+/u, '')
      .replace(/\s+/gu, ' ');
    if (normalized) {
      forms.add(normalized);
    }
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

function mentionsAnyName(text: string, names: readonly string[]): boolean {
  const lowerText = text.toLowerCase();
  return names.some(name => lowerText.includes(name.toLowerCase()));
}

function requestsReproduction(text: string, names: readonly string[]): boolean {
  return REPRODUCTION_CUE.test(text) &&
    !PROHIBITION_CUE.test(text) &&
    mentionsAnyName(text, names);
}

function prohibitsNameReference(text: string): boolean {
  return PROHIBITION_CUE.test(text);
}

function isRequestedNameReference(
  names: readonly string[],
  messages: readonly ReplyContextMessage[],
): boolean {
  const incoming = messages
    .filter(message => message.direction === 'INCOMING' && message.message.trim())
    .map(message => message.message.trim());
  const latest = incoming.at(-1);
  if (!latest) {
    return false;
  }
  if (requestsReproduction(latest, names)) {
    return true;
  }
  if (prohibitsNameReference(latest)) {
    return false;
  }
  if (CONTINUATION_CUE.test(latest)) {
    const previous = incoming.at(-2);
    return previous !== undefined && requestsReproduction(previous, names);
  }
  return false;
}

export function stripSelfIdentifyingPrefix(
  reply: string,
  identity: SelfIdentity,
  messages: readonly ReplyContextMessage[] = [],
): string {
  const trimmedReply = reply.trim();
  const forms = selfReferenceForms(identity);
  if (!trimmedReply || isRequestedNameReference(forms, messages)) {
    return reply;
  }

  for (const form of forms) {
    const pattern = new RegExp(
      `^\\s*${escapeRegExp(form)}(?![A-Za-z0-9_])(?:\\s*[:,\\-–—]?\\s+|$)`,
      'i',
    );
    const match = pattern.exec(trimmedReply);
    if (!match) {
      continue;
    }
    const remainder = trimmedReply.slice(match[0].length).trim();
    if (!remainder) {
      return reply;
    }
    return remainder;
  }
  return reply;
}

const RECIPROCAL_QUESTION_PATTERNS = [
  /^(?:you|yourself)$/u,
  /^what about (?:you|yourself)$/u,
  /^how about (?:you|yourself)$/u,
  /^what(?:'s| is) (?:up|good(?: lately)?|new)(?: with you)?$/u,
  /^how(?:'s| is) your day(?: (?:going|been))?$/u,
  /^anything new(?: going on)?(?: with you)?$/u,
  /^anything else$/u,
  /^just checking in$/u,
  /^what(?:'s| is) on your mind$/u,
  /^anything exciting happen(?:ing)?$/u,
  /^how are you(?: doing)?$/u,
  /^how(?:'s| is) it going$/u,
  /^how(?:'s| is) everything$/u,
  /^how have you been$/u,
];
const GENERIC_ENGAGEMENT_QUESTION_PATTERNS = [
  /^anything (?:interesting|fun|exciting)(?: (?:going on|happening|planned))?$/u,
  /^(?:any )?plans(?: (?:for )?(?:tonight|today|tomorrow|later|this weekend))?$/u,
  /^(?:you )?(?:got|have) (?:any )?plans(?: (?:for )?(?:tonight|today|tomorrow|later|this weekend))?$/u,
  /^(?:you )?(?:doing|up to) anything(?: (?:later|tonight|today|tomorrow|this weekend))?$/u,
  /^what (?:did|do) you have in mind$/u,
  /^what do you think$/u,
  /^what are you (?:doing|up to)(?: (?:later|tonight|today|tomorrow|this weekend))?$/u,
  /^what have you been (?:doing|up to)$/u,
  /^what(?:'ve| have) you been up to$/u,
  /^anything specific on your mind$/u,
  /^anything on your mind$/u,
  /^anything you want to talk about$/u,
  /^(?:want to )?talk about it$/u,
];
const FOLLOW_UP_SETUP =
  /\b(?:we (?:could|can|should)|let'?s|maybe|how about|why not|i (?:could|can|would) (?:meet|come|watch|play|go|join|try|be there|bring|stay|leave|start|finish|check|help|do (?:that|this|it))|i would rather|i(?:'m| am) (?:free|available|busy)|you (?:could|can|might|should)|suggest(?:ion)?|recommend(?:ation)?|you (?:seem|look|sound)|are you (?:okay|ok|alright)|what(?:'s| is) wrong|you(?:'re| are) (?:quiet|upset|down)|is everything (?:okay|ok|alright)|i(?:'m| am) sorry|that(?:'s| sounds| seems) (?:rough|hard|tough|awful|terrible))\b/iu;
const LEADING_QUESTION_FILLER =
  /^(?:(?:so|and|but|or|then|anyway|also|actually|honestly|though|tho|well|okay|ok|alright|hey|hi|hello)[,\s]+)+/u;
const TRAILING_QUESTION_FILLER =
  /(?:[,\s]+(?:or just (?:catching up|passing time|checking in)|though|tho|then|lol|haha|rn|right now|these days|today|tonight|this morning|this afternoon|this evening))+$/u;

function normalizeTrailingQuestion(question: string): string {
  let normalized = question.replace(/[.!?]+$/u, '').trim().toLowerCase();
  let previous = '';
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(LEADING_QUESTION_FILLER, '')
      .replace(TRAILING_QUESTION_FILLER, '')
      .trim();
  }
  return normalized;
}

function shouldStripTrailingQuestion(question: string, preceding: string): boolean {
  const normalized = normalizeTrailingQuestion(question);
  if (RECIPROCAL_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return GENERIC_ENGAGEMENT_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    !FOLLOW_UP_SETUP.test(preceding);
}

export function stripGenericTrailingQuestions(reply: string): string {
  const trimmedReply = reply.trim();
  if (!trimmedReply) {
    return reply;
  }

  const segments = trimmedReply.split(/(?<=[.!?])\s+/u);
  const lastSegment = segments.at(-1) ?? '';
  const precedingSegments = segments.slice(0, -1).join(' ');
  if (segments.length > 1 && shouldStripTrailingQuestion(lastSegment, precedingSegments)) {
    return precedingSegments.trimEnd();
  }

  const commaMatch = /^(.*)[,;]\s*([^,;]+)$/u.exec(trimmedReply);
  if (commaMatch && commaMatch[1].trim() &&
      shouldStripTrailingQuestion(commaMatch[2], commaMatch[1])) {
    return commaMatch[1].trimEnd();
  }
  return reply;
}

export function stripParticipantSpeakerLabel(
  reply: string,
  participantNames: readonly string[],
  messages: readonly ReplyContextMessage[] = [],
): string {
  const trimmedReply = reply.trim();
  const forms = participantForms(participantNames);
  if (!trimmedReply || forms.length === 0 ||
      isRequestedNameReference(forms, messages)) {
    return reply;
  }

  for (const form of forms) {
    const pattern = new RegExp(
      `^\\s*@?${escapeRegExp(form).replace(/\s+/gu, '\\s+')}\\s*[:：]\\s*`,
      'iu',
    );
    const match = pattern.exec(trimmedReply);
    if (!match) {
      continue;
    }
    const remainder = trimmedReply.slice(match[0].length).trim();
    if (!remainder) {
      return reply;
    }
    return remainder;
  }
  return reply;
}

export function stripLeadingParticipantMentions(
  reply: string,
  participantNames: readonly string[],
  messages: readonly ReplyContextMessage[] = [],
): string {
  const trimmedReply = reply.trim();
  const forms = participantForms(participantNames);
  if (!trimmedReply || forms.length === 0 ||
      isRequestedNameReference(forms, messages)) {
    return reply;
  }

  let current = trimmedReply;
  for (;;) {
    let mentionMatch: RegExpExecArray | null = null;
    for (const form of forms) {
      const pattern = new RegExp(
        `^@${escapeRegExp(form).replace(/\s+/gu, '\\s+')}` +
          `(?![\\p{L}\\p{N}_'’])(?:\\s*[:：,;]\\s*|\\s+|$)`,
        'iu',
      );
      const match = pattern.exec(current);
      if (match) {
        mentionMatch = match;
        break;
      }
    }
    if (!mentionMatch) {
      break;
    }
    const remainder = current.slice(mentionMatch[0].length).trim();
    if (!remainder) {
      return reply;
    }
    current = remainder;
  }
  return current === trimmedReply ? reply : current;
}
