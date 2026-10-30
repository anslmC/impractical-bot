import { format } from 'node:util';
import {
  requestRuntimeStatusSnapshot,
  type RuntimeStatusSnapshotResult,
} from '../runtime-control.js';
import {
  createInitialDashboardView,
  renderDashboardLines,
  type DashboardDimensions,
  type DashboardView,
} from './layout.js';

const ALTERNATE_SCREEN_ENTER = '\u001b[?1049h';
const ALTERNATE_SCREEN_EXIT = '\u001b[?1049l';
const CURSOR_HIDE = '\u001b[?25l';
const CURSOR_SHOW = '\u001b[?25h';
const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CAPTURED_CONSOLE_LINES = 500;

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

export function isDashboardTerminalSupported(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return checkDashboardTerminal(input, output).ok;
}

export interface ConsoleCapture {
  restore(): void;
  getLines(): string[];
}

const CAPTURED_CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type CapturedConsoleMethod = typeof CAPTURED_CONSOLE_METHODS[number];

export function captureConsoleOutput(
  maximumLines = DEFAULT_MAX_CAPTURED_CONSOLE_LINES,
): ConsoleCapture {
  const consoleRecord = console as unknown as Record<
    CapturedConsoleMethod,
    (...args: unknown[]) => void
  >;
  const originals = new Map<CapturedConsoleMethod, (...args: unknown[]) => void>();
  const lines: string[] = [];
  const limit = Math.max(1, Math.floor(maximumLines));

  const append = (args: unknown[]): void => {
    const text = format(...args);
    for (const line of text.split(/\r?\n/)) {
      lines.push(line);
      if (lines.length > limit) {
        lines.shift();
      }
    }
  };

  for (const method of CAPTURED_CONSOLE_METHODS) {
    const original = consoleRecord[method];
    originals.set(method, original);
    consoleRecord[method] = (...args: unknown[]) => append(args);
  }

  let restored = false;
  return {
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      for (const [method, original] of originals) {
        consoleRecord[method] = original;
      }
    },
    getLines() {
      return [...lines];
    },
  };
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
  const wasRaw = input.isRaw === true;
  let view = createInitialDashboardView();
  let previousLines: string[] | undefined;
  let previousDimensions: DashboardDimensions | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });
  const capturedConsole = options.captureConsoleOutput
    ? captureConsoleOutput(options.maximumCapturedConsoleLines)
    : undefined;

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

  const render = (): void => {
    if (closed) {
      return;
    }
    const dimensions = getDimensions(output);
    const lines = renderDashboardLines(view, dimensions);
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
        view = {
          connection: 'connected',
          state: result.state,
          browser: result.browser,
          temperament: result.temperament,
          personality: result.personality,
          messengerDestination: result.messengerDestination,
        };
      } else if (result.status === 'not-running') {
        view = emptyView('stopped', 'stopped');
      } else {
        view = emptyView('unsupported', 'disconnected');
      }
      render();
    } catch {
      if (!closed) {
        view = emptyView('disconnected', 'disconnected');
        render();
      }
    } finally {
      inFlight = false;
    }
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
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length > 0 && text[0] === '\u001b' && text.length > 1) {
      return;
    }
    for (const character of text) {
      if (character === 'c' || character === 'C') {
        void close();
        return;
      }
    }
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
    capturedConsole?.restore();
    try {
      output.write(`${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`);
    } catch {
      // The terminal may already be gone; there is nothing else to restore.
    }
    resolveClosed();
    return closedPromise;
  }

  try {
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
