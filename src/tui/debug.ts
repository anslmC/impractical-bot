import {
  DEFAULT_MAXIMUM_LOG_ENTRIES,
  DashboardLogBuffer,
  dashboardLogCategory,
  formatDebugLogEntries,
  sanitizeLogText,
  type DashboardLogEntry,
} from './logs.js';
import {
  centerVisible,
  padVisible,
  paint,
  renderLine,
  truncateVisible,
  type StyledSegment,
} from './theme.js';
import {
  DashboardTerminalError,
  checkDashboardTerminal,
  type TerminalDimensions,
  type TerminalHandoff,
} from './terminal.js';
import type { TerminalKey } from './input.js';
import { advanceLogScroll, resolveLogScrollState, type LogScrollState } from './scroll.js';
import { TerminalViewLifecycle } from './session.js';
import { renderPlainWordmark } from './wordmark.js';

export const DEBUG_VIEWPORT_SUBTITLE = 'DEBUG VIEWPORT';
export const DEBUG_EMPTY_LOGS_MESSAGE = 'Waiting for log output...';
export const DEBUG_SCROLL_CONTROLS = '[PgUp/PgDn] Scroll  [L] Latest';
export const DEBUG_QUIT_CONTROL = '[Ctrl+C] Quit';
export const DEBUG_SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
export const DEBUG_SPINNER_INTERVAL_MS = 120;

export interface DebugRenderOptions {
  readonly color?: boolean;
  readonly scrollOffset?: number;
  readonly unseenCount?: number;
  readonly activityMessage?: string;
  readonly spinnerFrame?: string;
}

export interface DebugViewportOptions {
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
  readonly logBuffer?: DashboardLogBuffer;
  readonly initialEntries?: readonly DashboardLogEntry[];
  readonly maximumLogEntries?: number;
  readonly maximumCapturedConsoleLines?: number;
  readonly captureConsoleOutput?: boolean;
  readonly color?: boolean;
  readonly now?: () => Date;
  readonly onInterrupt?: () => void;
  readonly handoff?: TerminalHandoff;
  readonly escapeTimeoutMs?: number;
  readonly spinnerIntervalMs?: number;
}

export type DebugScrollState = LogScrollState;

export interface DebugViewportSession {
  readonly closed: Promise<void>;
  close(): Promise<void>;
  closeForHandoff?(): Promise<TerminalHandoff | undefined>;
  refresh(): void;
  startActivity(message: string): void;
  stopActivity(): void;
  scrollBy(lines: number): void;
  scrollTo(offset: number): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  getScrollState(): DebugScrollState;
  getEntries(): DashboardLogEntry[];
}

interface DebugFrame {
  readonly lines: string[];
  readonly state: DebugScrollState;
}

export function formatDebugSpinnerMessage(message: string, frame: string): string {
  const sanitized = sanitizeLogText(message);
  const category = dashboardLogCategory(sanitized);
  if (category === undefined) {
    return `${frame} ${sanitized}`;
  }
  return `${category.indent}${category.chip}${category.gap}${frame} ${category.rest}`;
}

function entriesWithActivity(
  entries: readonly DashboardLogEntry[],
  activityMessage: string | undefined,
  spinnerFrame: string | undefined,
): readonly DashboardLogEntry[] {
  if (activityMessage === undefined || spinnerFrame === undefined) {
    return entries;
  }
  let target = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].message === activityMessage) {
      target = index;
      break;
    }
  }
  if (target < 0) {
    return entries;
  }
  return entries.map((entry, index) => index === target
    ? { ...entry, message: formatDebugSpinnerMessage(entry.message, spinnerFrame) }
    : entry);
}

function logCategoryWidth(entries: readonly DashboardLogEntry[]): number {
  return Math.min(
    8,
    entries.reduce(
      (maximum, entry) =>
        Math.max(maximum, dashboardLogCategory(entry.message)?.chip.length ?? 0),
      0,
    ),
  );
}

function debugLogLines(
  entries: readonly DashboardLogEntry[],
  width: number,
  color: boolean,
): string[] {
  if (entries.length === 0) {
    return [renderLine([{ text: DEBUG_EMPTY_LOGS_MESSAGE, tone: 'muted' }], width, color)];
  }
  return formatDebugLogEntries(entries, width, {
    color,
    categoryWidth: logCategoryWidth(entries),
  });
}

function debugRule(
  count: number,
  width: number,
  color: boolean,
): string {
  const lead = '── DEBUG LOGS ';
  const right = count > 0 ? `${count} ${count === 1 ? 'entry' : 'entries'}` : 'idle';
  const suffix = ` ${right} ──`;
  if (lead.length + suffix.length + 2 > width) {
    return renderLine([{ text: 'DEBUG LOGS', tone: 'heading' }], width, color);
  }
  const fill = Math.max(2, width - lead.length - suffix.length);
  return renderLine(
    [
      { text: lead, tone: 'heading' },
      { text: '─'.repeat(fill), tone: 'muted' },
      { text: suffix, tone: 'muted' },
    ],
    width,
    color,
  );
}

