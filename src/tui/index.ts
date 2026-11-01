import {
  requestRuntimeStatusSnapshot,
  type RuntimeStatusSnapshotResult,
} from '../runtime-control.js';
import {
  DEFAULT_MAXIMUM_LOG_ENTRIES,
  DashboardLogBuffer,
  captureConsoleOutput,
  type ConsoleCapture,
  type ConsoleCaptureOptions,
  type DashboardLogEntry,
} from './logs.js';
import {
  createInitialDashboardView,
  getDashboardPromptCursor,
  renderDashboardLines,
  type DashboardDimensions,
  type DashboardView,
} from './layout.js';
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

export type {
  DashboardCommandApi,
  DashboardCommandHint,
  DashboardCommandKey,
  DashboardNotice,
  DashboardNoticeTone,
  DashboardPrompt,
} from './commands.js';

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

const ALTERNATE_SCREEN_ENTER = '\u001b[?1049h';
const ALTERNATE_SCREEN_EXIT = '\u001b[?1049l';
const CURSOR_HIDE = '\u001b[?25l';
const CURSOR_SHOW = '\u001b[?25h';
const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const ESCAPE_SEQUENCE_TIMEOUT_MS = 30;
const SUCCESS_NOTICE_TIMEOUT_MS = 4_000;

export class DashboardTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardTerminalError';
  }
}

export type DashboardTerminalCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function checkDashboardTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): DashboardTerminalCheck {
  if (!input.isTTY) {
    return { ok: false, reason: 'stdin is not an interactive terminal.' };
  }
  if (!output.isTTY) {
    return { ok: false, reason: 'stdout is not an interactive terminal.' };
  }
  if (typeof input.setRawMode !== 'function') {
    return { ok: false, reason: 'stdin does not support raw-mode input.' };
  }
  return { ok: true };
}

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
  now?: () => Date;
  onInterrupt?: () => void;
  commands?: DashboardCommandApi;
  color?: boolean;
}

export interface DashboardSession {
  closed: Promise<void>;
  close(): Promise<void>;
  refresh(): Promise<void>;
}

function getDimensions(output: NodeJS.WriteStream): DashboardDimensions {
  return {
    columns: output.columns ?? 80,
    rows: output.rows ?? 24,
  };
}

