export interface LogScrollState {
  readonly offset: number;
  readonly maximumOffset: number;
  readonly visibleLines: number;
  readonly totalLines: number;
  readonly unseenCount: number;
  readonly pinned: boolean;
}

export interface LogScrollAdvanceInput {
  readonly offset: number;
  readonly unseenCount: number;
  readonly knownTotalLines: number;
}

export interface LogScrollAdvance {
  readonly offset: number;
  readonly unseenCount: number;
  readonly knownTotalLines: number;
}

export function clampScrollOffset(offset: number, maximumOffset: number): number {
  const normalized = Number.isFinite(offset) ? Math.floor(offset) : 0;
  return Math.max(0, Math.min(normalized, Math.max(0, maximumOffset)));
}

export function resolveLogScrollState(
  totalLines: number,
  capacity: number,
  requestedOffset: number,
  unseenCount: number,
): LogScrollState {
  const total = Math.max(0, Math.floor(Number.isFinite(totalLines) ? totalLines : 0));
  const visibleCapacity = Math.max(0, Math.floor(Number.isFinite(capacity) ? capacity : 0));
  const maximumOffset = Math.max(0, total - visibleCapacity);
  const offset = clampScrollOffset(requestedOffset, maximumOffset);
  return {
    offset,
    maximumOffset,
    visibleLines: Math.min(visibleCapacity, total),
    totalLines: total,
    unseenCount: offset === 0 ? 0 : Math.max(0, unseenCount),
    pinned: offset === 0,
  };
}

export function advanceLogScroll(
  previous: LogScrollAdvanceInput,
  totalLines: number,
  maximumOffset: number,
  appendedLines?: number,
): LogScrollAdvance {
  if (previous.offset <= 0) {
    return { offset: 0, unseenCount: 0, knownTotalLines: totalLines };
  }
  const netAdded = totalLines - previous.knownTotalLines;
  const added = appendedLines !== undefined
    ? Math.max(0, Math.floor(appendedLines))
    : Math.max(0, netAdded);
  const offset = clampScrollOffset(
    previous.offset + added,
    maximumOffset,
  );
  return {
    offset,
    unseenCount: offset === 0 ? 0 : previous.unseenCount + 1,
    knownTotalLines: totalLines,
  };
}
