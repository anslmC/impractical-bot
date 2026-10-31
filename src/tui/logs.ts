import { format } from 'node:util';
import {
  renderSegments,
  stripAnsi,
  truncateVisible,
  type DashboardTone,
  type StyledSegment,
} from './theme.js';

export { stripAnsi } from './theme.js';

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

export interface DashboardLogLineOptions {
  readonly color?: boolean;
  readonly categoryWidth?: number;
}

interface LogHighlightRule {
  readonly pattern: RegExp;
  readonly tone: DashboardTone;
}

const CAPTURED_CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type CapturedConsoleMethod = typeof CAPTURED_CONSOLE_METHODS[number];

const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}]+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;

const CATEGORY_PATTERN = /^(\s*)(\[[^\][]{1,40}\])(\s*)/;
const METADATA_PATTERN = /([A-Za-z][A-Za-z0-9_.-]*)=("[^"]*"|[^\s,;)]+)/g;
const LABEL_PATTERN = /^\s*[^:\n]{1,32}:(?=\s)/;
const COUNT_PATTERN = /\b\d+\b/g;
const SEVERITY_PATTERN =
  /(?:failed|failure|rejected|suppressed|unavailable|disconnected|stopped|aborted|error)/i;

// Traditional CLI output paints every bracketed label with the standard ANSI cyan.
const CATEGORY_TONE: DashboardTone = 'cliCyan';

const EVENT_RULES: readonly LogHighlightRule[] = [
  { pattern: /\bRoll: YES\b/, tone: 'cliGreen' },
  { pattern: /\bRoll: NO\b/, tone: 'muted' },
  { pattern: /\bCooldown ended\b/, tone: 'cliGreen' },
  { pattern: /\bProcessing completed\b/, tone: 'cliGreen' },
  { pattern: /\bPacket created\b/, tone: 'cliGreen' },
  { pattern: /\bSubmitted to scheduler\b/, tone: 'cliGreen' },
  {
    pattern: /\b(?:failed|failure|rejected|suppressed|unavailable|disconnected|stopped|aborted|error|timeout)\b/i,
    tone: 'cliRed',
  },
  { pattern: /\b(?:Skipped|Skipping|timed out)\b/i, tone: 'cliYellow' },
  {
    pattern: /\b(?:sent|connected|resumed|completed|healthy|created|ended)\b/i,
    tone: 'cliGreen',
  },
  { pattern: /\([^()\n]{1,80}\)/, tone: 'muted' },
];

const SUCCESS_VALUES = new Set([
  'sent', 'complete', 'completed', 'connected', 'resumed', 'changed',
  'success', 'healthy', 'ready', 'ok', 'created', 'submitted', 'ended',
]);
const WARNING_VALUES = new Set([
  'pending', 'unconfirmed', 'paused', 'skipped', 'waiting', 'starting', 'changing',
]);
const DANGER_VALUES = new Set([
  'failed', 'error', 'rejected', 'blocked', 'unavailable', 'disconnected',
  'stopped', 'suppressed', 'echoed', 'invalid', 'timeout',
]);

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

function levelTone(level: DashboardLogLevel): DashboardTone | undefined {
  switch (level) {
    case 'warn':
      return 'cliYellow';
    case 'error':
      return 'cliRed';
    case 'debug':
    case 'trace':
      return 'muted';
    case 'info':
    case 'log':
      return undefined;
  }
}

export interface DashboardLogCategory {
  readonly name: string;
  readonly chip: string;
  readonly indent: string;
  readonly gap: string;
  readonly rest: string;
}

export function dashboardLogCategory(message: string): DashboardLogCategory | undefined {
  const match = CATEGORY_PATTERN.exec(message);
  if (!match) {
    return undefined;
  }
  const chip = match[2];
  const name = chip.slice(1, -1).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return {
    name,
    chip,
    indent: match[1],
    gap: match[3],
    rest: message.slice(match[0].length),
  };
}

function baseTone(level: DashboardLogLevel): DashboardTone | undefined {
  return levelTone(level);
}

