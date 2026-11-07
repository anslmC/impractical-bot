import {
  requestRuntimeStatusSnapshot,
  type RuntimeStatusSnapshotResult,
} from '../runtime-control.js';
import {
  DEFAULT_MAXIMUM_LOG_ENTRIES,
  DashboardLogBuffer,
  captureConsoleOutput,
  formatDashboardLogEntries,
  type ConsoleCapture,
  type ConsoleCaptureOptions,
  type DashboardLogBufferChange,
  type DashboardLogEntry,
} from './logs.js';
import {
  createInitialDashboardView,
  getDashboardPromptCursor,
  renderDashboardFrame,
  type DashboardDimensions,
  type DashboardFrame,
  type DashboardLogScrollState,
  type DashboardView,
} from './layout.js';
import { advanceLogScroll } from './scroll.js';
import {
  isDashboardCommandAvailable,
  maximumPersonalityInstructionLength,
  personalityForSelection,
  personalityLabel,
  temperamentForSelection,
  temperamentLabel,
  validateDestinationInput,
  type DashboardCommandApi,
  type DashboardNotice,
  type DashboardNoticeTone,
  type DashboardPrompt,
} from './commands.js';
import {
  describeError,
  reportTuiDestinationFailure,
  reportTuiError,
  reportTuiStatusPollingFailure,
  type TuiErrorCategory,
} from './errors.js';
import {
  DashboardTerminalError,
  TerminalSession,
  checkDashboardTerminal,
  type TerminalHandoff,
} from './terminal.js';
import type { TerminalKey } from './input.js';

export type {
  DashboardCommandApi,
  DashboardCommandHint,
  DashboardCommandKey,
  DashboardNotice,
  DashboardNoticeTone,
  DashboardPrompt,
} from './commands.js';

export type {
  DashboardFrame,
  DashboardLogScrollState,
} from './layout.js';

export {
  DEFAULT_MAXIMUM_LOG_ENTRIES,
  DashboardLogBuffer,
  captureConsoleOutput,
  formatDashboardLogLine,
  formatLogTimestamp,
  sanitizeLogText,
  stripAnsi,
  type ConsoleCapture,
  type ConsoleCaptureOptions,
  type DashboardLogEntry,
  type DashboardLogLevel,
} from './logs.js';

export {
  DashboardTerminalError,
  checkDashboardTerminal,
  restoreTerminalState,
  type DashboardTerminalCheck,
  type TerminalHandoff,
} from './terminal.js';

export {
  DEBUG_EMPTY_LOGS_MESSAGE,
  DEBUG_QUIT_CONTROL,
  DEBUG_SCROLL_CONTROLS,
  DEBUG_SPINNER_FRAMES,
  DEBUG_SPINNER_INTERVAL_MS,
  DEBUG_VIEWPORT_SUBTITLE,
  formatDebugSpinnerMessage,
  renderDebugLines,
  startDebugView,
  type DebugRenderOptions,
  type DebugScrollState,
  type DebugViewportOptions,
  type DebugViewportSession,
} from './debug.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const SUCCESS_NOTICE_TIMEOUT_MS = 4_000;
const ERROR_NOTICE_TIMEOUT_MS = 6_000;

export interface DashboardOptions {
  configurationFilePath?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  requestStatus?: (
    configurationFilePath?: string,
  ) => Promise<RuntimeStatusSnapshotResult>;
  pollIntervalMs?: number;
  captureConsoleOutput?: boolean;
  maximumCapturedConsoleLines?: number;
  maximumLogEntries?: number;
  logBuffer?: DashboardLogBuffer;
  initialEntries?: readonly DashboardLogEntry[];
  now?: () => Date;
  onInterrupt?: () => void;
  onDebug?: () => void;
  handoff?: TerminalHandoff;
  commands?: DashboardCommandApi;
  color?: boolean;
  escapeTimeoutMs?: number;
}

export interface DashboardSession {
  closed: Promise<void>;
  close(): Promise<void>;
  closeForHandoff?(): Promise<TerminalHandoff | undefined>;
  refresh(): Promise<void>;
  getEntries?(): DashboardLogEntry[];
  getScrollState?(): DashboardLogScrollState;
  scrollBy?(lines: number): void;
  scrollToStart?(): void;
  scrollToEnd?(): void;
}

