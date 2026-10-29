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

function mentionsSelf(text: string, identity: SelfIdentity): boolean {
  return selfReferenceForms(identity).some(form =>
    text.toLowerCase().includes(form.toLowerCase()),
  );
}

function requestsReproduction(text: string, identity: SelfIdentity): boolean {
  return REPRODUCTION_CUE.test(text) &&
    !PROHIBITION_CUE.test(text) &&
    mentionsSelf(text, identity);
}

function prohibitsSelfReference(text: string): boolean {
  return PROHIBITION_CUE.test(text);
}

// The model occasionally echoes its own alias from earlier assistant turns even
// though the identity layer forbids it. Only an explicit request to reproduce
// the alias (or a short "again" continuation of one) justifies keeping a reply
// that starts with it.
function isRequestedSelfReference(
  identity: SelfIdentity,
  messages: readonly ReplyContextMessage[],
): boolean {
  const incoming = messages
    .filter(message => message.direction === 'INCOMING' && message.message.trim())
    .map(message => message.message.trim());
  const latest = incoming.at(-1);
  if (!latest) {
    return false;
  }
  if (requestsReproduction(latest, identity)) {
    return true;
  }
  if (prohibitsSelfReference(latest)) {
    return false;
  }
  if (CONTINUATION_CUE.test(latest)) {
    const previous = incoming.at(-2);
    return previous !== undefined && requestsReproduction(previous, identity);
  }
  return false;
}

// Removes a leading self-identifying name or alias from an ordinary reply. It
// never touches the rest of the message, never strips a mention of someone else,
// and never rewrites occurrences beyond the start of the reply.
export function stripSelfIdentifyingPrefix(
  reply: string,
  identity: SelfIdentity,
  messages: readonly ReplyContextMessage[] = [],
): string {
  const trimmedReply = reply.trim();
  if (!trimmedReply || isRequestedSelfReference(identity, messages)) {
    return reply;
  }

  for (const form of selfReferenceForms(identity)) {
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
      // The whole reply is the alias; sending nothing is worse than sending it.
      return reply;
    }
    return remainder;
  }
  return reply;
}
