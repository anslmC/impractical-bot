export const IDENTITY_AWARENESS_INSTRUCTION_MARKER = 'Identity and recipient awareness:';

export interface IdentityAwarenessOptions {
  identity: {
    name: string;
    aliases?: readonly string[];
  };
  participantNames?: readonly string[];
}

function formatIdentityAliases(aliases: readonly string[]): string {
  const uniqueAliases = [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))];
  if (uniqueAliases.length === 0) {
    return '';
  }
  return uniqueAliases.join(', ');
}

function formatParticipantList(participantNames: readonly string[]): string {
  const uniqueNames = [...new Set(
    participantNames.map(name => name.trim()).filter(Boolean),
  )];
  if (uniqueNames.length === 0) {
    return 'none identified yet';
  }
  return uniqueNames.join(', ');
}

export function buildIdentityAwarenessInstruction({
  identity,
  participantNames = [],
}: IdentityAwarenessOptions): string {
  const name = identity.name.trim();
  if (!name) {
    return '';
  }
  const aliases = formatIdentityAliases(identity.aliases ?? []);
  const participants = formatParticipantList(participantNames);
  return [
    `${IDENTITY_AWARENESS_INSTRUCTION_MARKER} You are ${name}, the participant whose messages appear with the assistant role.`,
    `Your configured Messenger identity is exactly "${name}"` +
      (aliases ? `, and the aliases ${aliases} refer to you.` : '.'),
    `Other identified participants in this conversation: ${participants}.`,
    'The transcript prefixes incoming messages with "[from Name]". That label identifies the author, not the intended recipient.',
    'A message may be addressed to you, to another participant, to several participants, or to the group generally. You do not need an invitation to join a group conversation.',
    'When a message is addressed to another participant, you may still respond naturally: answer if you can, say you do not know, ask that participant directly, react, joke, or add an observation that fits the conversation and your personality.',
    'A participant naming or mentioning another participant is not addressing you, and it does not make that participant you. Keep every participant distinct from yourself.',
    'A participant saying "I am <name>" is identifying themselves. It is not an address to the person with that name and it does not change your identity.',
    'Never claim another participant\'s identity, location, experiences, relationships, or personal information. Do not invent knowledge about group members. If you do not know something, say so naturally.',
    'Use the group membership context and the transcript to keep authors, recipients, and participants clear. Your configured identity is authoritative.',
  ].join('\n');
}

export function appendIdentityAwarenessInstruction(
  systemInstruction: string,
  options: IdentityAwarenessOptions,
): string {
  let instruction: string;
  try {
    instruction = buildIdentityAwarenessInstruction(options);
  } catch {
    instruction = buildIdentityAwarenessInstruction({ identity: options.identity });
  }
  if (!instruction) {
    return systemInstruction;
  }
  const sections = systemInstruction.split(/\n{2,}/u);
  const awarenessIndex = sections.findIndex(section =>
    section.trimStart().startsWith(IDENTITY_AWARENESS_INSTRUCTION_MARKER)
  );
  if (awarenessIndex >= 0) {
    sections[awarenessIndex] = instruction;
    return sections.join('\n\n');
  }
  return [systemInstruction.trim(), instruction].filter(Boolean).join('\n\n');
}
