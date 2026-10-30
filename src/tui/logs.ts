import { format } from 'node:util';

export const DEFAULT_MAXIMUM_LOG_ENTRIES = 200;

export type DashboardLogLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace';

export interface DashboardLogEntry {
  readonly timestamp: Date;
  readonly level: DashboardLogLevel;
  readonly message: string;
}

export interface ConsoleCaptureOptions {
  onEntry?: (entry: DashboardLogEntry) => void;
  now?: () => Date;
}

export interface ConsoleCapture {
  restore(): void;
  getLines(): string[];
  getEntries(): DashboardLogEntry[];
}

const CAPTURED_CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type CapturedConsoleMethod = typeof CAPTURED_CONSOLE_METHODS[number];

const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_SINGLE_PATTERN = /\u001b[@-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}]+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SINGLE_PATTERN, '');
}

export function sanitizeLogText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROL_PATTERN, '')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]');
}

export function formatLogTimestamp(timestamp: Date): string {
  if (Number.isNaN(timestamp.getTime())) {
    return '--:--:--';
  }
  const hours = String(timestamp.getHours()).padStart(2, '0');
  const minutes = String(timestamp.getMinutes()).padStart(2, '0');
  const seconds = String(timestamp.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function levelLabel(level: DashboardLogLevel): string {
  switch (level) {
    case 'log':
      return '';
    case 'info':
      return '[INFO] ';
    case 'warn':
      return '[WARN] ';
    case 'error':
      return '[ERROR] ';
    case 'debug':
      return '[DEBUG] ';
    case 'trace':
      return '[TRACE] ';
  }
}

function truncate(text: string, maximum: number): string {
  if (maximum <= 0) {
    return '';
  }
  if (text.length <= maximum) {
    return text;
  }
  if (maximum === 1) {
    return '…';
  }
  return `${text.slice(0, maximum - 1)}…`;
}

export function formatDashboardLogLine(
  entry: DashboardLogEntry,
  maximumWidth: number,
): string {
  const message = sanitizeLogText(entry.message);
  const line = `[${formatLogTimestamp(entry.timestamp)}] ${levelLabel(entry.level)}${message}`;
  return truncate(line, Math.max(0, Math.floor(maximumWidth)));
}

export class DashboardLogBuffer {
  readonly capacity: number;
  private readonly entries: DashboardLogEntry[] = [];

  constructor(capacity = DEFAULT_MAXIMUM_LOG_ENTRIES) {
    const normalized = Math.floor(capacity);
    this.capacity = Number.isFinite(normalized) && normalized > 0
      ? normalized
      : DEFAULT_MAXIMUM_LOG_ENTRIES;
  }

  add(entry: DashboardLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  getEntries(): DashboardLogEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }
}

function messageLines(text: string): string[] {
  return sanitizeLogText(text)
    .split('\n')
    .filter(line => line.length > 0);
}

export function captureConsoleOutput(
  maximumEntries = DEFAULT_MAXIMUM_LOG_ENTRIES,
  options: ConsoleCaptureOptions = {},
): ConsoleCapture {
  const consoleRecord = console as unknown as Record<
    CapturedConsoleMethod,
    (...args: unknown[]) => void
  >;
  const originals = new Map<CapturedConsoleMethod, (...args: unknown[]) => void>();
  const buffer = new DashboardLogBuffer(maximumEntries);
  const now = options.now ?? (() => new Date());
  let capturing = false;

  const append = (level: DashboardLogLevel, args: unknown[]): void => {
    if (capturing) {
      return;
    }
    capturing = true;
    try {
      let text: string;
      try {
        text = typeof format === 'function' ? format(...args) : args.map(String).join(' ');
      } catch {
        text = args.map(value => String(value)).join(' ');
      }
      const timestamp = now();
      for (const line of messageLines(text)) {
        const entry: DashboardLogEntry = { timestamp, level, message: line };
        buffer.add(entry);
        try {
          options.onEntry?.(entry);
        } catch {
          // A dashboard callback must never break engine logging.
        }
      }
    } catch {
      // Console capture must never break the engine's own output path.
    } finally {
      capturing = false;
    }
  };

  for (const method of CAPTURED_CONSOLE_METHODS) {
    const original = consoleRecord[method];
    originals.set(method, original);
    consoleRecord[method] = (...args: unknown[]) => append(method, args);
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
      return buffer.getEntries().map(entry => entry.message);
    },
    getEntries() {
      return buffer.getEntries();
    },
  };
}
