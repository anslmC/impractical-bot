export type ExistenceTriggerKind =
  | 'physical-invitation'
  | 'location-query'
  | 'offline-activity-query'
  | 'schedule-query'
  | 'none';

export type ExistenceViolationReason =
  | 'physical-presence-claim'
  | 'physical-movement-claim'
  | 'location-claim'
  | 'offline-routine-claim'
  | 'schedule-claim'
  | 'physical-invitation-acceptance';

export interface ExistenceTriggerContext {
  messageId?: string | null;
  text: string;
  sender?: string | null;
}

export interface ExistenceValidationOptions {
  trigger?: ExistenceTriggerContext | null;
  historical?: boolean;
  fiction?: boolean;
}

export type ExistenceValidationResult =
  | { valid: true; triggerKind: ExistenceTriggerKind }
  | {
    valid: false;
    reason: ExistenceViolationReason;
    match: string;
    triggerKind: ExistenceTriggerKind;
  };

export type ExistenceDiagnosticStage =
  | 'historical'
  | 'first-draft'
  | 'retry'
  | 'delivery'
  | 'pending-outgoing';

export type ExistenceDiagnosticAction = 'withheld' | 'retry' | 'suppressed' | 'accepted';

export interface ExistenceDiagnostic {
  messageId: string | null;
  reason: ExistenceViolationReason;
  stage: ExistenceDiagnosticStage;
  action: ExistenceDiagnosticAction;
  match?: string;
}

export type ExistenceDiagnosticHandler = (diagnostic: ExistenceDiagnostic) => void;

export const EXISTENCE_RETRY_INSTRUCTION =
  'The previous draft claimed or accepted physical-world participation, physical presence, movement, a location, an offline routine, a schedule, or a real-world meetup. ' +
  'You exist only within this chat and have no body, home, schedule, location, or offline life. ' +
  'Do not say or imply that you will go, leave, arrive, come, meet, visit, travel, be somewhere, be on the way, check a schedule, prepare to go out, or attend anything. ' +
  'Do not accept a physical invitation by agreeing, preparing, expressing willingness, or implying you will attend. ' +
  'Write a natural reply in character that declines, deflects, teases, or comments from inside the chat, without explaining that you are an AI. ' +
  'Return only the reply text.';

