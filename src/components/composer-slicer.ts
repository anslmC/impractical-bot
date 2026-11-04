const PARAGRAPH_BREAK = /\n[^\S\n]*\n\s*/gu;
const SENTENCE_BREAK = /[.!?…]+["'”’)\]]*\s+/gu;
const CLAUSE_BREAK = /[,;:—–]+["'”’)\]]*\s+/gu;
const WORD_BREAK = /\s+/gu;
const HYPHEN_BREAK = /-(?=\S)/gu;

const BOUNDARY_PATTERNS: readonly RegExp[] = [
  PARAGRAPH_BREAK,
  SENTENCE_BREAK,
  CLAUSE_BREAK,
  WORD_BREAK,
];

const EXTENDED_BOUNDARY_PATTERNS: readonly RegExp[] = [...BOUNDARY_PATTERNS, HYPHEN_BREAK];

const MAXIMUM_TAIL_LENGTH = 80;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function lastBoundaryEnd(
  text: string,
  start: number,
  limit: number,
  minimumEnd: number,
  pattern: RegExp,
): number {
  pattern.lastIndex = start;
  let boundary = -1;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const end = match.index + match[0].length;
    if (end > limit) {
      break;
    }
    if (end >= minimumEnd) {
      boundary = end;
    }
    if (pattern.lastIndex <= match.index) {
      pattern.lastIndex = match.index + 1;
    }
  }
  return boundary;
}

function chooseBoundary(
  text: string,
  start: number,
  limit: number,
  minimumEnd: number,
  patterns: readonly RegExp[] = BOUNDARY_PATTERNS,
): number {
  if (minimumEnd > limit) {
    return -1;
  }
  for (const pattern of patterns) {
    const end = lastBoundaryEnd(text, start, limit, minimumEnd, pattern);
    if (end !== -1) {
      return end;
    }
  }
  return -1;
}

function surrogateSafeEnd(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length || end - start < 2) {
    return end;
  }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsPair = previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsPair ? end - 1 : end;
}

function hardEnd(text: string, start: number, maxCharacters: number): number {
  let end = start;
  for (const { segment } of graphemeSegmenter.segment(text.slice(start))) {
    if (end - start + segment.length > maxCharacters) {
      break;
    }
    end += segment.length;
  }
  if (end > start) {
    return end;
  }
  const strictEnd = Math.min(start + maxCharacters, text.length);
  const safeEnd = surrogateSafeEnd(text, start, strictEnd);
  return safeEnd > start ? safeEnd : start + 1;
}

function enforceLimit(text: string, chunks: readonly string[], maxCharacters: number): string[] {
  const verified: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) {
      continue;
    }
    if (chunk.length <= maxCharacters) {
      verified.push(chunk);
      continue;
    }
    let start = 0;
    while (start < chunk.length) {
      const end = Math.min(chunk.length, hardEnd(chunk, start, maxCharacters));
      verified.push(chunk.slice(start, end));
      start = end;
    }
  }
  if (verified.join('') !== text) {
    throw new Error('Composer slicing failed to preserve the original reply text.');
  }
  return verified;
}

export function sliceComposerMessage(text: string, maxCharacters: number): string[] {
  if (!isPositiveInteger(maxCharacters)) {
    throw new RangeError('maxCharacters must be a positive integer.');
  }
  if (text.length === 0) {
    return [];
  }
  if (text.length <= maxCharacters) {
    return [text];
  }

  const preferredLength = Math.ceil(maxCharacters / 2);
  const minimumTail = Math.max(
    1,
    Math.min(MAXIMUM_TAIL_LENGTH, Math.floor(maxCharacters / 4)),
  );
  const chunks: string[] = [];
  let start = 0;

  while (text.length - start > maxCharacters) {
    const limit = start + maxCharacters;
    let end = chooseBoundary(text, start, limit, start + preferredLength);
    if (end === -1) {
      end = chooseBoundary(text, start, limit, start + 1);
    }
    if (end === -1) {
      end = hardEnd(text, start, maxCharacters);
    }

    const remaining = text.length - end;
    if (remaining > 0 && remaining < minimumTail) {
      const earlierLimit = Math.min(end - 1, text.length - minimumTail);
      const rebalanced = chooseBoundary(
        text,
        start,
        earlierLimit,
        start + 1,
        EXTENDED_BOUNDARY_PATTERNS,
      );
      if (rebalanced !== -1) {
        end = rebalanced;
      }
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  chunks.push(text.slice(start));
  return enforceLimit(text, chunks, maxCharacters);
}