function debugHeader(
  entries: readonly DashboardLogEntry[],
  width: number,
  color: boolean,
): string[] {
  return [
    centerVisible(renderPlainWordmark({ color }), width),
    centerVisible(paint(DEBUG_VIEWPORT_SUBTITLE, 'muted', color), width),
    debugRule(entries.length, width, color),
  ];
}

function debugFooter(
  state: DebugScrollState,
  width: number,
  color: boolean,
): string[] {
  const controls = `${DEBUG_SCROLL_CONTROLS}  ${DEBUG_QUIT_CONTROL}`;
  const status: StyledSegment[] = [
    { text: state.pinned ? '● LIVE' : '● SCROLLBACK', tone: state.pinned ? 'value' : 'warning' },
  ];
  if (state.unseenCount > 0) {
    status.push({
      text: `  ${state.unseenCount} new ${state.unseenCount === 1 ? 'entry' : 'entries'}`,
      tone: 'warning',
    });
  }
  if (state.totalLines > 0) {
    status.push({
      text: `  ${Math.min(state.totalLines, state.offset + state.visibleLines)}/${state.totalLines}`,
      tone: 'muted',
    });
  }
  return [
    renderLine([{ text: controls, tone: 'muted' }], width, color),
    renderLine(status, width, color),
  ];
}

function buildDebugFrame(
  entries: readonly DashboardLogEntry[],
  dimensions: TerminalDimensions,
  color: boolean,
  scrollOffset: number,
  unseenCount: number,
  activityMessage?: string,
  spinnerFrame?: string,
): DebugFrame {
  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return {
      lines: [],
      state: resolveLogScrollState(0, 0, 0, unseenCount),
    };
  }

  const displayed = entriesWithActivity(entries, activityMessage, spinnerFrame);
  const header = debugHeader(displayed, columns, color);
  const all = debugLogLines(displayed, columns, color);
  const footerHeight = 2;
  const capacity = Math.max(0, rows - header.length - footerHeight);
  const state = resolveLogScrollState(all.length, capacity, scrollOffset, unseenCount);
  const footer = debugFooter(state, columns, color);

  if (capacity < 1) {
    const compact = [header[0], ...footer]
      .filter((line): line is string => line !== undefined)
      .slice(0, rows)
      .map(line => padVisible(truncateVisible(line, columns), columns));
    while (compact.length < rows) {
      compact.push(' '.repeat(columns));
    }
    return { lines: compact, state };
  }

  const end = all.length - state.offset;
  const start = Math.max(0, end - capacity);
  const visible = all.slice(start, end);
  while (visible.length < capacity) {
    visible.push(' '.repeat(columns));
  }
  return {
    lines: [
      ...header,
      ...visible.map(line => padVisible(line, columns)),
      ...footer,
    ]
      .slice(0, rows)
      .map(line => padVisible(line, columns)),
    state,
  };
}

export function renderDebugLines(
  entries: readonly DashboardLogEntry[],
  dimensions: TerminalDimensions,
  options: DebugRenderOptions = {},
): string[] {
  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return [];
  }
  return buildDebugFrame(
    entries,
    dimensions,
    options.color === true,
    options.scrollOffset ?? 0,
    options.unseenCount ?? 0,
    options.activityMessage,
    options.spinnerFrame,
  ).lines;
}

