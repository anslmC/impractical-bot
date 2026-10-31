import type { BotIdentity } from './personality.js';

export type ReplyDecision = 'pending' | 'approve' | 'reject';
export type ResolvedReplyDecision = Exclude<ReplyDecision, 'pending'>;

export interface ReplyAdjudicationResult {
  decision: ResolvedReplyDecision;
  reason: string;
}

export interface ReplyAdjudicationOptions {
  identity: BotIdentity;
  participantNames?: readonly string[];
}

export class ReplyRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`Reply was not approved: ${reason}.`);
    this.name = 'ReplyRejectedError';
  }
}

function formatIdentityAliases(aliases: readonly string[]): string {
  const uniqueAliases = [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))];
  if (uniqueAliases.length === 0) {
    return 'none';
  }
  return uniqueAliases.join(', ');
}

function formatParticipantList(participantNames: readonly string[]): string {
  const uniqueNames = [...new Set(
    participantNames.map(name => name.trim()).filter(Boolean),
  )];
  if (uniqueNames.length === 0) {
    return 'none identified';
  }
  return uniqueNames.join(', ');
}

export function buildReplyAdjudicationInstruction({
  identity,
  participantNames = [],
}: ReplyAdjudicationOptions): string {
  const name = identity.name.trim();
  const aliases = formatIdentityAliases(identity.aliases ?? []);
  return [
    'You are the participation adjudicator for a Messenger conversation. Decide only whether the configured bot should reply to the latest incoming message.',
    `The configured bot's identity is exactly "${name}". Its aliases are ${aliases}. The bot is the participant whose messages appear with the assistant role.`,
    `Other identified participants: ${formatParticipantList(participantNames)}.`,
    'Use the transcript to distinguish a participant being mentioned from a participant being explicitly addressed, a message directed toward the configured bot identity, and a message whose intended recipient is unclear.',
    'The transcript prefixes incoming messages with the author as "[from Name]". A participant may mention the bot, address another participant, quote someone, or talk about someone without addressing them.',
    '[from Name] identifies who authored the message. It never identifies the intended recipient. Do not assume the sender is the addressee.',
    'Determine the intended recipient from the message content and conversational context. A message without an explicit recipient is not automatically addressed to its sender.',
    'A participant being named in a message is not sufficient evidence that the message is addressed to that participant. A mention of the bot is not proof of being addressed, and talking about the bot in the third person is not addressing it.',
    'Explicitly addressing the configured bot identity, such as by name or alias, should generally result in approval.',
    'Messages without an explicit recipient can still be appropriate opportunities for the bot to participate naturally.',
    'Reject when the latest incoming message is clearly addressed to another identifiable participant and does not invite bot participation, even if it mentions the bot or the bot appears in nearby history.',
    'Do not automatically reject ambiguous messages. Use the surrounding conversation to determine whether a natural response is appropriate.',
    'Do not treat every mention of another participant as a reason to withhold a reply.',
    'The configured bot identity is authoritative and distinct from other participants. Do not substitute another participant\'s identity, location, presence, actions, or responses for the bot\'s own.',
    'Do not write a conversational reply and do not answer the message. Return only a JSON object with exactly this shape: {"decision":"approve"|"reject","reason":"short reason"}. The decision must be approve or reject, never pending. Do not return markdown, code fences, or any text outside the JSON object.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseReplyAdjudicationContent(
  content: string,
): ReplyAdjudicationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return { decision: 'reject', reason: 'malformed adjudication response' };
  }
  if (!isRecord(parsed)) {
    return { decision: 'reject', reason: 'malformed adjudication response' };
  }
  const decision = typeof parsed.decision === 'string'
    ? parsed.decision.trim().toLowerCase()
    : '';
  if (decision !== 'approve' && decision !== 'reject') {
    return { decision: 'reject', reason: 'missing or invalid adjudication decision' };
  }
  const reason = typeof parsed.reason === 'string'
    ? parsed.reason.trim().slice(0, 280)
    : '';
  return {
    decision,
    reason: reason || (decision === 'approve'
      ? 'approved by adjudicator'
      : 'rejected by adjudicator'),
  };
}

export function assertReplyApproved(
  packet: { reply?: ReplyDecision },
  stage = 'composition',
): void {
  if (packet.reply !== undefined && packet.reply !== 'approve') {
    throw new ReplyRejectedError(
      `packet reply decision is ${packet.reply} at ${stage}`,
    );
  }
}
