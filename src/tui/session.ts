import type { TerminalKey } from './input.js';
import {
  captureConsoleOutput,
  type ConsoleCapture,
  type ConsoleCaptureOptions,
  type DashboardLogBuffer,
  type DashboardLogBufferChange,
} from './logs.js';
import {
  TerminalSession,
  type TerminalDimensions,
  type TerminalHandoff,
  type TerminalRenderOptions,
} from './terminal.js';

export interface TerminalViewLifecycleOptions {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly handoff?: TerminalHandoff;
  readonly escapeTimeoutMs?: number;
  readonly logBuffer: DashboardLogBuffer;
  readonly captureConsoleOutput?: boolean;
  readonly now?: () => Date;
  readonly onKey: (key: TerminalKey) => void;
  readonly onText: (text: string) => void;
  readonly onResize: () => void;
  readonly onLogEntry?: (change: DashboardLogBufferChange) => void;
  readonly onFinalize?: () => void;
}

export class TerminalViewLifecycle {
  readonly closed: Promise<void>;
  private readonly terminal: TerminalSession;
  private readonly logBuffer: DashboardLogBuffer;
  private readonly onLogEntry: ((change: DashboardLogBufferChange) => void) | undefined;
  private readonly onFinalize: (() => void) | undefined;
  private capturedConsole: ConsoleCapture | undefined;
  private unsubscribeLogs: (() => void) | undefined;
  private finalized = false;
  private closedState = false;
  private resolveClosed!: () => void;

  constructor(options: TerminalViewLifecycleOptions) {
    this.logBuffer = options.logBuffer;
    this.onLogEntry = options.onLogEntry;
    this.onFinalize = options.onFinalize;
    this.closed = new Promise<void>(resolve => {
      this.resolveClosed = resolve;
    });
    this.terminal = new TerminalSession({
      input: options.input,
      output: options.output,
      handoff: options.handoff,
      escapeTimeoutMs: options.escapeTimeoutMs,
      onKey: options.onKey,
      onText: options.onText,
      onResize: options.onResize,
    });
    void this.terminal.closed.then(() => this.finalize());
    if (options.captureConsoleOutput) {
      const captureOptions: ConsoleCaptureOptions = {
        now: options.now,
        buffer: options.logBuffer,
      };
      this.capturedConsole = captureConsoleOutput(options.logBuffer.capacity, captureOptions);
    }
  }

  get isClosed(): boolean {
    return this.closedState;
  }

  get dimensions(): TerminalDimensions {
    return this.terminal.dimensions;
  }

  render(lines: readonly string[], options: TerminalRenderOptions = {}): void {
    this.terminal.render(lines, options);
  }

  async start(render: () => void): Promise<void> {
    try {
      this.terminal.start();
      render();
      if (this.onLogEntry !== undefined) {
        this.unsubscribeLogs = this.logBuffer.subscribe(this.onLogEntry);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.closeWithOptions(false);
  }

  closeForHandoff(): Promise<TerminalHandoff | undefined> {
    return this.closeWithOptions(true);
  }

  private async closeWithOptions(
    preserveState: boolean,
  ): Promise<TerminalHandoff | undefined> {
    if (this.closedState) {
      return undefined;
    }
    this.closedState = true;
    const handoff = await this.terminal.close({ preserveState });
    this.finalize();
    return handoff;
  }

  private finalize(): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.closedState = true;
    this.onFinalize?.();
    this.unsubscribeLogs?.();
    this.unsubscribeLogs = undefined;
    try {
      this.capturedConsole?.restore();
    } catch {
      // Console restoration is best effort during teardown.
    }
    this.capturedConsole = undefined;
    this.resolveClosed();
  }
}
