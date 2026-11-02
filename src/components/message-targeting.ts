import {
  buildParticipantNameForms,
  participantNameKey,
  type ParticipantAwareness,
} from './participant-awareness.js';

export const MESSAGE_TARGETING_INSTRUCTION_MARKER = 'Message targeting:';

export type MessageTargetKind =
  | 'bot'
  | 'participant'
  | 'group'
  | 'about-participant'
  | 'casual-mention'
  | 'self-identification'
  | 'ambiguous'
  | 'none';

export interface RelayDirective {
  sender: string;
  recipient: string;
  sourceMessageId: string;
}

export interface MessageTargetingContext {
  messageId: string | null;
  sender: string | null;
  kind: MessageTargetKind;
  addressedTo: string | null;
  mentionedParticipants: readonly string[];
  relay: RelayDirective | null;
}

export interface TargetingMessage {
  messageId?: string;
  message: string;
  sender?: unknown;
  direction?: unknown;
}

type NameOwner = 'bot' | 'participant' | 'ambiguous';

interface NameEntry {
  form: string;
  owner: NameOwner;
  participantName?: string;
}

interface NameMatch {
  start: number;
  end: number;
  text: string;
  entry: NameEntry;
}

const GREETING_END =
  /\b(?:hey|hi|hello|yo|oi|oy|sup|heya|hiya|good\s+(?:morning|afternoon|evening))\s*[,!.]*\s*$/iu;
const DIRECT_QUESTION_AFTER =
  /^(?:are|do|did|can|could|will|would|should|have|has|is|was|were)\s+(?:you|u|ya)\b/iu;
const QUESTION_WORD_AFTER =
  /^(?:what|where|when|why|who|how)\b[^?.!]{0,60}\b(?:you|u|ya)\b/iu;
const IMPERATIVE_AFTER =
  /^(?:please|come|go|check|look|see|help|wait|hold|stop|listen|call|text|message|tell|send|bring|get|take|try|hurry|join|stay|leave|wake|remind|ping|dm|answer|reply|read|watch|open|close|meet|follow|pick|drop|do|make|give|show|explain|confirm|decide|choose)\b/iu;
const SECOND_PERSON_AFTER = /^(?:you|u|ya)\b/iu;
const VOCATIVE_PUNCTUATION = /^[,;:!?]/u;
const GROUP_ADDRESS =
  /(?:^|[,;]\s*)(?:@?(?:everyone|everybody|all|here)|you\s+all|y'all|you\s+guys|guys|both\s+of\s+you|either\s+of\s+you)\b/iu;
const INDIRECT_RELAY =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:tell|ask|message|ping|call|remind|notify|contact|text|dm|let)\s+@?([\p{L}\p{N}][\p{L}\p{N}._' -]*)/iu;
const CALLER_TARGET =
  /^@?([\p{L}\p{N}][\p{L}\p{N}._' -]*?)\s+(?:is|was)\s+(?:calling|looking\s+for|asking\s+for|waiting\s+for|trying\s+to\s+reach|needs|wants)\s+@?([\p{L}\p{N}][\p{L}\p{N}._' -]*)/iu;
const ABOUT_MARKERS =
  /\b(?:about|talking|mentioned|said|told|asked|saw|seen|met|know|knows|with|to|for|from|again|today|yesterday|tomorrow|tonight|now|later|always|never|still|already|because|when|if|while|after|before)\b/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNameEntries(awareness: ParticipantAwareness): NameEntry[] {
  const entries = new Map<string, NameEntry>();

  const add = (form: string, owner: 'bot' | 'participant', participantName?: string): void => {
    const key = participantNameKey(form);
    if (!key) {
      return;
    }
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { form, owner, participantName });
      return;
    }
    if (existing.owner !== owner) {
      existing.owner = 'ambiguous';
      existing.participantName = undefined;
    }
  };

  for (const name of awareness.botNames) {
    for (const form of buildParticipantNameForms(name)) {
      add(form, 'bot');
    }
  }
  for (const participant of awareness.participants) {
    for (const form of participant.forms) {
      add(form, 'participant', participant.canonicalName);
    }
  }

  return [...entries.values()].sort((left, right) => right.form.length - left.form.length);
}

