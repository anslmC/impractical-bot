import type { RuntimeEngineState } from '../runtime-control.js';
import {
  getDashboardCommandHints,
  personalityChoices,
  renderPromptInput,
  temperamentChoices,
  type DashboardNotice,
  type DashboardPrompt,
} from './commands.js';
import {
  dashboardLogCategory,
  formatDashboardLogEntries,
  type DashboardLogEntry,
} from './logs.js';
import {
  centerVisible,
  padVisible,
  paint,
  renderLine,
  truncateVisible,
  type DashboardTone,
  type StyledSegment,
} from './theme.js';
import { resolveLogScrollState, type LogScrollState } from './scroll.js';
import {
  renderPlainWordmark,
  renderWordmarkForWidth,
  WORDMARK_TAGLINE,
} from './wordmark.js';

export type DashboardConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'stopped'
  | 'unsupported';

export type DashboardEngineState = RuntimeEngineState | 'disconnected' | 'stopped';

export interface DashboardView {
  connection: DashboardConnectionState;
  state: DashboardEngineState;
  browser: string;
  temperament: string;
  personality: string;
  messengerDestination: string;
  logs?: readonly DashboardLogEntry[];
  prompt?: DashboardPrompt;
  notice?: DashboardNotice;
  pending?: boolean;
  commandsEnabled?: boolean;
}

export interface DashboardDimensions {
  columns: number;
  rows: number;
}

export interface DashboardRenderOptions {
  color?: boolean;
  scrollOffset?: number;
  unseenCount?: number;
}

export type DashboardLogScrollState = LogScrollState;

export interface DashboardFrame {
  readonly lines: string[];
  readonly state: DashboardLogScrollState;
}

const EMPTY_SCROLL_STATE: DashboardLogScrollState = {
  offset: 0,
  maximumOffset: 0,
  visibleLines: 0,
  totalLines: 0,
  unseenCount: 0,
  pinned: true,
};

export const DASHBOARD_UNKNOWN_VALUE = 'Unknown';
export const DASHBOARD_EMPTY_LOGS_MESSAGE = 'Waiting for engine output...';

const FIELD_GAP = 3;

export function createInitialDashboardView(): DashboardView {
  return {
    connection: 'connecting',
    state: 'starting',
    browser: DASHBOARD_UNKNOWN_VALUE,
    temperament: DASHBOARD_UNKNOWN_VALUE,
    personality: DASHBOARD_UNKNOWN_VALUE,
    messengerDestination: DASHBOARD_UNKNOWN_VALUE,
    logs: [],
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function displayValue(value: string): string {
  return value.length > 0 ? value : DASHBOARD_UNKNOWN_VALUE;
}

function connectionLabel(view: DashboardView): string {
  switch (view.connection) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'stopped':
      return 'Stopped';
    case 'unsupported':
      return 'Status unavailable';
    case 'disconnected':
      return 'Disconnected';
  }
}

function connectionTone(view: DashboardView): DashboardTone {
  switch (view.connection) {
    case 'connected':
      return 'success';
    case 'connecting':
      return 'warning';
    case 'stopped':
    case 'disconnected':
      return 'danger';
    case 'unsupported':
      return 'muted';
  }
}

interface StatusAppearance {
  readonly label: string;
  readonly tone: DashboardTone;
}

function statusAppearance(view: DashboardView): StatusAppearance {
  if (view.connection !== 'connected') {
    switch (view.connection) {
      case 'connecting':
        return { label: 'Starting', tone: 'warning' };
      case 'stopped':
        return { label: 'Stopped', tone: 'danger' };
      case 'unsupported':
        return { label: 'Status unavailable', tone: 'muted' };
      case 'disconnected':
        return { label: 'Disconnected', tone: 'danger' };
    }
  }
  switch (view.state) {
    case 'running':
      return { label: 'Running', tone: 'success' };
    case 'paused':
      return { label: 'Paused', tone: 'warning' };
    case 'starting':
      return { label: 'Starting', tone: 'warning' };
    case 'changing':
      return { label: 'Changing', tone: 'warning' };
    case 'stopping':
      return { label: 'Stopping', tone: 'danger' };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'danger' };
    case 'stopped':
      return { label: 'Stopped', tone: 'danger' };
  }
}

