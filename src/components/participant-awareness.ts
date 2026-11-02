import { sanitizeGroupRoster, type GroupRoster } from '../browser/group-roster.js';

export interface ParticipantAwarenessIdentity {
  name: string;
  aliases?: readonly string[];
}

export interface ParticipantAwarenessMessage {
  sender?: unknown;
  direction?: unknown;
}

export interface ParticipantIdentity {
  canonicalName: string;
  forms: readonly string[];
  ambiguous: boolean;
}

export interface ParticipantAwareness {
  botNames: readonly string[];
  participants: readonly ParticipantIdentity[];
  participantNames: readonly string[];
  canonicalNames: readonly string[];
  allNames: readonly string[];
}

export function normalizeParticipantName(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/^@+/u, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ');
}

export function participantNameKey(value: string): string {
  return normalizeParticipantName(value).toLocaleLowerCase();
}

export function findParticipantIdentity(
  awareness: ParticipantAwareness,
  value: string,
): ParticipantIdentity | null {
  const key = participantNameKey(value);
  if (!key) {
    return null;
  }
  return awareness.participants.find(participant =>
    participant.forms.some(form => participantNameKey(form) === key)
  ) ?? null;
}

export function buildParticipantNameForms(value: string): string[] {
  const normalized = normalizeParticipantName(value);
  if (!normalized) {
    return [];
  }

  const forms = new Set<string>([normalized]);
  const parts = normalized.split(' ');
  if (parts.length > 1) {
    forms.add(parts[0]);
    forms.add(parts.join(''));
  }
  return [...forms];
}

function addForms(
  keys: Set<string>,
  forms: string[],
  value: string,
): void {
  for (const form of buildParticipantNameForms(value)) {
    const key = participantNameKey(form);
    if (!key || keys.has(key)) {
      continue;
    }
    keys.add(key);
    forms.push(form);
  }
}

function isUsableSender(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const key = participantNameKey(value);
  return key !== '' && key !== 'unknown' && key !== 'you';
}

export function buildParticipantAwareness({
  bot,
  roster,
  messages = [],
}: {
  bot: ParticipantAwarenessIdentity;
  roster?: GroupRoster;
  messages?: readonly ParticipantAwarenessMessage[];
}): ParticipantAwareness {
  const botNames: string[] = [];
  const botKeys = new Set<string>();
  for (const name of [bot.name, ...(bot.aliases ?? [])]) {
    addForms(botKeys, botNames, name);
  }

  const participants = new Map<
    string,
    { canonicalName: string; forms: string[]; ambiguous: boolean }
  >();
  const participantKeys = new Set<string>();

  const addParticipant = (name: string, fromRoster: boolean): void => {
    const forms = buildParticipantNameForms(name);
    if (forms.length === 0) {
      return;
    }

    const key = participantNameKey(forms[0]);
    if (!key || botKeys.has(key)) {
      return;
    }

    const existingKey = forms
      .map(participantNameKey)
      .find(candidate => participants.has(candidate));
    const existing = existingKey ? participants.get(existingKey) : undefined;
    if (existing) {
      if (fromRoster) {
        existing.ambiguous = true;
      }
      for (const form of forms) {
        const formKey = participantNameKey(form);
        if (formKey && !participantKeys.has(formKey)) {
          participantKeys.add(formKey);
          existing.forms.push(form);
        }
      }
      return;
    }

    const identity = {
      canonicalName: forms[0],
      forms: [...forms],
      ambiguous: false,
    };
    participants.set(key, identity);
    participantKeys.add(key);
    for (const form of forms.slice(1)) {
      participantKeys.add(participantNameKey(form));
    }
  };

  if (roster) {
    const sanitized = sanitizeGroupRoster(roster);
    for (const member of sanitized.members) {
      if (!member.isPuppet) {
        addParticipant(member.firstName, true);
      }
    }
  }

  for (const message of messages) {
    if (message.direction === 'OUTGOING' || !isUsableSender(message.sender)) {
      continue;
    }
    const key = participantNameKey(message.sender);
    if (botKeys.has(key)) {
      continue;
    }
    addParticipant(message.sender, false);
  }

  const participantList = [...participants.values()];
  const participantNames: string[] = [];
  const canonicalNames: string[] = [];
  const allNames: string[] = [];
  const allKeys = new Set<string>();

  for (const participant of participantList) {
    canonicalNames.push(participant.canonicalName);
    for (const form of participant.forms) {
      const key = participantNameKey(form);
      if (!key || allKeys.has(key)) {
        continue;
      }
      allKeys.add(key);
      participantNames.push(form);
      allNames.push(form);
    }
  }
  for (const name of botNames) {
    const key = participantNameKey(name);
    if (!key || allKeys.has(key)) {
      continue;
    }
    allKeys.add(key);
    allNames.push(name);
  }

  return {
    botNames,
    participants: participantList,
    participantNames,
    canonicalNames,
    allNames,
  };
}
