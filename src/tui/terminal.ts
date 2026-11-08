import {
  TerminalInputParser,
  type TerminalInputParserOptions,
  type TerminalKey,
} from './input.js';

export const ALTERNATE_SCREEN_ENTER = '\u001b[?1049h';
export const ALTERNATE_SCREEN_EXIT = '\u001b[?1049l';
export const CURSOR_HIDE = '\u001b[?25l';
export const CURSOR_SHOW = '\u001b[?25h';
export const CLEAR_SCREEN = '\u001b[2J\u001b[H';

export class DashboardTerminalError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('Dashboard requires an interactive terminal.');
    this.name = 'DashboardTerminalError';
    this.detail = detail;
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

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalCursorPosition {
  readonly row: number;
  readonly column: number;
}

export interface TerminalRenderOptions {
  readonly cursor?: TerminalCursorPosition;
}

export interface TerminalHandoff {
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly rawModeSet: boolean;
  readonly enteredAlternateScreen: boolean;
}

export interface TerminalCloseOptions {
  readonly preserveState?: boolean;
}

export interface TerminalSessionOptions extends TerminalInputParserOptions {
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
  readonly onKey?: (key: TerminalKey) => void;
  readonly onText?: (text: string) => void;
  readonly onResize?: (dimensions: TerminalDimensions) => void;
  readonly handoff?: TerminalHandoff;
}

let activeTerminalOwner: object | undefined;

export function restoreTerminalState(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  state: TerminalHandoff,
): void {
  if (state.rawModeSet) {
    try {
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(state.wasRaw);
      }
    } catch {
      // Terminal restoration is best effort during teardown.
    }
  }
  if (!state.wasFlowing) {
    try {
      input.pause();
    } catch {
      // Input restoration is best effort during teardown.
    }
  }
  if (state.enteredAlternateScreen) {
    try {
      output.write(`${CURSOR_SHOW}${ALTERNATE_SCREEN_EXIT}`);
    } catch {
      // The terminal may already be gone; there is nothing else to restore.
    }
  }
}

export class TerminalSession {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly closed: Promise<void>;
  private readonly onKey: ((key: TerminalKey) => void) | undefined;
  private readonly onText: ((text: string) => void) | undefined;
  private readonly onResizeCallback:
    | ((dimensions: TerminalDimensions) => void)
    | undefined;
  private readonly parser: TerminalInputParser;
  private readonly owner = {};
  private readonly handoff: TerminalHandoff | undefined;
  private readonly wasRaw: boolean;
  private readonly wasFlowing: boolean;
  private previousLines: string[] | undefined;
  private previousDimensions: TerminalDimensions | undefined;
  private previousCursor: TerminalCursorPosition | undefined;
  private cursorVisible = false;
  private closedState = false;
  private started = false;
  private ownsTerminal = false;
  private enteredAlternateScreen = false;
  private rawModeSet = false;
  private resolveClosed!: () => void;

  constructor(options: TerminalSessionOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.onKey = options.onKey;
    this.onText = options.onText;
    this.onResizeCallback = options.onResize;
    this.handoff = options.handoff;
    this.wasRaw = options.handoff?.wasRaw ?? this.input.isRaw === true;
    this.wasFlowing = options.handoff?.wasFlowing ?? this.input.readableFlowing === true;
    this.rawModeSet = options.handoff?.rawModeSet ?? false;
    this.enteredAlternateScreen = options.handoff?.enteredAlternateScreen ?? false;
    this.parser = new TerminalInputParser(event => {
      if (this.closedState) {
        return;
      }
      if (event.type === 'key') {
        this.onKey?.(event.key);
      } else {
        this.onText?.(event.text);
      }
    }, { escapeTimeoutMs: options.escapeTimeoutMs });
    this.closed = new Promise<void>(resolve => {
      this.resolveClosed = resolve;
    });
  }

  get isClosed(): boolean {
    return this.closedState;
  }

  get dimensions(): TerminalDimensions {
    return {
      columns: this.output.columns ?? 80,
      rows: this.output.rows ?? 24,
    };
  }

  start(): void {
    if (this.closedState) {
      throw new Error('The terminal session is already closed.');
    }
    if (this.started) {
      return;
    }
    if (activeTerminalOwner !== undefined) {
      throw new Error('Another terminal view is already active.');
    }

    activeTerminalOwner = this.owner;
    this.ownsTerminal = true;
    try {
      if (this.handoff === undefined) {
        this.output.write(`${ALTERNATE_SCREEN_ENTER}${CURSOR_HIDE}${CLEAR_SCREEN}`);
        this.enteredAlternateScreen = true;
        if (typeof this.input.setRawMode === 'function') {
          this.input.setRawMode(true);
          this.rawModeSet = true;
        }
      } else {
        this.output.write(`${CURSOR_HIDE}${CLEAR_SCREEN}`);
      }
      this.input.on('data', this.handleInput);
      this.input.on('error', this.handleInputError);
      this.output.on('resize', this.handleResize);
      this.output.on('error', this.handleOutputError);
      this.input.resume();
      this.started = true;
    } catch (error) {
      void this.close();
      throw error;
    }
  }