interface DashboardField {
  readonly label: string;
  readonly value: string;
}

function configurationFields(view: DashboardView): DashboardField[] {
  return [
    { label: 'Browser', value: displayValue(view.browser) },
    { label: 'Temperament', value: capitalize(displayValue(view.temperament)) },
    { label: 'Personality', value: capitalize(displayValue(view.personality)) },
  ];
}

function destinationField(view: DashboardView): DashboardField {
  return {
    label: 'Destination',
    value: displayValue(view.messengerDestination),
  };
}

function renderFields(
  fields: readonly DashboardField[],
  width: number,
  color: boolean,
): string[] {
  const rows: StyledSegment[][] = [];
  let current: StyledSegment[] = [];
  let currentWidth = 0;
  for (const field of fields) {
    const fieldWidth = `${field.label}: ${field.value}`.length;
    if (current.length > 0 && currentWidth + FIELD_GAP + fieldWidth > width) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    if (current.length > 0) {
      current.push({ text: ' '.repeat(FIELD_GAP) });
      currentWidth += FIELD_GAP;
    }
    current.push(
      { text: `${field.label}: `, tone: 'cyanMuted' },
      { text: field.value, tone: 'value' },
    );
    currentWidth += fieldWidth;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows.map(row => renderLine(row, width, color));
}

function sectionRule(
  title: string,
  right: string | undefined,
  rightTone: DashboardTone | undefined,
  width: number,
  color: boolean,
): string {
  const lead = '── ';
  const minimumFill = 2;
  let titleText = title;
  let suffix = right === undefined ? '──' : ` ${right} ──`;
  if (`${lead}${titleText} `.length + suffix.length + minimumFill > width) {
    suffix = '──';
  }
  if (`${lead}${titleText} `.length + suffix.length + minimumFill > width) {
    const available = Math.max(
      0,
      width - lead.length - suffix.length - minimumFill - 1,
    );
    titleText = truncateVisible(titleText, available);
  }
  const head = `${lead}${titleText} `;
  const fill = Math.max(minimumFill, width - head.length - suffix.length);
  return renderLine(
    [
      { text: lead, tone: 'muted' },
      { text: titleText, tone: 'heading' },
      { text: ' ', tone: 'muted' },
      { text: '─'.repeat(fill), tone: 'muted' },
      { text: suffix, tone: rightTone ?? 'muted' },
    ],
    width,
    color,
  );
}

function engineStatusRule(
  label: string,
  tone: DashboardTone,
  width: number,
  color: boolean,
): string {
  const right = `● ${label}`;
  const required =
    '── '.length + 'ENGINE STATUS '.length + ` ${right} ──`.length + 2;
  if (width >= required) {
    return sectionRule('ENGINE STATUS', right, tone, width, color);
  }
  const lead = '── ';
  if (width >= lead.length + right.length) {
    return renderLine(
      [
        { text: lead, tone: 'muted' },
        { text: right, tone },
      ],
      width,
      color,
    );
  }
  return renderLine([{ text: truncateVisible(right, width), tone }], width, color);
}

function commandChips(
  view: DashboardView,
  width: number,
  color: boolean,
): string[] {
  const chips: StyledSegment[][] = getDashboardCommandHints(view).map(hint => [
    { text: `[${hint.key}]`, tone: 'brandSoft' },
    { text: ` ${hint.name}`, tone: 'value' },
  ]);
  if (view.prompt === undefined) {
    chips.push([
      { text: '[D]', tone: 'brandSoft' },
      { text: ' Enter debug', tone: 'value' },
    ]);
  }
  const rows: StyledSegment[][] = [];
  let current: StyledSegment[] = [];
  let currentWidth = 0;
  for (const chip of chips) {
    const chipWidth = chip.reduce((total, segment) => total + segment.text.length, 0);
    if (current.length > 0 && currentWidth + FIELD_GAP + chipWidth > width) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    if (current.length > 0) {
      current.push({ text: ' '.repeat(FIELD_GAP) });
      currentWidth += FIELD_GAP;
    }
    current.push(...chip);
    currentWidth += chipWidth;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows.map(row => renderLine(row, width, color));
}

function noticePrefix(notice: DashboardNotice): string {
  switch (notice.tone) {
    case 'pending':
      return 'Pending: ';
    case 'success':
      return '';
    case 'error':
      return 'Error: ';
    case 'info':
      return '';
  }
}

function noticeTone(notice: DashboardNotice): DashboardTone {
  switch (notice.tone) {
    case 'pending':
      return 'warning';
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    case 'info':
      return 'info';
  }
}

function promptErrorLines(prompt: DashboardPrompt, width: number, color: boolean): string[] {
  if (!('error' in prompt) || prompt.error === undefined) {
    return [];
  }
  return [renderLine([
    { text: `Error: ${prompt.error}`, tone: 'danger' },
  ], width, color)];
}

function promptFooterLines(prompt: DashboardPrompt, width: number, color: boolean): string[] {
  switch (prompt.kind) {
    case 'destination':
      return [
        truncateVisible(renderPromptInput('Destination URL: ', prompt.value, width).text, width),
        truncateVisible('[Enter] Apply  [Esc] Cancel', width),
        ...promptErrorLines(prompt, width, color),
      ];
    case 'temperament':
      return [
        'Select temperament:',
        truncateVisible(temperamentChoices(), width),
        truncateVisible('[Esc] Cancel', width),
      ];
    case 'personality':
      return [
        'Select personality:',
        truncateVisible(personalityChoices(), width),
        truncateVisible('[Esc] Cancel', width),
      ];
    case 'personalityInstruction':
      return [
        truncateVisible(
          renderPromptInput('Personality instruction: ', prompt.value, width).text,
          width,
        ),
        truncateVisible('[Enter] Apply  [Esc] Cancel', width),
        ...promptErrorLines(prompt, width, color),
      ];
    case 'stopConfirmation':
      return [
        'Stop Impractical Bot?',
        truncateVisible('[Y] Confirm  [Esc/N] Cancel', width),
      ];
  }
}

function footerLines(
  view: DashboardView,
  width: number,
  color: boolean,
  scrollState?: DashboardLogScrollState,
): string[] {
  if (view.prompt !== undefined) {
    return promptFooterLines(view.prompt, width, color);
  }
  const segments: StyledSegment[] = [
    { text: 'Status: ', tone: 'cyanMuted' },
    { text: connectionLabel(view), tone: connectionTone(view) },
  ];
  if (view.notice !== undefined) {
    segments.push(
      { text: '   ' },
      {
        text: `${noticePrefix(view.notice)}${view.notice.message}`,
        tone: noticeTone(view.notice),
      },
    );
  }
  const scrollGap = width >= 96 ? '   ' : ' ';
  if (scrollState !== undefined && !scrollState.pinned) {
    segments.push(
      { text: scrollGap },
      { text: '● SCROLLBACK', tone: 'warning' },
    );
    if (scrollState.unseenCount > 0) {
      segments.push({
        text: `${scrollGap}${scrollState.unseenCount} new ` +
          `${scrollState.unseenCount === 1 ? 'entry' : 'entries'}`,
        tone: 'warning',
      });
    }
  }
  if (scrollState !== undefined && scrollState.maximumOffset > 0) {
    segments.push(
      { text: scrollGap },
      { text: '[PgUp/PgDn]', tone: 'brandSoft' },
      { text: ' Scroll', tone: 'value' },
      { text: scrollGap },
      { text: '[L]', tone: 'brandSoft' },
      { text: ' Latest', tone: scrollState.pinned ? 'value' : 'warning' },
    );
  }
  return [renderLine(segments, width, color)];
}

function dashboardLogLines(
  entries: readonly DashboardLogEntry[],
  width: number,
  color: boolean,
): string[] {
  const categoryWidth = Math.min(
    8,
    entries.reduce(
      (maximum, entry) =>
        Math.max(maximum, dashboardLogCategory(entry.message)?.chip.length ?? 0),
      0,
    ),
  );
  if (entries.length === 0) {
    return [renderLine([{ text: DASHBOARD_EMPTY_LOGS_MESSAGE, tone: 'muted' }], width, color)];
  }
  return formatDashboardLogEntries(entries, width, { color, categoryWidth });
}

interface LogWindow {
  readonly lines: string[];
  readonly state: DashboardLogScrollState;
}

function windowLogLines(
  allLines: readonly string[],
  width: number,
  capacity: number,
  scrollOffset: number,
  unseenCount: number,
): LogWindow {
  const state = resolveLogScrollState(
    allLines.length,
    capacity,
    scrollOffset,
    unseenCount,
  );
  if (capacity <= 0) {
    return { lines: [], state };
  }
  const end = allLines.length - state.offset;
  const start = Math.max(0, end - capacity);
  const visible = allLines.slice(start, end).map(line => padVisible(line, width));
  while (visible.length < capacity) {
    visible.push(' '.repeat(width));
  }
  return { lines: visible, state };
}

interface ChromeLevel {
  readonly art: boolean;
  readonly tagline: boolean;
  readonly spacers: boolean;
  readonly minimumLogs: number;
}

const CHROME_LEVELS: readonly ChromeLevel[] = [
  { art: true, tagline: true, spacers: true, minimumLogs: 3 },
  { art: true, tagline: true, spacers: false, minimumLogs: 2 },
  { art: true, tagline: false, spacers: false, minimumLogs: 1 },
  { art: false, tagline: false, spacers: false, minimumLogs: 1 },
];

function fitBody(lines: string[], available: number): string[] {
  if (available <= 0) {
    return [];
  }
  if (lines.length === available) {
    return lines;
  }
  if (lines.length < available) {
    if (available === 1) {
      return [lines[0]];
    }
    return [
      ...lines.slice(0, -1),
      ...Array<string>(available - lines.length).fill(' '.repeat(lines[0]?.length ?? 0)),
      lines[lines.length - 1],
    ];
  }
  if (available === 1) {
    return [lines[0]];
  }
  return [...lines.slice(0, available - 1), lines[lines.length - 1]];
}

function bodyFrame(
  view: DashboardView,
  width: number,
  available: number,
  color: boolean,
  scrollOffset: number,
  unseenCount: number,
): DashboardFrame {
  if (available <= 0) {
    return { lines: [], state: EMPTY_SCROLL_STATE };
  }
  const appearance = statusAppearance(view);
  const engineHeading = engineStatusRule(appearance.label, appearance.tone, width, color);
  const configRows = [
    ...renderFields(configurationFields(view), width, color),
    ...renderFields([destinationField(view)], width, color),
  ];
  const entries = view.logs ?? [];
  const allLogLines = dashboardLogLines(entries, width, color);
  const logsHeading = sectionRule(
    'LIVE LOGS',
    entries.length > 0 ? String(entries.length) : 'idle',
    'muted',
    width,
    color,
  );
  const commandsHeading = sectionRule('COMMANDS', undefined, undefined, width, color);
  const chips = commandChips(view, width, color);
  const footer = footerLines(view, width, color);
  const art = renderWordmarkForWidth(width, { color });

  for (const level of CHROME_LEVELS) {
    const spacer = level.spacers ? [''] : [];
    const header = level.art && art !== undefined
      ? [
        ...art,
        ...(level.tagline
          ? [centerVisible(paint(WORDMARK_TAGLINE, 'muted', color), width)]
          : []),
      ]
      : [centerVisible(renderPlainWordmark({ color }), width)];
    const top = [
      ...spacer,
      ...header,
      ...spacer,
      engineHeading,
      ...configRows,
      ...spacer,
      commandsHeading,
      ...chips,
      ...spacer,
      logsHeading,
    ];
    const bottom = view.prompt === undefined
      ? ['', ...footer]
      : [...footer];
    const capacity = available - top.length - bottom.length;
    if (capacity >= level.minimumLogs) {
      const window = windowLogLines(
        allLogLines,
        width,
        capacity,
        scrollOffset,
        unseenCount,
      );
      const sizedFooter = footerLines(view, width, color, window.state);
      const sizedBottom = view.prompt === undefined
        ? ['', ...sizedFooter]
        : [...sizedFooter];
      return {
        lines: [...top, ...window.lines, ...sizedBottom],
        state: window.state,
      };
    }
  }

  const fallback = [
    centerVisible(renderPlainWordmark({ color }), width),
    engineHeading,
    ...configRows,
    commandsHeading,
    ...chips,
    ...footer,
  ];
  return {
    lines: fitBody(fallback, available),
    state: resolveLogScrollState(allLogLines.length, 0, 0, 0),
  };
}

function plainFrame(
  view: DashboardView,
  width: number,
  rows: number,
  color: boolean,
  scrollOffset: number,
  unseenCount: number,
): DashboardFrame {
  const appearance = statusAppearance(view);
  const footer = footerLines(view, width, color);
  const fixed = [
    centerVisible(renderPlainWordmark({ color }), width),
    renderLine([{ text: `● ${appearance.label}`, tone: appearance.tone }], width, color),
    ...renderFields(configurationFields(view), width, color),
    ...renderFields([destinationField(view)], width, color),
    ...commandChips(view, width, color),
  ];
  const entries = view.logs ?? [];
  const allLogLines = dashboardLogLines(entries, width, color);
  const heading = renderLine([{ text: 'LIVE LOGS', tone: 'heading' }], width, color);
  const budget = Math.max(0, rows - footer.length);
  if (fixed.length + 1 > budget) {
    return {
      lines: [...fixed.slice(0, Math.max(0, budget)), ...footer].slice(0, Math.max(0, rows)),
      state: resolveLogScrollState(allLogLines.length, 0, 0, 0),
    };
  }
  const capacity = budget - fixed.length - 1;
  if (capacity < 1) {
    return {
      lines: [...fixed, ...footer].slice(0, Math.max(0, rows)),
      state: resolveLogScrollState(allLogLines.length, 0, 0, 0),
    };
  }
  const window = windowLogLines(allLogLines, width, capacity, scrollOffset, unseenCount);
  const sizedFooter = footerLines(view, width, color, window.state);
  return {
    lines: [
      ...fixed,
      heading,
      ...window.lines,
      ...sizedFooter,
    ].slice(0, Math.max(0, rows)),
    state: window.state,
  };
}

export interface DashboardCursorPosition {
  readonly row: number;
  readonly column: number;
}

function promptInput(
  prompt: DashboardPrompt,
): { prefix: string; value: string } | undefined {
  switch (prompt.kind) {
    case 'destination':
      return { prefix: 'Destination URL: ', value: prompt.value };
    case 'personalityInstruction':
      return { prefix: 'Personality instruction: ', value: prompt.value };
    default:
      return undefined;
  }
}

export function getDashboardPromptCursor(
  view: DashboardView,
  dimensions: DashboardDimensions,
): DashboardCursorPosition | undefined {
  if (view.prompt === undefined) {
    return undefined;
  }
  const input = promptInput(view.prompt);
  if (input === undefined) {
    return undefined;
  }

  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return undefined;
  }

  const footer = footerLines(view, columns, false);
  const promptLineIndex = 0;
  const rendered = renderPromptInput(input.prefix, input.value, columns);

  return {
    row: Math.max(1, rows - footer.length + promptLineIndex + 1),
    column: Math.min(columns, Math.max(1, 1 + rendered.cursorOffset)),
  };
}

export function renderDashboardFrame(
  view: DashboardView,
  dimensions: DashboardDimensions,
  options: DashboardRenderOptions = {},
): DashboardFrame {
  const color = options.color === true;
  const columns = Math.max(0, Math.floor(dimensions.columns));
  const rows = Math.max(0, Math.floor(dimensions.rows));
  if (columns === 0 || rows === 0) {
    return { lines: [], state: EMPTY_SCROLL_STATE };
  }

  const scrollOffset = options.scrollOffset ?? 0;
  const unseenCount = options.unseenCount ?? 0;
  const frame = columns < 12 || rows < 6
    ? plainFrame(view, columns, rows, color, scrollOffset, unseenCount)
    : bodyFrame(view, columns, rows, color, scrollOffset, unseenCount);
  return {
    lines: frame.lines.map(line => padVisible(line, columns)),
    state: frame.state,
  };
}

export function renderDashboardLines(
  view: DashboardView,
  dimensions: DashboardDimensions,
  options: DashboardRenderOptions = {},
): string[] {
  return renderDashboardFrame(view, dimensions, options).lines;
}

export function renderDashboard(
  view: DashboardView,
  dimensions: DashboardDimensions,
  options: DashboardRenderOptions = {},
): string {
  return renderDashboardLines(view, dimensions, options).join('\n');
}