function valueTone(value: string): DashboardTone | undefined {
  const normalized = value.replace(/^["']|["']$/g, '').toLowerCase();
  if (SUCCESS_VALUES.has(normalized)) {
    return 'cliGreen';
  }
  if (WARNING_VALUES.has(normalized)) {
    return 'cliYellow';
  }
  if (DANGER_VALUES.has(normalized)) {
    return 'cliRed';
  }
  return undefined;
}

interface TextHighlight {
  readonly index: number;
  readonly length: number;
  readonly tone: DashboardTone;
}

function findHighlight(
  text: string,
  labelTone: DashboardTone,
  allowLabel: boolean,
  allowCounts: boolean,
): TextHighlight | undefined {
  let best: TextHighlight | undefined;
  for (const rule of EVENT_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match === null || match[0].length === 0) {
      continue;
    }
    if (best === undefined || match.index < best.index) {
      best = { index: match.index, length: match[0].length, tone: rule.tone };
    }
  }

  if (allowLabel) {
    const label = LABEL_PATTERN.exec(text);
    if (label !== null && !SEVERITY_PATTERN.test(label[0]) &&
        (best === undefined || best.index >= label[0].length)) {
      best = {
        index: 0,
        length: label[0].length,
        tone: labelTone,
      };
    }
  }

  if (allowCounts) {
    COUNT_PATTERN.lastIndex = 0;
    const count = COUNT_PATTERN.exec(text);
    if (count !== null && (best === undefined || count.index < best.index)) {
      best = {
        index: count.index,
        length: count[0].length,
        tone: Number(count[0]) > 0 ? 'cliGreen' : 'muted',
      };
    }
  }

  return best;
}

function styleText(
  text: string,
  tone: DashboardTone | undefined,
  allowLabel: boolean,
  allowCounts: boolean,
): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let index = 0;
  let labelAllowed = allowLabel;
  while (index < text.length) {
    const rest = text.slice(index);
    const highlight = findHighlight(rest, tone ?? 'strong', labelAllowed, allowCounts);
    if (highlight === undefined) {
      segments.push({ text: rest, tone });
      break;
    }
    if (highlight.index > 0) {
      segments.push({ text: rest.slice(0, highlight.index), tone });
    }
    segments.push({
      text: rest.slice(highlight.index, highlight.index + highlight.length),
      tone: highlight.tone,
    });
    index += highlight.index + highlight.length;
    labelAllowed = false;
  }
  return segments;
}

function messageSegments(
  message: string,
  tone: DashboardTone | undefined,
  allowCounts: boolean,
): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let index = 0;
  let labelAllowed = true;
  METADATA_PATTERN.lastIndex = 0;
  for (;;) {
    const match = METADATA_PATTERN.exec(message);
    if (match === null) {
      break;
    }
    if (match.index > index) {
      segments.push(...styleText(
        message.slice(index, match.index),
        tone,
        labelAllowed,
        allowCounts,
      ));
      labelAllowed = false;
    }
    segments.push({ text: `${match[1]}=`, tone: 'muted' });
    segments.push({ text: match[2], tone: valueTone(match[2]) ?? tone });
    index = match.index + match[0].length;
    labelAllowed = false;
  }
  if (index < message.length) {
    segments.push(...styleText(
      message.slice(index),
      tone,
      labelAllowed,
      allowCounts,
    ));
  }
  return segments;
}

export interface ContextStoreMessage {
  readonly id: string;
  readonly content: string;
}

export interface ContextStoreSection {
  readonly title: string;
  readonly messages: readonly ContextStoreMessage[];
}

export type ContextStorePresentationElement =
  | { readonly type: 'section'; readonly section: ContextStoreSection }
  | { readonly type: 'unknown'; readonly entry: DashboardLogEntry };

export interface ContextStorePresentation {
  readonly added?: string;
  readonly retained?: string;
  readonly capacity?: string;
  readonly deferred: boolean;
  readonly elements: readonly ContextStorePresentationElement[];
}

const CONTEXT_STORE_HEADER = 'CONTEXT STORE UPDATE';
const CONTEXT_STORE_BORDER = /^={8,}$/;
const CONTEXT_STORE_MESSAGE = /^\s*-\s+id=([^;]*);\s+text=(.*)$/;
const CONTEXT_STORE_DEFERRED =
  /^Eviction details and aggregate contents skipped;/;
const RETAINED_STORE_VISIBLE_LIMIT = 8;
const RETAINED_STORE_EDGE = 4;

function contextStoreLine(entry: DashboardLogEntry): string {
  return sanitizeLogText(entry.message).replace(/\s+$/u, '');
}

function isContextStoreBorder(line: string): boolean {
  return CONTEXT_STORE_BORDER.test(line.trim());
}

function contextStoreBlockEnd(
  entries: readonly DashboardLogEntry[],
  start: number,
): number | undefined {
  if (!isContextStoreBorder(contextStoreLine(entries[start]))) {
    return undefined;
  }
  if (start + 2 >= entries.length) {
    return undefined;
  }
  if (contextStoreLine(entries[start + 1]).trim() !== CONTEXT_STORE_HEADER) {
    return undefined;
  }
  if (!isContextStoreBorder(contextStoreLine(entries[start + 2]))) {
    return undefined;
  }
  for (let index = start + 3; index < entries.length; index += 1) {
    if (isContextStoreBorder(contextStoreLine(entries[index]))) {
      return index;
    }
  }
  return undefined;
}

