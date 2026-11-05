export const DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS = 30;
export const MAXIMUM_ESCAPE_SEQUENCE_LENGTH = 64;

export type TerminalKey =
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'escape'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'ctrlC';

export type TerminalInputEvent =
  | { readonly type: 'key'; readonly key: TerminalKey }
  | { readonly type: 'text'; readonly text: string };

export type TerminalInputHandler = (event: TerminalInputEvent) => void;

export interface TerminalInputParserOptions {
  readonly escapeTimeoutMs?: number;
}

const CONTROL_KEYS: Readonly<Record<string, TerminalKey>> = {
  '\u0003': 'ctrlC',
  '\r': 'enter',
  '\n': 'enter',
  '\u007f': 'backspace',
  '\u0008': 'backspace',
  '\t': 'tab',
};

const CSI_FINAL_KEYS: Readonly<Record<string, TerminalKey>> = {
  A: 'up',
  B: 'down',
  H: 'home',
  F: 'end',
};

const CSI_TILDE_KEYS: Readonly<Record<number, TerminalKey>> = {
  1: 'home',
  3: 'delete',
  4: 'end',
  5: 'pageUp',
  6: 'pageDown',
  7: 'home',
  8: 'end',
};

function csiKey(sequence: string): TerminalKey | undefined {
  const final = sequence[sequence.length - 1];
  const body = sequence.slice(2, -1);
  if (final === '~') {
    const first = body.split(';')[0] ?? '';
    const code = Number.parseInt(first, 10);
    return Number.isNaN(code) ? undefined : CSI_TILDE_KEYS[code];
  }
  return CSI_FINAL_KEYS[final];
}

function ss3Key(sequence: string): TerminalKey | undefined {
  return CSI_FINAL_KEYS[sequence[sequence.length - 1]];
}

function isPrintable(codePoint: number): boolean {
  return codePoint >= 0x20 &&
    codePoint !== 0x7f &&
    !(codePoint >= 0x80 && codePoint <= 0x9f);
}

export class TerminalInputParser {
  private readonly emitEvent: TerminalInputHandler;
  private readonly escapeTimeoutMs: number;
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    emitEvent: TerminalInputHandler,
    options: TerminalInputParserOptions = {},
  ) {
    this.emitEvent = emitEvent;
    const timeout = Math.floor(options.escapeTimeoutMs ?? DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS);
    this.escapeTimeoutMs = Number.isFinite(timeout) && timeout >= 0
      ? timeout
      : DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS;
  }

  get pending(): string {
    return this.buffer;
  }

  feed(chunk: Buffer | string): void {
    if (this.disposed) {
      return;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) {
      return;
    }
    this.buffer += text;
    this.drain();
  }

  flush(): void {
    this.clearTimer();
    this.flushIncomplete();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
    this.buffer = '';
  }

  private drain(): void {
    while (this.buffer.length > 0 && !this.disposed) {
      const first = this.buffer[0];

      if (first === '\u001b') {
        if (this.buffer.length === 1) {
          this.scheduleFlush();
          return;
        }

        const introducer = this.buffer[1];
        if (introducer === '[') {
          let finalIndex = -1;
          for (let index = 2; index < this.buffer.length; index += 1) {
            const code = this.buffer.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) {
              finalIndex = index;
              break;
            }
          }
          if (finalIndex === -1) {
            if (this.buffer.length > MAXIMUM_ESCAPE_SEQUENCE_LENGTH) {
              this.buffer = this.buffer.slice(1);
              this.emitEvent({ type: 'key', key: 'escape' });
              continue;
            }
            this.scheduleFlush();
            return;
          }
          const sequence = this.buffer.slice(0, finalIndex + 1);
          this.buffer = this.buffer.slice(finalIndex + 1);
          const key = csiKey(sequence);
          if (key !== undefined) {
            this.emitEvent({ type: 'key', key });
          }
          continue;
        }

        if (introducer === 'O') {
          if (this.buffer.length < 3) {
            this.scheduleFlush();
            return;
          }
          const sequence = this.buffer.slice(0, 3);
          this.buffer = this.buffer.slice(3);
          const key = ss3Key(sequence);
          if (key !== undefined) {
            this.emitEvent({ type: 'key', key });
          }
          continue;
        }

        // A complete Alt+key sequence or a lone Escape. Report Escape and let
        // the following character be handled as ordinary text.
        this.buffer = this.buffer.slice(1);
        this.emitEvent({ type: 'key', key: 'escape' });
        continue;
      }

      const codePoint = this.buffer.codePointAt(0) ?? 0;
      const character = String.fromCodePoint(codePoint);
      this.buffer = this.buffer.slice(character.length);
      const key = CONTROL_KEYS[character];
      if (key !== undefined) {
        this.emitEvent({ type: 'key', key });
      } else if (isPrintable(codePoint)) {
        this.emitEvent({ type: 'text', text: character });
      }
    }

    this.clearTimer();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined || this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushIncomplete();
    }, this.escapeTimeoutMs);
    this.timer.unref?.();
  }

  private flushIncomplete(): void {
    if (this.disposed || this.buffer.length === 0) {
      return;
    }
    const buffered = this.buffer;
    this.buffer = '';
    if (buffered === '\u001b') {
      this.emitEvent({ type: 'key', key: 'escape' });
      return;
    }
    if (buffered.startsWith('\u001b[') || buffered.startsWith('\u001bO')) {
      // The rest of a stalled escape sequence is discarded rather than typed
      // into an open prompt as control characters.
      this.emitEvent({ type: 'key', key: 'escape' });
      return;
    }
    // Anything else is replayed as ordinary input.
    this.feed(buffered);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