export interface ActiveDashboardSession extends DashboardSession {
  closeForHandoff(): Promise<TerminalHandoff | undefined>;
  getScrollState(): DashboardLogScrollState;
  scrollBy(lines: number): void;
  scrollToStart(): void;
  scrollToEnd(): void;
}

export type DashboardSessionFactory = (
  options?: DashboardOptions,
) => Promise<DashboardSession>;

function getDimensions(output: NodeJS.WriteStream): DashboardDimensions {
  return {
    columns: output.columns ?? 80,
    rows: output.rows ?? 24,
  };
}

function emptyView(
  connection: DashboardView['connection'],
  state: DashboardView['state'],
): DashboardView {
  return {
    connection,
    state,
    browser: 'Unknown',
    temperament: 'Unknown',
    personality: 'Unknown',
    messengerDestination: 'Unknown',
  };
}

interface CommandOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export async function startDashboard(
  options: DashboardOptions = {},
): Promise<ActiveDashboardSession> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = checkDashboardTerminal(input, output);
  if (!terminal.ok) {
    throw new DashboardTerminalError(terminal.reason);
  }

  const requestStatus = options.requestStatus ?? requestRuntimeStatusSnapshot;
  const pollIntervalMs = Math.max(
    1,
    Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );
  const logCapacity = options.maximumLogEntries ??
    options.maximumCapturedConsoleLines ??
    DEFAULT_MAXIMUM_LOG_ENTRIES;
  const logBuffer = options.logBuffer ?? new DashboardLogBuffer(logCapacity);
  if (options.initialEntries !== undefined) {
    for (const entry of options.initialEntries) {
      logBuffer.add(entry);
    }
  }
  const commands = options.commands;
  const colorEnabled = options.color ?? (
    output === process.stdout &&
    output.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== 'dumb'
  );
  let statusView = createInitialDashboardView();
  let prompt: DashboardPrompt | undefined;
  let notice: DashboardNotice | undefined;
  let pending = false;
  let scrollOffset = 0;
  let unseenCount = 0;
  let knownTotalLines = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingLogRender: NodeJS.Immediate | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let capturedConsole: ConsoleCapture | undefined;
  let unsubscribeLogs: (() => void) | undefined;
  let inFlight = false;
  let lastStatusFailure: string | undefined;
  let finalized = false;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  const buildView = (): DashboardView => ({
    ...statusView,
    logs: logBuffer.getEntries(),
    prompt,
    notice,
    pending,
    commandsEnabled: commands !== undefined,
  });

  const frameAt = (offset: number, unseen: number): DashboardFrame => {
    const dimensions = getDimensions(output);
    return renderDashboardFrame(buildView(), dimensions, {
      color: colorEnabled,
      scrollOffset: offset,
      unseenCount: unseen,
    });
  };

  const commitFrame = (offset: number, unseen: number): DashboardFrame => {
    const dimensions = getDimensions(output);
    const view = buildView();
    let frame = renderDashboardFrame(view, dimensions, {
      color: colorEnabled,
      scrollOffset: offset,
      unseenCount: unseen,
    });
    if (frame.state.offset === 0 && unseen !== 0) {
      frame = renderDashboardFrame(view, dimensions, {
        color: colorEnabled,
        scrollOffset: 0,
        unseenCount: 0,
      });
    }
    scrollOffset = frame.state.offset;
    unseenCount = frame.state.unseenCount;
    knownTotalLines = frame.state.totalLines;
    if (scrollOffset === 0) {
      unseenCount = 0;
    }
    terminalSession?.render(frame.lines, {
      cursor: getDashboardPromptCursor(view, dimensions),
    });
    return frame;
  };

  const render = (): void => {
    if (closed || terminalSession === undefined) {
      return;
    }
    try {
      commitFrame(scrollOffset, unseenCount);
    } catch {
      void close();
    }
  };

  const applyScroll = (next: number): void => {
    if (closed || terminalSession === undefined) {
      return;
    }
    try {
      commitFrame(next, unseenCount);
    } catch {
      void close();
    }
  };

  const pageAmount = (): number =>
    Math.max(1, frameAt(scrollOffset, unseenCount).state.visibleLines);

  const scrollToStart = (): void => applyScroll(Number.MAX_SAFE_INTEGER);
  const scrollToEnd = (): void => applyScroll(0);

  const handleLogEntry = (change?: DashboardLogBufferChange): void => {
    if (closed) {
      return;
    }
    const measurement = frameAt(scrollOffset, unseenCount).state;
    const appendedLines = change === undefined
      ? undefined
      : formatDashboardLogEntries(change.added, getDimensions(output).columns).length;
    const next = advanceLogScroll(
      { offset: scrollOffset, unseenCount, knownTotalLines },
      measurement.totalLines,
      measurement.maximumOffset,
      appendedLines,
    );
    scrollOffset = next.offset;
    unseenCount = next.unseenCount;
    knownTotalLines = next.knownTotalLines;
    scheduleLogRender();
  };

  const scheduleLogRender = (): void => {
    if (closed || pendingLogRender !== undefined) {
      return;
    }
    pendingLogRender = setImmediate(() => {
      pendingLogRender = undefined;
      render();
    });
  };

  const requestStatusSafely = async (): Promise<void> => {
    if (closed || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await requestStatus(options.configurationFilePath);
      if (closed) {
        return;
      }
      lastStatusFailure = undefined;
      if (result.status === 'running') {
        statusView = {
          connection: 'connected',
          state: result.state,
          browser: result.browser,
          temperament: result.temperament,
          personality: result.personality,
          messengerDestination: result.messengerDestination,
        };
      } else if (result.status === 'not-running') {
        statusView = emptyView('stopped', 'stopped');
      } else {
        statusView = emptyView('unsupported', 'disconnected');
      }
      render();
    } catch (error) {
      if (!closed) {
        const detail = describeError(error);
        if (detail !== lastStatusFailure) {
          lastStatusFailure = detail;
          reportTuiStatusPollingFailure(error);
        }
        statusView = emptyView('disconnected', 'disconnected');
        render();
      }
    } finally {
      inFlight = false;
    }
  };

  const clearNoticeTimer = (): void => {
    if (noticeTimer !== undefined) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  };

  const discardNotice = (): void => {
    clearNoticeTimer();
    notice = undefined;
  };

  const showNotice = (
    tone: DashboardNoticeTone,
    message: string,
    transient: boolean,
  ): void => {
    if (closed) {
      return;
    }
    clearNoticeTimer();
    const next: DashboardNotice = { tone, message, transient };
    notice = next;
    const timeoutMs = tone === 'error'
      ? ERROR_NOTICE_TIMEOUT_MS
      : transient ? SUCCESS_NOTICE_TIMEOUT_MS : undefined;
    if (timeoutMs !== undefined) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        if (closed || notice !== next) {
          return;
        }
        notice = undefined;
        render();
      }, timeoutMs);
    }
    render();
  };

  const clearNotice = (): void => {
    if (notice === undefined) {
      return;
    }
    discardNotice();
    render();
  };

  const openPrompt = (next: DashboardPrompt): void => {
    if (closed) {
      return;
    }
    discardNotice();
    prompt = next;
    render();
  };

  const cancelPrompt = (): void => {
    if (prompt === undefined) {
      return;
    }
    prompt = undefined;
    render();
  };

  const settleOutcome = async (outcome: CommandOutcome): Promise<void> => {
    pending = false;
    if (!outcome.ok) {
      showNotice('error', outcome.message, false);
      return;
    }
    showNotice('success', outcome.message, true);
    await requestStatusSafely();
  };

  const runOperation = async <T>(
    category: TuiErrorCategory,
    pendingMessage: string,
    operation: (api: DashboardCommandApi) => Promise<T>,
    interpret: (result: T) => CommandOutcome,
  ): Promise<void> => {
    if (closed || pending) {
      return;
    }
    if (commands === undefined) {
      showNotice('error', 'Dashboard commands are unavailable.', false);
      return;
    }

    pending = true;
    clearNoticeTimer();
    notice = { tone: 'pending', message: pendingMessage, transient: false };
    render();

    try {
      const result = await operation(commands);
      if (closed) {
        return;
      }
      await settleOutcome(interpret(result));
    } catch (error) {
      if (closed) {
        return;
      }
      pending = false;
      showNotice('error', reportTuiError(category, error), false);
    }
  };

  const runPause = async (): Promise<void> => {
    await runOperation(
      'pause',
      'Pausing...',
      api => api.pause(),
      result => result.status === 'paused'
        ? { ok: true, message: 'Engine paused.' }
        : { ok: false, message: 'No impractical-bot engine is running.' },
    );
  };

  const runResume = async (): Promise<void> => {
    await runOperation(
      'resume',
      'Resuming...',
      api => api.resume(),
      result => result.status === 'resumed'
        ? { ok: true, message: 'Engine resumed.' }
        : { ok: false, message: 'No impractical-bot engine is running.' },
    );
  };

  const runChangeDestination = async (destination: string): Promise<void> => {
    await runOperation(
      'destination',
      'Changing Messenger destination...',
      api => api.changeDestination(destination),
      result => {
        if (result.status === 'changed') {
          return {
            ok: true,
            message:
              `Messenger destination changed: ${destination}. ` +
              (result.resumed ? 'Engine resumed.' : 'Engine remains paused.'),
          };
        }
        if (result.status === 'rejected' || result.status === 'failed') {
          return {
            ok: false,
            message: reportTuiDestinationFailure(
              result.status,
              result.reason,
              result.resumed,
            ),
          };
        }
        return { ok: false, message: 'No impractical-bot engine is running.' };
      },
    );
  };

  const runSetTemperament = async (
    temperament: NonNullable<ReturnType<typeof temperamentForSelection>>,
  ): Promise<void> => {
    await runOperation(
      'temperament',
      'Changing temperament...',
      api => api.setTemperament(temperament),
      result => {
        if (result.status === 'changed') {
          return {
            ok: true,
            message: `Temperament set to ${temperamentLabel(temperament)}.`,
          };
        }
        if (result.status === 'failed') {
          return {
            ok: false,
            message: reportTuiError('temperament', result.reason),
          };
        }
        return { ok: false, message: 'No impractical-bot engine is running.' };
      },
    );
  };

  const runSetPersonality = async (
    mode: NonNullable<ReturnType<typeof personalityForSelection>>,
    instruction: string,
  ): Promise<void> => {
    await runOperation(
      'personality',
      'Changing personality...',
      api => api.setPersonality(mode, instruction),
      result => {
        if (result.status === 'changed') {
          return {
            ok: true,
            message: `Personality set to ${personalityLabel(mode)}.`,
          };
        }
        if (result.status === 'failed') {
          return {
            ok: false,
            message: reportTuiError('personality', result.reason),
          };
        }
        return { ok: false, message: 'No impractical-bot engine is running.' };
      },
    );
  };

  const runStop = async (): Promise<void> => {
    await runOperation(
      'stop',
      'Stopping engine...',
      api => api.stop(),
      result => result.status === 'stopped'
        ? { ok: true, message: 'Engine stopped.' }
        : { ok: false, message: 'No impractical-bot engine is running.' },
    );
  };

  const openDestinationPrompt = (): void => {
    openPrompt({ kind: 'destination', value: '' });
  };

  const openTemperamentPrompt = (): void => {
    openPrompt({ kind: 'temperament' });
  };

  const openPersonalityPrompt = (): void => {
    openPrompt({ kind: 'personality' });
  };

  const openStopConfirmation = (): void => {
    openPrompt({ kind: 'stopConfirmation' });
  };

  const selectTemperament = (selection: string): void => {
    const temperament = temperamentForSelection(selection);
    if (temperament === undefined) {
      return;
    }
    prompt = undefined;
    render();
    void runSetTemperament(temperament);
  };

  const selectPersonality = (selection: string): void => {
    const mode = personalityForSelection(selection);
    if (mode === undefined) {
      return;
    }
    if (mode === 'custom') {
      prompt = { kind: 'personalityInstruction', value: '' };
      render();
      return;
    }
    prompt = undefined;
    render();
    void runSetPersonality(mode, '');
  };

  const appendPromptText = (character: string): void => {
    if (prompt === undefined) {
      return;
    }
    if (prompt.kind === 'destination') {
      prompt = { ...prompt, value: prompt.value + character, error: undefined };
      render();
      return;
    }
    if (prompt.kind !== 'personalityInstruction') {
      return;
    }
    const maximum = maximumPersonalityInstructionLength();
    if (prompt.value.length + character.length > maximum) {
      prompt = {
        ...prompt,
        error: `Instruction too long (max ${maximum} characters).`,
      };
      render();
      return;
    }
    prompt = { ...prompt, value: prompt.value + character, error: undefined };
    render();
  };

  const backspacePrompt = (): void => {
    if (prompt === undefined) {
      return;
    }
    if (prompt.kind === 'destination') {
      const characters = Array.from(prompt.value);
      characters.pop();
      prompt = { ...prompt, value: characters.join(''), error: undefined };
      render();
      return;
    }
    if (prompt.kind !== 'personalityInstruction') {
      return;
    }
    const characters = Array.from(prompt.value);
    characters.pop();
    prompt = { ...prompt, value: characters.join(''), error: undefined };
    render();
  };

  const submitDestination = (value: string): void => {
    const validation = validateDestinationInput(value);
    if (!validation.ok) {
      if (prompt?.kind === 'destination') {
        prompt = { ...prompt, error: validation.message };
        render();
      }
      return;
    }
    prompt = undefined;
    render();
    void runChangeDestination(validation.value);
  };

  const submitPersonalityInstruction = (value: string): void => {
    const instruction = value.trim();
    if (instruction.length === 0) {
      if (prompt?.kind === 'personalityInstruction') {
        prompt = { ...prompt, error: 'Enter a personality instruction.' };
        render();
      }
      return;
    }
    const maximum = maximumPersonalityInstructionLength();
    if (instruction.length > maximum) {
      if (prompt?.kind === 'personalityInstruction') {
        prompt = {
          ...prompt,
          error: `Instruction too long (max ${maximum} characters).`,
        };
        render();
      }
      return;
    }
    prompt = undefined;
    render();
    void runSetPersonality('custom', instruction);
  };

  const submitPrompt = (): void => {
    if (prompt?.kind === 'destination') {
      submitDestination(prompt.value);
      return;
    }
    if (prompt?.kind === 'personalityInstruction') {
      submitPersonalityInstruction(prompt.value);
    }
  };

  const confirmStop = (): void => {
    prompt = undefined;
    render();
    void runStop();
  };

  const handlePromptCharacter = (character: string): void => {
    if (prompt === undefined) {
      return;
    }
    if (prompt.kind === 'stopConfirmation') {
      if (character === 'y' || character === 'Y') {
        confirmStop();
      } else if (character === 'n' || character === 'N') {
        prompt = undefined;
        render();
      }
      return;
    }
    if (prompt.kind === 'temperament') {
      selectTemperament(character);
      return;
    }
    if (prompt.kind === 'personality') {
      selectPersonality(character);
      return;
    }

    if (character === '\r' || character === '\n') {
      submitPrompt();
      return;
    }
    const code = character.charCodeAt(0);
    if (code === 8 || code === 127) {
      backspacePrompt();
      return;
    }
    if (code >= 32) {
      appendPromptText(character);
    }
  };

  const handleDashboardKey = (character: string): void => {
    if (character === 'd' || character === 'D') {
      if (options.onDebug !== undefined) {
        try {
          options.onDebug();
        } catch {
          // The view owner decides whether to close after a failed switch request.
        }
      } else {
        void close();
      }
      return;
    }
    if (character === 'l' || character === 'L') {
      scrollToEnd();
      return;
    }
    if (pending) {
      return;
    }
    const view = buildView();
    const key = character.toUpperCase();
    if (!isDashboardCommandAvailable(view, key)) {
      return;
    }
    switch (key) {
      case 'P':
        void runPause();
        return;
      case 'R':
        void runResume();
        return;
      case 'M':
        openDestinationPrompt();
        return;
      case 'T':
        openTemperamentPrompt();
        return;
      case 'Y':
        openPersonalityPrompt();
        return;
      case 'S':
        openStopConfirmation();
        return;
    }
  };

  const handleEscapeKey = (): void => {
    if (prompt !== undefined) {
      cancelPrompt();
      return;
    }
    if (notice?.tone === 'error') {
      clearNotice();
    }
  };

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
    if (key === 'ctrlC') {
      interrupt();
      return;
    }
    if (key === 'escape') {
      handleEscapeKey();
      return;
    }
    if (key === 'pageUp') {
      applyScroll(scrollOffset + pageAmount());
      return;
    }
    if (key === 'pageDown') {
      applyScroll(scrollOffset - pageAmount());
      return;
    }
    if (prompt === undefined) {
      switch (key) {
        case 'up':
          applyScroll(scrollOffset + 1);
          return;
        case 'down':
          applyScroll(scrollOffset - 1);
          return;
        case 'home':
          scrollToStart();
          return;
        case 'end':
          scrollToEnd();
          return;
      }
      return;
    }
    switch (key) {
      case 'enter':
        submitPrompt();
        return;
      case 'backspace':
      case 'delete':
        backspacePrompt();
        return;
      case 'up':
      case 'down':
      case 'home':
      case 'end':
      case 'tab':
        return;
    }
  };

  const handleText = (text: string): void => {
    if (closed) {
      return;
    }
    for (const character of text) {
      if (prompt !== undefined) {
        handlePromptCharacter(character);
      } else {
        handleDashboardKey(character);
      }
    }
  };

  const finalize = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    closed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (pendingLogRender !== undefined) {
      clearImmediate(pendingLogRender);
      pendingLogRender = undefined;
    }
    if (noticeTimer !== undefined) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
    unsubscribeLogs?.();
    unsubscribeLogs = undefined;
    try {
      capturedConsole?.restore();
    } catch {
      // Console restoration is best effort during teardown.
    }
    capturedConsole = undefined;
    resolveClosed();
  };

  async function closeWithOptions(
    preserveState: boolean,
  ): Promise<TerminalHandoff | undefined> {
    if (closed) {
      return undefined;
    }
    closed = true;
    const session = terminalSession;
    const handoff = session === undefined
      ? undefined
      : await session.close({ preserveState });
    finalize();
    return handoff;
  }

  async function close(): Promise<void> {
    await closeWithOptions(false);
  }

  const closeForHandoff = (): Promise<TerminalHandoff | undefined> =>
    closeWithOptions(true);

  const terminalSession = new TerminalSession({
    input,
    output,
    handoff: options.handoff,
    escapeTimeoutMs: options.escapeTimeoutMs,
    onKey: key => {
      if (!closed) {
        handleKey(key);
      }
    },
    onText: handleText,
    onResize: () => {
      render();
    },
  });
  void terminalSession.closed.then(finalize);

  try {
    const captureOptions: ConsoleCaptureOptions = {
      now: options.now,
      buffer: logBuffer,
    };
    if (options.captureConsoleOutput) {
      capturedConsole = captureConsoleOutput(logBuffer.capacity, captureOptions);
    }
    terminalSession.start();
    render();
    unsubscribeLogs = logBuffer.subscribe(handleLogEntry);
    timer = setInterval(() => {
      void requestStatusSafely();
    }, pollIntervalMs);
    void requestStatusSafely();
  } catch (error) {
    await close();
    throw error;
  }

  return {
    closed: closedPromise,
    close,
    closeForHandoff,
    refresh: requestStatusSafely,
    getEntries: () => logBuffer.getEntries(),
    getScrollState: () => frameAt(scrollOffset, unseenCount).state,
    scrollBy: lines => applyScroll(scrollOffset + lines),
    scrollToStart,
    scrollToEnd,
  };
}