export async function startDebugView(
  options: DebugViewportOptions = {},
): Promise<DebugViewportSession> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = checkDashboardTerminal(input, output);
  if (!terminal.ok) {
    throw new DashboardTerminalError(terminal.reason);
  }

  const logCapacity = options.maximumLogEntries ??
    options.maximumCapturedConsoleLines ??
    DEFAULT_MAXIMUM_LOG_ENTRIES;
  const logBuffer = options.logBuffer ?? new DashboardLogBuffer(logCapacity);
  for (const entry of options.initialEntries ?? []) {
    logBuffer.add(entry);
  }
  const colorEnabled = options.color ?? (
    output === process.stdout &&
    output.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== 'dumb'
  );
  let scrollOffset = 0;
  let unseenCount = 0;
  let knownTotalLines = 0;
  let pendingRender: NodeJS.Immediate | undefined;
  let activityMessage: string | undefined;
  let activityFrameIndex = 0;
  let activityTimer: ReturnType<typeof setInterval> | undefined;

  const spinnerFrame = (): string | undefined => activityMessage === undefined
    ? undefined
    : DEBUG_SPINNER_FRAMES[activityFrameIndex];

  const clearActivityTimer = (): void => {
    if (activityTimer !== undefined) {
      clearInterval(activityTimer);
      activityTimer = undefined;
    }
  };

  const dimensions = (): TerminalDimensions => lifecycle.dimensions;

  const frameAt = (
    offset: number,
    unseen: number,
  ): DebugFrame => buildDebugFrame(
    logBuffer.getEntries(),
    dimensions(),
    colorEnabled,
    offset,
    unseen,
    activityMessage,
    spinnerFrame(),
  );

  const state = (): DebugScrollState => frameAt(scrollOffset, unseenCount).state;

  const commitFrame = (next: number): void => {
    if (lifecycle.isClosed) {
      return;
    }
    const frame = frameAt(next, unseenCount);
    scrollOffset = frame.state.offset;
    unseenCount = frame.state.unseenCount;
    knownTotalLines = frame.state.totalLines;
    lifecycle.render(frame.lines);
  };

  const render = (): void => commitFrame(scrollOffset);

  const scheduleRender = (): void => {
    if (lifecycle.isClosed || pendingRender !== undefined) {
      return;
    }
    pendingRender = setImmediate(() => {
      pendingRender = undefined;
      render();
    });
  };

  const startActivity = (message: string): void => {
    if (lifecycle.isClosed || message.length === 0) {
      return;
    }
    clearActivityTimer();
    activityMessage = message;
    activityFrameIndex = 0;
    scheduleRender();

    const requestedInterval = options.spinnerIntervalMs ?? DEBUG_SPINNER_INTERVAL_MS;
    const interval = Number.isFinite(requestedInterval) && requestedInterval > 0
      ? Math.floor(requestedInterval)
      : DEBUG_SPINNER_INTERVAL_MS;
    activityTimer = setInterval(() => {
      if (lifecycle.isClosed || activityMessage === undefined) {
        return;
      }
      activityFrameIndex = (activityFrameIndex + 1) % DEBUG_SPINNER_FRAMES.length;
      scheduleRender();
    }, interval);
    (activityTimer as { unref?: () => void }).unref?.();
  };

  const stopActivity = (): void => {
    if (activityMessage === undefined && activityTimer === undefined) {
      return;
    }
    clearActivityTimer();
    if (activityMessage !== undefined) {
      activityMessage = undefined;
      activityFrameIndex = 0;
      scheduleRender();
    }
  };

  const handleEntry = (): void => {
    if (lifecycle.isClosed) {
      return;
    }
    const measurement = frameAt(scrollOffset, unseenCount).state;
    const next = advanceLogScroll(
      { offset: scrollOffset, unseenCount, knownTotalLines },
      measurement.totalLines,
      measurement.maximumOffset,
    );
    scrollOffset = next.offset;
    unseenCount = next.unseenCount;
    knownTotalLines = next.knownTotalLines;
    scheduleRender();
  };

  const applyScroll = (next: number): void => commitFrame(next);

  const pageAmount = (): number => Math.max(1, state().visibleLines);

  const scrollToStart = (): void => applyScroll(Number.MAX_SAFE_INTEGER);
  const scrollToEnd = (): void => applyScroll(0);

  const interrupt = (): void => {
    try {
      options.onInterrupt?.();
    } catch {
      // Shutdown still falls through to terminal restoration.
    } finally {
      void close();
    }
  };

  const handleKey = (key: TerminalKey): void => {
    if (lifecycle.isClosed) {
      return;
    }
    switch (key) {
      case 'pageUp':
        applyScroll(scrollOffset + pageAmount());
        return;
      case 'pageDown':
        applyScroll(scrollOffset - pageAmount());
        return;
      case 'home':
        scrollToStart();
        return;
      case 'end':
        scrollToEnd();
        return;
      case 'up':
        applyScroll(scrollOffset + 1);
        return;
      case 'down':
        applyScroll(scrollOffset - 1);
        return;
      case 'ctrlC':
        interrupt();
        return;
      case 'escape':
        return;
      case 'enter':
      case 'backspace':
      case 'delete':
      case 'tab':
        return;
    }
  };

  const handleText = (text: string): void => {
    if (lifecycle.isClosed) {
      return;
    }
    for (const character of text) {
      if (character === 'l' || character === 'L') {
        scrollToEnd();
        continue;
      }
      if (character === 'g') {
        scrollToStart();
        continue;
      }
      if (character === 'G') {
        scrollToEnd();
      }
    }
  };

  const close = (): Promise<void> => lifecycle.close();
  const closeForHandoff = (): Promise<TerminalHandoff | undefined> =>
    lifecycle.closeForHandoff();

  const lifecycle = new TerminalViewLifecycle({
    input,
    output,
    handoff: options.handoff,
    escapeTimeoutMs: options.escapeTimeoutMs,
    logBuffer,
    captureConsoleOutput: options.captureConsoleOutput,
    now: options.now,
    onKey: handleKey,
    onText: handleText,
    onResize: () => {
      render();
    },
    onLogEntry: handleEntry,
    onFinalize: () => {
      clearActivityTimer();
      activityMessage = undefined;
      activityFrameIndex = 0;
      if (pendingRender !== undefined) {
        clearImmediate(pendingRender);
        pendingRender = undefined;
      }
    },
  });

  await lifecycle.start(render);

  return {
    closed: lifecycle.closed,
    close,
    closeForHandoff,
    refresh: render,
    startActivity,
    stopActivity,
    scrollBy: lines => applyScroll(scrollOffset + lines),
    scrollTo: offset => applyScroll(offset),
    scrollToStart,
    scrollToEnd,
    getScrollState: state,
    getEntries: () => logBuffer.getEntries(),
  };
}
