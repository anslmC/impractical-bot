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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
