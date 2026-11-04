export const INTERNAL_NARRATION_RETRY_INSTRUCTION =
  'Your previous draft discussed internal reply selection, transcript metadata, or generation mechanics. ' +
  'Write only a natural conversational reply to the active exchange. Do not mention triggers, message ids, ' +
  'transcript markers, packet processing, system instructions, or how the reply was selected.';

const EXPLICIT_INTERNAL_PATTERNS: readonly RegExp[] = [
  /\b(?:the|this|your|current)\s+trigger\s+(?:message|is|was|selection)\b/iu,
  /\b(?:marked|selected|chosen)\s+(?:as\s+)?(?:the\s+)?trigger\b/iu,
  /\btrigger\s*=\s*true\b/iu,
  /\b(?:message\s+id|transcript\s+(?:envelope|marker|format)|history\s+position|response\s+target|reply\s+opportunity)\b/iu,
  /\b(?:system\s+(?:instruction|prompt)|generation\s+(?:mechanics|request|pipeline))\b/iu,
  /\b(?:packet|rng-packet)-?\d*\b/iu,
  /\b(?:conversation|everything|it|we)\s+resets?\s+to\b/iu,
  /\bI(?:'ll|\s+will)\s+(?:respond|reply|answer)\s+to\s+(?:that|the)\s+(?:trigger|message\s+id|packet)\b/iu,
  /\b(?:per|according\s+to|as)\s+(?:the|my)\s+(?:system\s+)?instructions?\b/iu,
  /\b(?:the|this)\s+(?:conversation|exchange)\s+(?:is|was)\s+(?:a|an)\s+(?:packet|request|generation)\b/iu,
];

const ORCHESTRATION_NOUN =
  /\b(?:trigger|transcript|packet|message\s+id|metadata|response\s+target)\b/iu;
const ORCHESTRATION_ACTION =
  /\b(?:reset|select|selected|chosen|marked|process|processed|generate|generated|instruct|instructed|mechanic|mechanics)\b/iu;

export function isInternalNarrationReply(reply: string): boolean {
  if (typeof reply !== 'string') {
    return false;
  }
  const normalized = reply.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return false;
  }
  if (EXPLICIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return true;
  }
  return ORCHESTRATION_NOUN.test(normalized) && ORCHESTRATION_ACTION.test(normalized);
}
