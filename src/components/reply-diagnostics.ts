import { fingerprintMessageText } from './message-identity.js';

export interface GenerationDiagnosticInput {
  packetId: string;
  packetType: string;
  stage: string;
  attempt?: string;
  triggerId?: string | null;
  targetId?: string | null;
  text: string;
  previousText?: string;
  outcome?: string;
  reason?: string;
  fields?: readonly string[];
}

export interface TextChangeDescription {
  removedPrefix: string;
  removedSuffix: string;
}

export function boundedDiagnosticPreview(text: string, limit = 160): string {
  const value = typeof text === 'string' ? text : '';
  const truncated = value.length > limit ? `${value.slice(0, limit)}...` : value;
  return JSON.stringify(truncated);
}

export function describeTextChange(before: string, after: string): TextChangeDescription {
  const retainedIndex = before.indexOf(after);
  if (retainedIndex !== -1) {
    return {
      removedPrefix: before.slice(0, retainedIndex),
      removedSuffix: before.slice(retainedIndex + after.length),
    };
  }
  return { removedPrefix: before, removedSuffix: '' };
}

export function formatGenerationDiagnostic({
  packetId,
  packetType,
  stage,
  attempt,
  triggerId = null,
  targetId = null,
  text,
  previousText,
  outcome,
  reason,
  fields = [],
}: GenerationDiagnosticInput): string {
  const parts = [
    '[generation]',
    `packet=${packetId || 'unknown'}`,
    `type=${packetType || 'unknown'}`,
    `stage=${stage}`,
  ];
  if (attempt !== undefined) {
    parts.push(`attempt=${attempt}`);
  }
  if (outcome !== undefined) {
    parts.push(`outcome=${outcome}`);
  }
  if (reason !== undefined) {
    parts.push(`reason=${reason || 'none'}`);
  }
  parts.push(`trigger=${triggerId ?? 'none'}`);
  parts.push(`target=${targetId ?? 'none'}`);
  if (previousText === undefined) {
    parts.push(`chars=${String(text.length)}`);
    parts.push(`hash=${fingerprintMessageText(text)}`);
  } else {
    parts.push(`chars=${String(previousText.length)}->${String(text.length)}`);
    parts.push(
      `hash=${fingerprintMessageText(previousText)}->${fingerprintMessageText(text)}`,
    );
  }
  parts.push(`preview=${boundedDiagnosticPreview(text)}`);
  parts.push(...fields);
  return parts.join(' ');
}