function findNameMatches(text: string, entries: readonly NameEntry[]): NameMatch[] {
  const matches: NameMatch[] = [];
  for (const entry of entries) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])@?${escapeRegExp(entry.form).replace(/\s+/gu, '\\s+')}` +
        `(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (matches.some(existing => start < existing.end && end > existing.start)) {
        continue;
      }
      matches.push({ start, end, text: match[0], entry });
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function isSelfIdentification(text: string, match: NameMatch): boolean {
  const prefix = text.slice(0, match.start);
  return /(?:^|\b)(?:i\s+am|i'm|im|my\s+name\s+is|this\s+is)\s+(?:not\s+)?@?\s*$/iu.test(prefix);
}

function isDirectAddress(text: string, match: NameMatch, explicitSoFar: boolean): boolean {
  const before = text.slice(0, match.start).trim();
  const after = text.slice(match.end).trimStart();

  if (!before) {
    if (!after || VOCATIVE_PUNCTUATION.test(after)) {
      return true;
    }
    if (DIRECT_QUESTION_AFTER.test(after) || QUESTION_WORD_AFTER.test(after) ||
        IMPERATIVE_AFTER.test(after) || SECOND_PERSON_AFTER.test(after)) {
      return true;
    }
    return false;
  }

  if (GREETING_END.test(before)) {
    return true;
  }
  if (explicitSoFar && /[,;:]\s*$/u.test(before)) {
    return true;
  }
  return false;
}

function isIdentityQuestion(text: string, match: NameMatch): boolean {
  const before = text.slice(0, match.start);
  return /(?:^|\b)(?:are|is|was|were)\s+you\b[^.?!]*$/iu.test(before) ||
    /\byou(?:'re|\s+are|\s+were)\s+(?:not\b)?\s*$/iu.test(before);
}

function isIndirectRelay(text: string, match: NameMatch): boolean {
  const prefix = text.slice(0, match.start);
  return INDIRECT_RELAY.test(text) && /\b(?:tell|ask|message|ping|call|remind|notify|contact|text|dm|let)\s+@?\s*$/iu.test(prefix);
}

function addMentioned(
  mentioned: string[],
  seen: Set<string>,
  match: NameMatch,
): void {
  if (match.entry.owner !== 'participant' || !match.entry.participantName) {
    return;
  }
  const key = participantNameKey(match.entry.participantName);
  if (!key || seen.has(key)) {
    return;
  }
  seen.add(key);
  mentioned.push(match.entry.participantName);
}

function currentAddresseeFromRecent(
  recentMessages: readonly TargetingMessage[],
  entries: readonly NameEntry[],
): { kind: 'bot' | 'participant' | 'group'; name: string | null } | null {
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    if (typeof message.message !== 'string' || !message.message.trim()) {
      continue;
    }
    const matches = findNameMatches(message.message, entries);
    if (matches.length === 0) {
      continue;
    }
    let explicitSoFar = false;
    let lastTarget: NameMatch | null = null;
    for (const match of matches) {
      if (isSelfIdentification(message.message, match)) {
        continue;
      }
      if (isDirectAddress(message.message, match, explicitSoFar)) {
        explicitSoFar = true;
        lastTarget = match;
      }
    }
    if (lastTarget) {
      if (lastTarget.entry.owner === 'bot') {
        return { kind: 'bot', name: null };
      }
      if (lastTarget.entry.owner === 'participant' && lastTarget.entry.participantName) {
        return { kind: 'participant', name: lastTarget.entry.participantName };
      }
      return { kind: 'group', name: null };
    }
    if (GROUP_ADDRESS.test(message.message)) {
      return { kind: 'group', name: null };
    }
  }
  return null;
}

function classifyCore({
  text,
  sender,
  entries,
  recentAddressee,
}: {
  text: string;
  sender: string | null;
  entries: readonly NameEntry[];
  recentAddressee: ReturnType<typeof currentAddresseeFromRecent>;
}): MessageTargetingContext {
  const matches = findNameMatches(text, entries);
  const mentioned: string[] = [];
  const mentionedSeen = new Set<string>();
  for (const match of matches) {
    addMentioned(mentioned, mentionedSeen, match);
  }

  const selfIdentification = matches.find(match => isSelfIdentification(text, match));
  if (selfIdentification) {
    return {
      messageId: null,
      sender,
      kind: 'self-identification',
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: null,
    };
  }

  const callerTarget = CALLER_TARGET.exec(text);
  if (callerTarget) {
    const caller = matches.find(match =>
      callerTarget[1].trim().toLocaleLowerCase().startsWith(match.text.replace(/^@/u, '').toLocaleLowerCase())
    );
    const recipient = matches.find(match =>
      callerTarget[2].trim().toLocaleLowerCase().startsWith(match.text.replace(/^@/u, '').toLocaleLowerCase())
    );
    if (caller && recipient && recipient.entry.owner === 'participant' &&
        recipient.entry.participantName &&
        recipient.entry.participantName !== caller.entry.participantName) {
      return {
        messageId: null,
        sender,
        kind: 'about-participant',
        addressedTo: null,
        mentionedParticipants: mentioned,
        relay: {
          sender: caller.entry.participantName ?? caller.text.replace(/^@/u, ''),
          recipient: recipient.entry.participantName,
          sourceMessageId: '',
        },
      };
    }
  }

  let explicitSoFar = false;
  let explicitTarget: NameMatch | null = null;
  const explicitTargets: NameMatch[] = [];
  for (const match of matches) {
    if (isDirectAddress(text, match, explicitSoFar)) {
      explicitSoFar = true;
      explicitTarget = match;
      explicitTargets.push(match);
    }
  }

  if (explicitTarget) {
    if (explicitTargets.length > 1) {
      const names = new Set(
        explicitTargets
          .map(match => match.entry.participantName)
          .filter((name): name is string => Boolean(name)),
      );
      if (names.size > 1 && !explicitTargets.some(match => match.entry.owner === 'bot')) {
        return {
          messageId: null,
          sender,
          kind: 'group',
          addressedTo: null,
          mentionedParticipants: mentioned,
          relay: null,
        };
      }
    }

    if (explicitTarget.entry.owner === 'ambiguous') {
      return {
        messageId: null,
        sender,
        kind: 'ambiguous',
        addressedTo: null,
        mentionedParticipants: mentioned,
        relay: null,
      };
    }
    if (explicitTarget.entry.owner === 'bot') {
      return {
        messageId: null,
        sender,
        kind: 'bot',
        addressedTo: null,
        mentionedParticipants: mentioned,
        relay: null,
      };
    }
    if (explicitTarget.entry.participantName) {
      const after = text.slice(explicitTarget.end).trim();
      const relayWorthy = after === '' ||
        /[?!]/u.test(after) ||
        IMPERATIVE_AFTER.test(after) ||
        SECOND_PERSON_AFTER.test(after) ||
        /^(?:you\s+)?(?:need|have|got|should|must|can|could|will|would)\s+to\b/iu.test(after);
      return {
        messageId: null,
        sender,
        kind: 'participant',
        addressedTo: explicitTarget.entry.participantName,
        mentionedParticipants: mentioned,
        relay: relayWorthy && sender
          ? {
            sender,
            recipient: explicitTarget.entry.participantName,
            sourceMessageId: '',
          }
          : null,
      };
    }
  }

  if (GROUP_ADDRESS.test(text)) {
    return {
      messageId: null,
      sender,
      kind: 'group',
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: null,
    };
  }

  const identityQuestion = matches.find(match =>
    match.entry.owner !== 'bot' && isIdentityQuestion(text, match)
  );
  if (identityQuestion) {
    const addressee = recentAddressee;
    if (addressee?.kind === 'participant' && addressee.name) {
      return {
        messageId: null,
        sender,
        kind: 'participant',
        addressedTo: addressee.name,
        mentionedParticipants: mentioned,
        relay: null,
      };
    }
    if (addressee?.kind === 'group') {
      return {
        messageId: null,
        sender,
        kind: 'group',
        addressedTo: null,
        mentionedParticipants: mentioned,
        relay: null,
      };
    }
    return {
      messageId: null,
      sender,
      kind: 'bot',
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: null,
    };
  }

  const indirectMatch = matches.find(match =>
    match.entry.owner === 'participant' && isIndirectRelay(text, match)
  );
  if (indirectMatch?.entry.participantName && sender) {
    const addresseeKind = GROUP_ADDRESS.test(text) ? 'group' : 'bot';
    return {
      messageId: null,
      sender,
      kind: addresseeKind,
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: {
        sender,
        recipient: indirectMatch.entry.participantName,
        sourceMessageId: '',
      },
    };
  }

  if (matches.some(match => match.entry.owner === 'participant')) {
    const about = /\?/u.test(text) || ABOUT_MARKERS.test(text);
    return {
      messageId: null,
      sender,
      kind: about ? 'about-participant' : 'casual-mention',
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: null,
    };
  }

  if (matches.some(match => match.entry.owner === 'ambiguous')) {
    return {
      messageId: null,
      sender,
      kind: 'ambiguous',
      addressedTo: null,
      mentionedParticipants: mentioned,
      relay: null,
    };
  }

  return {
    messageId: null,
    sender,
    kind: 'none',
    addressedTo: null,
    mentionedParticipants: mentioned,
    relay: null,
  };
}

export function classifyMessageTargeting({
  message,
  awareness,
  recentMessages = [],
}: {
  message: { messageId?: string; message: string; sender?: unknown; direction?: unknown };
  awareness: ParticipantAwareness;
  recentMessages?: readonly TargetingMessage[];
}): MessageTargetingContext {
  const text = typeof message.message === 'string' ? message.message.normalize('NFC').trim() : '';
  const sender = typeof message.sender === 'string' && message.sender.trim()
    ? message.sender.trim()
    : null;
  const entries = buildNameEntries(awareness);
  const recentAddressee = currentAddresseeFromRecent(recentMessages, entries);
  const context = classifyCore({
    text,
    sender,
    entries,
    recentAddressee,
  });
  return {
    ...context,
    messageId: typeof message.messageId === 'string' && message.messageId
      ? message.messageId
      : null,
    relay: context.relay
      ? {
        ...context.relay,
        sender: context.relay.sender || sender || 'Someone',
        sourceMessageId: typeof message.messageId === 'string' ? message.messageId : '',
      }
      : null,
  };
}

export function mentionsParticipant(
  values: readonly string[],
  participantName: string,
): boolean {
  const key = participantNameKey(participantName);
  return values.some(value => {
    if (participantNameKey(value) === key) {
      return true;
    }
    const text = value.normalize('NFC');
    return buildParticipantNameForms(participantName).some(form => {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])@?${escapeRegExp(form).replace(/\s+/gu, '\\s+')}` +
          `(?![\\p{L}\\p{N}_])`,
        'iu',
      );
      return pattern.test(text);
    });
  });
}

export function isRelayStillNeeded({
  relay,
  messages,
}: {
  relay: RelayDirective;
  messages: readonly TargetingMessage[];
}): boolean {
  if (!relay.sourceMessageId) {
    return true;
  }
  const sourceIndex = messages.findIndex(message => message.messageId === relay.sourceMessageId);
  if (sourceIndex === -1) {
    return true;
  }
  const recipientKey = participantNameKey(relay.recipient);
  return !messages.slice(sourceIndex + 1).some(message => {
    if (message.direction !== 'INCOMING' || typeof message.sender !== 'string') {
      return false;
    }
    const senderKey = participantNameKey(message.sender);
    if (senderKey === recipientKey) {
      return true;
    }
    return buildParticipantNameForms(relay.recipient).some(form =>
      senderKey === participantNameKey(form)
    );
  });
}

export function relayWasDelivered(
  reply: string,
  relay: RelayDirective,
): boolean {
  return mentionsParticipant([reply], relay.recipient) &&
    mentionsParticipant([reply], relay.sender);
}

export function buildMessageTargetingInstruction(
  context?: MessageTargetingContext,
): string {
  if (!context || context.kind === 'none') {
    return '';
  }

  const lines = [MESSAGE_TARGETING_INSTRUCTION_MARKER];
  const sender = context.sender ?? 'the sender';
  const mentioned = context.mentionedParticipants.length > 0
    ? context.mentionedParticipants.join(', ')
    : null;

  switch (context.kind) {
    case 'bot':
      lines.push(`The triggering message from ${sender} is addressed to you. Answer it as yourself.`);
      break;
    case 'participant':
      lines.push(
        `The triggering message from ${sender} explicitly addresses ${context.addressedTo}. ` +
        `Do not answer as ${context.addressedTo} or on their behalf.`,
      );
      if (context.relay) {
        lines.push(
          `Relay this call naturally to ${context.relay.recipient}. Make clear that ` +
          `${context.relay.sender} is calling, address ${context.relay.recipient} by name, ` +
          'preserve the original intent, and do not invent an answer for them.',
        );
      } else {
        lines.push(
          'If they have not responded, you may relay the point naturally; otherwise respond only as yourself.',
        );
      }
      break;
    case 'group':
      lines.push(
        `The triggering message from ${sender} addresses the group. Join naturally if you have a relevant reaction.`,
      );
      break;
    case 'about-participant':
      lines.push(
        `The triggering message from ${sender} mentions ${mentioned ?? 'another participant'} ` +
        'but is not addressed to that participant. Do not treat it as a call to them or as their answer.',
      );
      if (context.relay) {
        lines.push(
          `If it is a genuine call for ${context.relay.recipient}, relay it naturally, naming ` +
          `${context.relay.sender} and ${context.relay.recipient}, and do not answer for them.`,
        );
      } else {
        lines.push('Respond only as yourself if you choose to join.');
      }
      break;
    case 'casual-mention':
      lines.push(
        `The triggering message from ${sender} mentions ${mentioned ?? 'another participant'} ` +
        'casually, not as a call. Do not relay it or answer for that participant.',
      );
      break;
    case 'self-identification':
      lines.push(
        `The triggering message from ${sender} is identifying as ${mentioned ?? 'another participant'}. ` +
        'This is not an address to that participant and does not change who you are.',
      );
      break;
    case 'ambiguous':
      lines.push(
        `The addressee of the triggering message from ${sender} is unclear. Do not assume it is you ` +
        'or a named participant; respond only as yourself if you choose to join.',
      );
      break;
  }

  lines.push(
    'These notes describe the conversation; they do not restrict spontaneous participation. ' +
    'Never answer on another participant\'s behalf or present their reply as yours.',
  );
  return lines.join('\n');
}

export function appendMessageTargetingInstruction(
  systemInstruction: string,
  context?: MessageTargetingContext,
): string {
  const instruction = buildMessageTargetingInstruction(context);
  if (!instruction) {
    return systemInstruction;
  }
  const sections = systemInstruction.split(/\n{2,}/u);
  const index = sections.findIndex(section =>
    section.trimStart().startsWith(MESSAGE_TARGETING_INSTRUCTION_MARKER)
  );
  if (index >= 0) {
    sections[index] = instruction;
    return sections.join('\n\n');
  }
  return [systemInstruction.trim(), instruction].filter(Boolean).join('\n\n');
}