  invalidate(): void {
    this.previousLines = undefined;
    this.previousDimensions = undefined;
    this.previousCursor = undefined;
  }

  render(lines: readonly string[], options: TerminalRenderOptions = {}): void {
    if (this.closedState || !this.started) {
      return;
    }
    try {
      const dimensions = this.dimensions;
      const next = [...lines];
      const dimensionsChanged = this.previousDimensions === undefined ||
        this.previousDimensions.columns !== dimensions.columns ||
        this.previousDimensions.rows !== dimensions.rows;
      if (!dimensionsChanged && sameLines(this.previousLines, next)) {
        this.updateCursor(options.cursor);
        return;
      }

      if (this.previousLines === undefined || dimensionsChanged) {
        this.write(
          CLEAR_SCREEN +
          next.map((line, index) => `\u001b[${index + 1};1H\u001b[2K${line}`).join(''),
        );
      } else {
        const changed: string[] = [];
        const lineCount = Math.max(this.previousLines.length, next.length);
        for (let index = 0; index < lineCount; index += 1) {
          if (this.previousLines[index] !== next[index]) {
            changed.push(`\u001b[${index + 1};1H\u001b[2K${next[index] ?? ''}`);
          }
        }
        if (changed.length > 0) {
          this.write(changed.join(''));
        }
      }
      this.previousLines = next;
      this.previousDimensions = dimensions;
      this.updateCursor(options.cursor);
    } catch {
      void this.close();
    }
  }

  async close(options: TerminalCloseOptions = {}): Promise<TerminalHandoff | undefined> {
    if (this.closedState) {
      return undefined;
    }
    this.closedState = true;
    this.parser.dispose();
    this.input.removeListener('data', this.handleInput);
    this.input.removeListener('error', this.handleInputError);
    this.output.removeListener('resize', this.handleResize);
    this.output.removeListener('error', this.handleOutputError);

    const handoff = options.preserveState === true
      ? {
          wasRaw: this.wasRaw,
          wasFlowing: this.wasFlowing,
          rawModeSet: this.rawModeSet,
          enteredAlternateScreen: this.enteredAlternateScreen,
        }
      : undefined;
    if (handoff === undefined) {
      restoreTerminalState(this.input, this.output, {
        wasRaw: this.wasRaw,
        wasFlowing: this.wasFlowing,
        rawModeSet: this.rawModeSet,
        enteredAlternateScreen: this.enteredAlternateScreen,
      });
      this.rawModeSet = false;
      this.enteredAlternateScreen = false;
    }
    if (this.ownsTerminal) {
      this.ownsTerminal = false;
      if (activeTerminalOwner === this.owner) {
        activeTerminalOwner = undefined;
      }
    }
    this.resolveClosed();
    return handoff;
  }

  private write(text: string): void {
    if (this.closedState) {
      return;
    }
    try {
      this.output.write(text);
    } catch {
      void this.close();
    }
  }

  private updateCursor(cursor: TerminalCursorPosition | undefined): void {
    if (cursor === undefined) {
      if (this.cursorVisible) {
        this.write(CURSOR_HIDE);
        this.cursorVisible = false;
        this.previousCursor = undefined;
      }
      return;
    }
    if (
      this.cursorVisible &&
      this.previousCursor?.row === cursor.row &&
      this.previousCursor.column === cursor.column
    ) {
      return;
    }
    if (!this.cursorVisible) {
      this.write(CURSOR_SHOW);
      this.cursorVisible = true;
    }
    this.write(`\u001b[${cursor.row};${cursor.column}H`);
    this.previousCursor = cursor;
  }

  private readonly handleInput = (chunk: Buffer | string): void => {
    if (this.closedState) {
      return;
    }
    this.parser.feed(chunk);
  };

  private readonly handleInputError = (): void => {
    void this.close();
  };

  private readonly handleOutputError = (): void => {
    void this.close();
  };

  private readonly handleResize = (): void => {
    if (this.closedState) {
      return;
    }
    this.invalidate();
    this.onResizeCallback?.(this.dimensions);
  };
}

function sameLines(left: string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
}