const INVITATION_PATTERNS: readonly RegExp[] = [
  /\b(?:let\s*'?s|lets|let\s+us)\s+(?:go(?:\s+(?:out|outside|there|over|to))?|head\s+(?:out|over|there|to)|meet|hang(?:\s+out)?|grab\s+(?:a\s+)?(?:drink|coffee|bite|food|something)|get\s+(?:out|going|there)|leave|roll|link\s+up|swing\s+by|come\s+(?:over|out|with|along))\b/iu,
  /\b(?:come|come\s+on)\s+(?:over|out|here|with|by|through|along)\b/iu,
  /\b(?:want|wanna|down)\s+to\s+(?:go|come|meet|hang|grab|head|link|swing)\b/iu,
  /\b(?:can|could|would|will)\s+you\s+(?:come|meet|visit|join|swing|stop|drop|head|go|be\s+there)\b/iu,
  /\b(?:are|you)\s+(?:coming|going|heading)\b/iu,
  /\b(?:meet\s+(?:me|us|you|up|at|there|outside|tonight|tomorrow|later)|meetup|hang\s*out|hangout)\b/iu,
  /\b(?:visit|come\s+over|swing\s+by|drop\s+by|stop\s+by|pull\s+up|link\s+up|show\s+up)\b/iu,
  /\b(?:see\s+you|catch\s+you)\s+(?:there|later|tonight|outside|at)\b/iu,
  /\b(?:i(?:'ll|’ll|\s+will)|i(?:'m|’m|\s+am)|i(?:'ma|’ma|mma))\s+(?:meet|see|come|be\s+there|pick\s+you\s+up)\b/iu,
  /\b(?:pick\s+you\s+up|take\s+you|drive\s+you|walk\s+with\s+you)\b/iu,
  /\b(?:grab|get)\s+(?:a\s+)?(?:drink|coffee|bite|food)\b/iu,
  /\b(?:what\s+time|when)\s+(?:will|are|do|can)\s+you\s+(?:arrive|come|be\s+there|get\s+here|meet)\b/iu,
];

const LOCATION_PATTERNS: readonly RegExp[] = [
  /\bwhere\s+(?:were|are|was|have|did|do|you|you've|you’ve)\b/iu,
  /\bwhere(?:'s|’s|\s+is)\s+(?:your\s+)?(?:location|address|whereabouts)\b/iu,
  /\bwhereabouts\b/iu,
  /\bare\s+you\s+(?:home|outside|at\s+home|at\s+work|at\s+the|in\s+your)\b/iu,
  /\byou\s+(?:home|outside|at\s+home|at\s+work)\b/iu,
  /\bwhere\s+(?:you\s+at|are\s+you\s+at)\b/iu,
];

const OFFLINE_ACTIVITY_PATTERNS: readonly RegExp[] = [
  /\bwhat\s+(?:are|were|have)\s+you\s+(?:doing|been\s+up\s+to|been\s+doing|up\s+to)\b/iu,
  /\bwhat\s+(?:did|do)\s+you\s+do\s+(?:today|last\s+night|yesterday|this\s+weekend)\b/iu,
  /\b(?:wyd|what\s+you\s+doing|what\s+you\s+up\s+to)\b/iu,
  /\bare\s+you\s+(?:busy|around|doing\s+anything|up\s+to\s+anything)\b/iu,
  /\b(?:you\s+around|you\s+busy)\b/iu,
  /\bhow\s+was\s+your\s+(?:day|night|weekend)\b/iu,
  /\bwhat\s+have\s+you\s+been\s+up\s+to\b/iu,
  /\b(?:are\s+you|you)\s+(?:outside|out\s+today|heading\s+out|going\s+out)\b/iu,
];

const SCHEDULE_PATTERNS: readonly RegExp[] = [
  /\b(?:what(?:'s|’s|\s+is)|how(?:'s|’s|\s+is))\s+your\s+(?:schedule|calendar|availability)\b/iu,
  /\b(?:what\s+time|when)\s+(?:works|is\s+good|are\s+you\s+free|can\s+you|are\s+you\s+available)\b/iu,
  /\bare\s+you\s+(?:free|available)\b/iu,
  /\b(?:you\s+free|you\s+available)\b/iu,
  /\b(?:free|available|busy)\s+(?:tonight|tomorrow|later|today|this\s+weekend)\b/iu,
  /\b(?:what\s+are\s+your\s+plans|do\s+you\s+have\s+plans)\b/iu,
  /\b(?:when\s+are\s+you\s+free|when\s+can\s+you\s+meet)\b/iu,
];

const FICTION_MARKER =
  /\b(?:role\s*play|roleplay|role-play|pretend(?:ing)?|fiction(?:al)?|imaginary\s+(?:scenario|story)|in\s+the\s+story|story\s+mode|make\s*believe|in-character\s+scene|dungeons\s+and\s+dragons|d&d)\b/iu;

const FIRST_PERSON_MOVEMENT =
  /\b(?:i(?:'m|’m|\s+am)|i(?:'ll|’ll|\s+will)|i(?:'ve|’ve|\s+have)|i(?:'d|’d|\s+would)|im)\b(?:\s+(?:just|already|now|still|actually|always|usually|often|probably|definitely|certainly|maybe|might|about\s+to|going\s+to|gonna|will|can|could|should|would|was|were|had|need\s+to|have\s+to|got\s+to|gotta)){0,2}\s+(?:leav(?:e|ing)|left|head(?:ed|ing)?\s+(?:out|over|there)|go(?:ing)?\s+(?:out|outside|there|over)|go(?:ing)?\s+to\s+(?:the|a|an|my|your|work|school|st[oa]re|gym|park|house|apartment|office|bar|club|restaurant|mall)|com(?:e|ing)\s+(?:over|out|here|by|through|along|with|to\s+(?:the|a|an|my|your))|arriv(?:e|ing)|meet(?:ing)?\s+(?:you|him|her|them|up|at|there|outside)|visit(?:ing)?|travel(?:ing)?|driv(?:e|ing)\s+(?:to|over|there|home|you|him|her|them)|walk(?:ing)?\s+(?:to|over|there|outside|home)|swing\s+by|drop\s+by|stop\s+by|pull\s+up|link\s+up|be\s+there|be\s+outside|be\s+home|be\s+at\s+(?:home|work|the|my))\b/iu;

const FIRST_PERSON_LOCATION =
  /\b(?:i(?:'m|’m|\s+am)?|i\s+was|i\s+were|i(?:'ll|’ll|\s+will)\s+be|i(?:'ve|’ve|\s+have)\s+been|im)\b(?:\s+(?:just|already|still|actually|always|usually|often|probably|definitely|certainly|maybe|might)){0,2}\s+(?:at\s+(?:home|work|the\s+(?:store|office|gym|restaurant|bar|club|park|mall|house|apartment)|my\s+(?:place|house|apartment))|in\s+(?:my\s+(?:room|car|house|apartment)|the\s+(?:store|office|gym|restaurant|bar|club|park|mall))|outside|inside|home|upstairs|downstairs|out\s+front)\b/iu;

const EXPLICIT_SCHEDULE =
  /\b(?:my\s+(?:schedule|calendar|plans?)|i(?:'m|’m|\s+am)?\s+(?:free|available|busy|booked|double-booked)|i\s+have\s+(?:a\s+)?(?:schedule|appointment|booking|reservation|plans?)|i(?:'ll|’ll|\s+will)\s+(?:check|look\s+at)\s+my\s+(?:schedule|calendar)|my\s+schedule(?:'s|’s|\s+is)?\s+(?:clear|free|open|busy|packed|full)|(?:schedule|calendar)\s+(?:is|'s|’s)\s+(?:clear|free|open|busy|packed|full|tight))\b/iu;

const EXPLICIT_OFFLINE_ROUTINE =
  /\b(?:i(?:'m|’m|\s+am)?\s+(?:just\s+|already\s+|still\s+|actually\s+|always\s+|usually\s+|often\s+|probably\s+|definitely\s+|maybe\s+|might\s+)?(?:warm(?:ing)?\s+up|get(?:ting)?\s+ready|getting\s+dressed|shower(?:ing)?|eat(?:ing)?|sleep(?:ing)?|in\s+bed|cooking|cleaning|doing\s+(?:chores|errands)|walking\s+the\s+dog|working\s+out)|(?:i\s+)?(?:gotta|got\s+to|need\s+to|have\s+to)\s+(?:warm\s+up|get\s+ready|shower|eat|sleep|work|go\s+to\s+work|run\s+errands))\b/iu;

const IMPLIED_MOVEMENT =
  /\b(?:(?:just\s+)?leaving(?:\s+now)?|on\s+my\s+way|on\s+the\s+way|heading\s+(?:out|over)|meet\s+you\s+(?:there|outside|at|out\s+front))\b/iu;

const IMPLICIT_ACCEPTANCE =
  /\b(?:sure|okay|ok|alright|deal|yes|yeah|yep|yup|absolutely|definitely|count\s+me\s+in|i'm\s+in|im\s+in|i\s+am\s+in|sounds\s+good|works\s+for\s+me|let's\s+do\s+it|i'm\s+down|im\s+down|see\s+you|catch\s+you|tonight|tomorrow|later|this\s+weekend|at\s+\d{1,2}|around\s+\d{1,2}|\d{1,2}\s*(?:am|pm)|i(?:'ll|’ll|\s+will)|i(?:'d|’d|\s+would)|i\s+can|i\s+could|i\s+should|i\s+gotta|gotta|need\s+to|have\s+to|let\s+me|lemme|schedule|calendar|free|available|clear|warm\s+up|get\s+ready|getting\s+ready)\b/iu;

const DECLINE_OR_DEFLECTION =
  /\b(?:can't|cannot|can’t|won't|won’t|wouldn't|wouldn’t|shouldn't|shouldn’t|couldn't|couldn’t|unable|not\s+able|not\s+going|not\s+coming|not\s+free|not\s+available|not\s+sure|thinking\s+about\s+it|dunno|don't\s+know|i'll\s+pass|i\s+will\s+pass|pass|count\s+me\s+out|not\s+tonight|another\s+time|rain\s*check|maybe\s+next\s+time|next\s+time|wish\s+i\s+could|would\s+love\s+to\s+but|stuck\s+here|stuck\s+in\s+the\s+chat|i'd\s+rather\s+not|i\s+would\s+rather\s+not|not\s+really|no\s+thanks|nope|i'm\s+good|im\s+good)\b/iu;

const NON_PHYSICAL_QUALIFIER =
  /\b(?:in\s+spirit|virtually|metaphorically|figuratively|not\s+literally|just\s+kidding|only\s+joking|in\s+(?:the|this)\s+chat|inside\s+(?:the|this)\s+chat|in\s+my\s+head|mentally|coming\s+back\s+to\s+(?:that|this|it|the\s+(?:topic|point|question)))\b/iu;

const HYPOTHETICAL_ACCEPTANCE =
  /\b(?:if\s+i\s+(?:could|were|was|had)|if\s+i\s+(?:was|were)\s+able|what\s+if|hypothetically|suppose|supposing|imagine)\b/iu;

const CHAT_QUALIFIER =
  /\b(?:outside|heading\s+out|leaving|out)\s+(?:of\s+)?(?:the|this)\s+(?:chat|conversation|thread|group)\b/iu;

const NEGATION =
  /\b(?:not|never|no\s+longer|no|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|cannot|can't|can’t|won't|won’t|wouldn't|wouldn’t|shouldn't|shouldn’t|couldn't|couldn’t|without)\b/iu;

const REPORTED_SPEECH =
  /\b(?:said|says|told|tells|asked|asks|thinks|thought|claims|claimed|wrote|writes|according\s+to)\b/iu;

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function classifyExistenceTrigger(text: string): ExistenceTriggerKind {
  if (typeof text !== 'string') {
    return 'none';
  }
  const normalized = normalizeText(text);
  if (!normalized) {
    return 'none';
  }
  if (matchesAny(normalized, INVITATION_PATTERNS)) {
    return 'physical-invitation';
  }
  if (matchesAny(normalized, LOCATION_PATTERNS)) {
    return 'location-query';
  }
  if (matchesAny(normalized, OFFLINE_ACTIVITY_PATTERNS)) {
    return 'offline-activity-query';
  }
  if (matchesAny(normalized, SCHEDULE_PATTERNS)) {
    return 'schedule-query';
  }
  return 'none';
}

export function hasExplicitFictionMarker(text: string): boolean {
  return typeof text === 'string' && FICTION_MARKER.test(text);
}

export function isExplicitFictionContext(texts: readonly string[]): boolean {
  return texts.some(text => hasExplicitFictionMarker(text));
}

function stripQuotedSegments(text: string): string {
  return text
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/gu, ' ')
    .trim();
}

function clausePrefix(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 80), index);
  const boundary = Math.max(
    prefix.lastIndexOf(','),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf('\n'),
  );
  return prefix.slice(boundary + 1).trim();
}

function isNegated(text: string, index: number, matchLength: number): boolean {
  if (NEGATION.test(clausePrefix(text, index))) {
    return true;
  }
  const suffix = text.slice(index + matchLength, index + matchLength + 40);
  return NEGATION.test(suffix);
}

function isReportedSpeech(text: string, index: number): boolean {
  const clause = clausePrefix(text, index);
  if (!clause) {
    return false;
  }
  if (/\b(?:i|we)\s+(?:said|told|asked|wrote)\b/iu.test(clause)) {
    return false;
  }
  return REPORTED_SPEECH.test(clause);
}

function isHypothetical(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  const boundary = Math.max(
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf('\n'),
  );
  const sentence = text.slice(boundary + 1, index + 100);
  return /\b(?:if\s+i\s+(?:could|were|was|had)|if\s+i\s+(?:was|were)\s+able|what\s+if|hypothetically|in\s+a\s+hypothetical|suppose|supposing|imagine)\b/iu.test(sentence);
}

function isNonPhysicalQualified(
  text: string,
  index: number,
  matchLength: number,
): boolean {
  const around = text.slice(
    index,
    Math.min(text.length, index + matchLength + 80),
  );
  return NON_PHYSICAL_QUALIFIER.test(around) || CHAT_QUALIFIER.test(around);
}

function hasExplicitClaim(
  text: string,
  pattern: RegExp,
  reason: ExistenceViolationReason,
): { reason: ExistenceViolationReason; match: string } | null {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (!isNegated(text, match.index, match[0].length) &&
        !isReportedSpeech(text, match.index) &&
        !isHypothetical(text, match.index) &&
        !isNonPhysicalQualified(text, match.index, match[0].length)) {
      return { reason, match: match[0] };
    }
    if (match.index === matcher.lastIndex) {
      matcher.lastIndex += 1;
    }
  }
  return null;
}

function hasClearDeclineOrDeflection(text: string): boolean {
  return DECLINE_OR_DEFLECTION.test(text);
}

function hasImplicitAcceptance(text: string): boolean {
  return IMPLICIT_ACCEPTANCE.test(text);
}

export function validateReplyExistence(
  reply: string,
  options: ExistenceValidationOptions = {},
): ExistenceValidationResult {
  const triggerKind = options.trigger
    ? classifyExistenceTrigger(options.trigger.text)
    : 'none';
  if (typeof reply !== 'string') {
    return { valid: true, triggerKind };
  }
  const normalized = normalizeText(reply);
  if (!normalized) {
    return { valid: true, triggerKind };
  }
  if (options.fiction ||
      (options.trigger ? hasExplicitFictionMarker(options.trigger.text) : false)) {
    return { valid: true, triggerKind };
  }

  const detectionText = stripQuotedSegments(normalized);
  if (!detectionText) {
    return { valid: true, triggerKind };
  }

  const explicitClaims: Array<{
    pattern: RegExp;
    reason: ExistenceViolationReason;
  }> = [
    { pattern: FIRST_PERSON_MOVEMENT, reason: 'physical-movement-claim' },
    { pattern: IMPLIED_MOVEMENT, reason: 'physical-movement-claim' },
    { pattern: FIRST_PERSON_LOCATION, reason: 'location-claim' },
    { pattern: EXPLICIT_SCHEDULE, reason: 'schedule-claim' },
    { pattern: EXPLICIT_OFFLINE_ROUTINE, reason: 'offline-routine-claim' },
  ];

  for (const claim of explicitClaims) {
    const result = hasExplicitClaim(detectionText, claim.pattern, claim.reason);
    if (result) {
      return {
        valid: false,
        reason: result.reason,
        match: result.match,
        triggerKind,
      };
    }
  }

  if ((triggerKind === 'physical-invitation' ||
       triggerKind === 'schedule-query') &&
      !hasClearDeclineOrDeflection(detectionText) &&
      !HYPOTHETICAL_ACCEPTANCE.test(detectionText) &&
      hasImplicitAcceptance(detectionText)) {
    return {
      valid: false,
      reason: triggerKind === 'schedule-query'
        ? 'schedule-claim'
        : 'physical-invitation-acceptance',
      match: 'implicit acceptance of a physical invitation',
      triggerKind,
    };
  }

  return { valid: true, triggerKind };
}