function sameLines(left: string[] | undefined, right: string[]): boolean {
  if (left === undefined || left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startDashboard(
  options: DashboardOptions = {},
): Promise<DashboardSession> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = checkDashboardTerminal(input, output);
  if (!terminal.ok) {
    throw new DashboardTerminalError(`The dashboard cannot start: ${terminal.reason}`);
  }

  const requestStatus = options.requestStatus ?? requestRuntimeStatusSnapshot;
  const pollIntervalMs = Math.max(
    1,
    Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );
  const logCapacity = options.maximumLogEntries ??
    options.maximumCapturedConsoleLines ??
    DEFAULT_MAXIMUM_LOG_ENTRIES;
  const logBuffer = new DashboardLogBuffer(logCapacity);
  const commands = options.commands;
  const colorEnabled = options.color ?? (
    output === process.stdout &&
    output.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== 'dumb'
  );
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  let statusView = createInitialDashboardView();
  let prompt: DashboardPrompt | undefined;
  let notice: DashboardNotice | undefined;
  let pending = false;
  let previousLines: string[] | undefined;
  let previousDimensions: DashboardDimensions | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingLogRender: NodeJS.Immediate | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let escapeBuffer = '';
  let cursorShown = false;
  let capturedConsole: ConsoleCapture | undefined;
  let inFlight = false;
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

  const writeOutput = (text: string): void => {
    if (closed) {
      return;
    }
    try {
      output.write(text);
    } catch {
      void close();
    }
  };

  const updateCursor = (view: DashboardView, dimensions: DashboardDimensions): void => {
    const cursor = getDashboardPromptCursor(view, dimensions);
    if (cursor === undefined) {
      if (cursorShown) {
        writeOutput(CURSOR_HIDE);
        cursorShown = false;
      }
      return;
    }
    if (!cursorShown) {
      writeOutput(CURSOR_SHOW);
      cursorShown = true;
    }
    writeOutput(`\u001b[${cursor.row};${cursor.column}H`);
  };

  const render = (): void => {
    if (closed) {
      return;
    }
    try {
      const dimensions = getDimensions(output);
      const view = buildView();
      const lines = renderDashboardLines(view, dimensions, { color: colorEnabled });
      const dimensionsChanged = previousDimensions === undefined ||
        previousDimensions.columns !== dimensions.columns ||
        previousDimensions.rows !== dimensions.rows;
      if (!dimensionsChanged && sameLines(previousLines, lines)) {
        return;
      }

      if (previousLines === undefined || dimensionsChanged) {
        writeOutput(
          CLEAR_SCREEN +
          lines.map((line, index) => `\u001b[${index + 1};1H\u001b[2K${line}`).join(''),
        );
      } else {
        const changed: string[] = [];
        const lineCount = Math.max(previousLines.length, lines.length);
        for (let index = 0; index < lineCount; index += 1) {
          if (previousLines[index] !== lines[index]) {
            changed.push(`\u001b[${index + 1};1H\u001b[2K${lines[index] ?? ''}`);
          }
        }
        if (changed.length > 0) {
          writeOutput(changed.join(''));
        }
      }
      previousLines = lines;
      previousDimensions = dimensions;
      updateCursor(view, dimensions);
    } catch {
      void close();
    }
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

  const appendLog = (entry: DashboardLogEntry): void => {
    if (closed) {
      return;
    }
    logBuffer.add(entry);
    scheduleLogRender();
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
    } catch {
      if (!closed) {
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
    if (transient) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        if (closed || notice !== next) {
          return;
        }
        notice = undefined;
        render();
      }, SUCCESS_NOTICE_TIMEOUT_MS);
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
    pendingMessage: string,
    operation: (api: DashboardCommandApi) => Promise<T>,
    interpret: (result: T) => CommandOutcome,
  ): Promise<void> => {
    if (closed || pending) {
      return;
    }
    if (commands === undefined) {
      showNotice('error', 'Command execution is unavailable.', false);
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
      showNotice('error', describeError(error), false);
    }
  };

  const runPause = async (): Promise<void> => {
    await runOperation(
      'Pausing...',
      api => api.pause(),
      result => result.status === 'paused'
        ? { ok: true, message: 'Engine paused.' }
        : { ok: false, message: 'No impractical-bot engine is running.' },
    );
  };

  const runResume = async (): Promise<void> => {
    await runOperation(
      'Resuming...',
      api => api.resume(),
      result => result.status === 'resumed'
        ? { ok: true, message: 'Engine resumed.' }
        : { ok: false, message: 'No impractical-bot engine is running.' },
    );
  };

  const runChangeDestination = async (destination: string): Promise<void> => {
    await runOperation(
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
        if (result.status === 'rejected') {
          return {
            ok: false,
            message:
              `Destination change rejected: ${result.reason} ` +
              (result.resumed
                ? 'The engine resumed at the previous destination.'
                : 'The engine remains paused.'),
          };
        }
        if (result.status === 'failed') {
          return {
            ok: false,
            message:
              `Destination change failed: ${result.reason} ` +
              (result.resumed
                ? 'The engine resumed at the previous destination.'
                : 'The engine remains paused.'),
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
          return { ok: false, message: `Temperament change failed: ${result.reason}` };
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
          return { ok: false, message: `Personality change failed: ${result.reason}` };
        }
        return { ok: false, message: 'No impractical-bot engine is running.' };
      },
    );
  };

  const runStop = async (): Promise<void> => {
    await runOperation(
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
        error: `Personality instruction cannot exceed ${maximum} characters.`,
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
        prompt = { ...prompt, error: 'Personality instruction must not be empty.' };
        render();
      }
      return;
    }
    const maximum = maximumPersonalityInstructionLength();
    if (instruction.length > maximum) {
      if (prompt?.kind === 'personalityInstruction') {
        prompt = {
          ...prompt,
          error: `Personality instruction cannot exceed ${maximum} characters.`,
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
    if (character === 'c' || character === 'C') {
      void close();
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

  const handleEscapeSequence = (sequence: string): void => {
    if (sequence === '\u001b[3~' && prompt !== undefined) {
      backspacePrompt();
    }
  };

  const scheduleEscapeFlush = (): void => {
    if (escapeTimer !== undefined) {
      clearTimeout(escapeTimer);
    }
    escapeTimer = setTimeout(() => {
      escapeTimer = undefined;
      const buffered = escapeBuffer;
      escapeBuffer = '';
      if (buffered === '\u001b') {
        handleEscapeKey();
      }
    }, ESCAPE_SEQUENCE_TIMEOUT_MS);
  };

  const processInputText = (text: string): void => {
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (character === '\u001b') {
        if (index + 1 >= text.length) {
          escapeBuffer = '\u001b';
          scheduleEscapeFlush();
          return;
        }
        const next = text[index + 1];
        if (next === '[' || next === 'O') {
          let cursor = index + 2;
          let complete = false;
          while (cursor < text.length) {
            const code = text.charCodeAt(cursor);
            cursor += 1;
            if (code >= 0x40 && code <= 0x7e) {
              complete = true;
              break;
            }
          }
          if (!complete) {
            escapeBuffer = text.slice(index);
            scheduleEscapeFlush();
            return;
          }
          handleEscapeSequence(text.slice(index, cursor));
          index = cursor;
          continue;
        }
        index += 2;
        continue;
      }
      handleCharacter(character);
      index += 1;
    }
  };

  const handleCharacter = (character: string): void => {
    if (character === '\u0003') {
      try {
        if (options.onInterrupt) {
          options.onInterrupt();
        } else {
          void close();
        }
      } catch {
        void close();
      }
      return;
    }
    if (prompt !== undefined) {
      handlePromptCharacter(character);
      return;
    }
    handleDashboardKey(character);
  };

  const onInputError = (): void => {
    void close();
  };
  const onOutputError = (): void => {
    void close();
  };
  const onResize = (): void => {
    previousLines = undefined;
    render();
  };
  const onData = (chunk: Buffer | string): void => {
    if (closed) {
      return;
    }
    let text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) {
      return;
    }

    if (escapeBuffer.length > 0) {
      const clearEscapeTimer = (): void => {
        if (escapeTimer !== undefined) {
          clearTimeout(escapeTimer);
          escapeTimer = undefined;
        }
      };
      if (
        escapeBuffer === '\u001b' &&
        !text.startsWith('[') &&
        !text.startsWith('O')
      ) {
        clearEscapeTimer();
        escapeBuffer = '';
        handleEscapeKey();
      } else {
        text = escapeBuffer + text;
        escapeBuffer = '';
        clearEscapeTimer();
      }
    }

    processInputText(text);
  };

  function close(): Promise<void> {
    if (closed) {
      return closedPromise;
    }
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
    if (escapeTimer !== undefined) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
    escapeBuffer = '';
    input.removeListener('data', onData);
    input.removeListener('error', onInputError);
    output.removeListener('resize', onResize);
    output.removeListener('error', onOutputError);
    try {
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(wasRaw);
      }
    } catch {
      // Terminal restoration is best effort during teardown.
    }
    try {
      if (!wasFlowing) {
        input.pause();
      }
    } catch {
      // Input restoration is best effort during teardown.
    }
    try {
      capturedConsole?.restore();
    } catch {
      // Console restoration is best effort during teardown.
    }
    try {
      output.write(`${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`);
    } catch {
      // The terminal may already be gone; there is nothing else to restore.
    }
    resolveClosed();
    return closedPromise;
  }

  try {
    const captureOptions: ConsoleCaptureOptions = {
      onEntry: appendLog,
      now: options.now,
    };
    if (options.captureConsoleOutput) {
      capturedConsole = captureConsoleOutput(logBuffer.capacity, captureOptions);
    }
    output.write(`${ALTERNATE_SCREEN_ENTER}${CURSOR_HIDE}${CLEAR_SCREEN}`);
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.on('data', onData);
    input.on('error', onInputError);
    output.on('resize', onResize);
    output.on('error', onOutputError);
    input.resume();
    render();
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
    refresh: requestStatusSafely,
  };
}