function parseContextStoreMessage(line: string): ContextStoreMessage | undefined {
  const match = CONTEXT_STORE_MESSAGE.exec(line);
  if (match === null) {
    return undefined;
  }
  const id = match[1].trim();
  const raw = match[2].trim();
  let content = raw;
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') {
        content = parsed;
      }
    } catch {
      // Malformed diagnostics are shown verbatim rather than discarded.
    }
  }
  return { id, content: content.length > 0 ? content : '(no text content)' };
}

export function parseContextStorePresentation(
  entries: readonly DashboardLogEntry[],
): ContextStorePresentation {
  let addedValue: string | undefined;
  let retainedValue: string | undefined;
  let capacityValue: string | undefined;
  let deferred = false;
  const elements: ContextStorePresentationElement[] = [];
  let current: ContextStoreMessage[] | undefined;
  let currentTitle = '';

  const flush = (): void => {
    if (current !== undefined) {
      elements.push({
        type: 'section',
        section: { title: currentTitle, messages: [...current] },
      });
      current = undefined;
    }
  };

  for (const entry of entries.slice(3, -1)) {
    const line = contextStoreLine(entry);
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const addedMatch = /^Newly appended:\s*(.*)$/u.exec(trimmed);
    if (addedMatch !== null) {
      addedValue = addedMatch[1].trim();
      continue;
    }
    const retainedMatch = /^Currently retained:\s*(.*)$/u.exec(trimmed);
    if (retainedMatch !== null) {
      retainedValue = retainedMatch[1].trim();
      continue;
    }
    const capacityMatch = /^Maximum capacity:\s*(.*)$/u.exec(trimmed);
    if (capacityMatch !== null) {
      capacityValue = capacityMatch[1].trim();
      continue;
    }
    if (CONTEXT_STORE_DEFERRED.test(trimmed)) {
      deferred = true;
      continue;
    }
    if (trimmed === 'New messages:') {
      flush();
      current = [];
      currentTitle = 'RECENT MESSAGES';
      continue;
    }
    const evictedMatch = /^Evicted this update \((\d+)\):$/u.exec(trimmed);
    if (evictedMatch !== null) {
      flush();
      current = [];
      currentTitle = 'EVICTED THIS UPDATE';
      continue;
    }
    if (trimmed === 'Full retained store, in observation order:') {
      flush();
      current = [];
      currentTitle = 'RETAINED STORE';
      continue;
    }
    if (trimmed === '(none)' && current !== undefined) {
      continue;
    }
    const message = parseContextStoreMessage(line);
    if (message !== undefined && current !== undefined) {
      current.push(message);
      continue;
    }
    flush();
    elements.push({ type: 'unknown', entry });
  }
  flush();

  return {
    added: addedValue,
    retained: retainedValue,
    capacity: capacityValue,
    deferred,
    elements,
  };
}

function contextStoreMessageRow(
  message: ContextStoreMessage,
  last: boolean,
  width: number,
  color: boolean,
): string {
  const prefix = `  ${last ? '└─' : '├─'} `;
  const id = message.id.length > 0 ? `  ${message.id}` : '';
  const contentLimit = width - prefix.length - id.length;
  const contentTone = message.content === '(no text content)' ? 'muted' : undefined;
  if (id.length > 0 && contentLimit >= 8) {
    return renderSegments([
      { text: prefix, tone: 'muted' },
      { text: truncateVisible(message.content, contentLimit), tone: contentTone },
      { text: id, tone: 'muted' },
    ], width, color);
  }
  return renderSegments([
    { text: prefix, tone: 'muted' },
    { text: message.content, tone: contentTone },
  ], width, color);
}

function contextStoreSummaryRows(
  presentation: ContextStorePresentation,
  width: number,
  color: boolean,
): string[] {
  const rows: string[] = [];
  if (presentation.retained !== undefined || presentation.capacity !== undefined) {
    const retained = presentation.retained ?? '?';
    const capacity = presentation.capacity ?? '?';
    rows.push(renderSegments([
      { text: '  Messages: ', tone: 'muted' },
      { text: `${retained} / ${capacity}`, tone: retained === '(deferred)' ? 'cliYellow' : undefined },
    ], width, color));
  }
  if (presentation.added !== undefined) {
    rows.push(renderSegments([
      { text: '  Added: ', tone: 'muted' },
      { text: presentation.added, tone: 'cliGreen' },
    ], width, color));
  }
  if (presentation.deferred) {
    rows.push(renderSegments([
      { text: '  Full contents deferred while packet work is active.', tone: 'cliYellow' },
    ], width, color));
  }
  return rows;
}

function renderContextStoreBlock(
  entries: readonly DashboardLogEntry[],
  width: number,
  options: DashboardLogLineOptions,
): string[] {
  const color = options.color === true;
  const presentation = parseContextStorePresentation(entries);
  const recentMessageIds = new Set<string>();
  for (const element of presentation.elements) {
    if (element.type !== 'section' || element.section.title !== 'RECENT MESSAGES') {
      continue;
    }
    for (const message of element.section.messages) {
      if (message.id.length > 0) {
        recentMessageIds.add(message.id);
      }
    }
  }
  const heading = renderSegments([
    { text: `[${formatLogTimestamp(entries[0].timestamp)}] `, tone: 'muted' },
    { text: 'CONTEXT STORE', tone: 'strong' },
  ], width, color);
  const rows: string[] = [heading, ...contextStoreSummaryRows(presentation, width, color)];
  let separated = false;
  for (const element of presentation.elements) {
    if (element.type === 'unknown') {
      rows.push(formatDashboardLogLine(element.entry, width, options));
      continue;
    }
    const section = element.section;
    const messages = section.title === 'RETAINED STORE'
      ? section.messages.filter(message =>
        message.id.length === 0 || !recentMessageIds.has(message.id))
      : section.messages;
    if (!separated) {
      rows.push('');
      separated = true;
    }
    rows.push(renderSegments([
      { text: `  ${section.title}`, tone: 'strong' },
      ...(messages.length > 0
        ? [{ text: ` (${messages.length})`, tone: 'muted' as const }]
        : []),
    ], width, color));
    if (messages.length === 0) {
      rows.push(renderSegments([{ text: '    (none)', tone: 'muted' }], width, color));
      continue;
    }
    if (section.title === 'RETAINED STORE' &&
        messages.length > RETAINED_STORE_VISIBLE_LIMIT) {
      const head = messages.slice(0, RETAINED_STORE_EDGE);
      const tail = messages.slice(-RETAINED_STORE_EDGE);
      const omitted = messages.length - head.length - tail.length;
      head.forEach(message => {
        rows.push(contextStoreMessageRow(message, false, width, color));
      });
      rows.push(renderSegments([
        { text: '  │  … ', tone: 'muted' },
        { text: `${omitted} ${omitted === 1 ? 'message' : 'messages'} omitted`, tone: 'muted' },
      ], width, color));
      tail.forEach((message, index) => {
        rows.push(contextStoreMessageRow(
          message,
          index === tail.length - 1,
          width,
          color,
        ));
      });
      continue;
    }
    messages.forEach((message, index) => {
      rows.push(contextStoreMessageRow(
        message,
        index === messages.length - 1,
        width,
        color,
      ));
    });
  }
  return rows;
}

export function formatDashboardLogEntries(
  entries: readonly DashboardLogEntry[],
  maximumWidth: number,
  options: DashboardLogLineOptions = {},
): string[] {
  const width = Math.max(0, Math.floor(maximumWidth));
  if (width === 0) {
    return [];
  }
  const rows: string[] = [];
  let index = 0;
  while (index < entries.length) {
    const end = contextStoreBlockEnd(entries, index);
    if (end !== undefined) {
      rows.push(...renderContextStoreBlock(entries.slice(index, end + 1), width, options));
      index = end + 1;
      continue;
    }
    rows.push(formatDashboardLogLine(entries[index], width, options));
    index += 1;
  }
  return rows;
}

export function formatDashboardLogLine(
  entry: DashboardLogEntry,
  maximumWidth: number,
  options: DashboardLogLineOptions = {},
): string {
  const color = options.color === true;
  const width = Math.max(0, Math.floor(maximumWidth));
  const message = sanitizeLogText(entry.message);
  const category = dashboardLogCategory(message);
  const segments: StyledSegment[] = [
    { text: `[${formatLogTimestamp(entry.timestamp)}] `, tone: 'muted' },
  ];
  const level = levelLabel(entry.level);
  if (level.length > 0) {
    segments.push({ text: level, tone: levelTone(entry.level) });
  }
  if (category === undefined) {
    segments.push(...messageSegments(message, baseTone(entry.level), false));
  } else {
    const alignment = Math.max(
      0,
      Math.min(options.categoryWidth ?? 0, 16) - category.chip.length,
    );
    if (category.indent.length > 0) {
      segments.push({ text: category.indent });
    }
    segments.push({ text: category.chip, tone: CATEGORY_TONE });
    segments.push({ text: category.gap });
    if (alignment > 0) {
      segments.push({ text: ' '.repeat(alignment) });
    }
    segments.push(...messageSegments(
      category.rest,
      baseTone(entry.level),
      category.name === 'poll',
    ));
  }
  return renderSegments(segments, width, color);
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
