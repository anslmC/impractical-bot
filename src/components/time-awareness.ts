export const TIME_AWARENESS_INSTRUCTION_MARKER = 'CURRENT TEMPORAL CONTEXT:';

export type DayPeriod = 'Morning' | 'Afternoon' | 'Evening' | 'Late night';

export interface TimeContext {
  date: string;
  weekday: string;
  localTime: string;
  dayPeriod: DayPeriod;
  timeZone: string;
  utcOffset: string;
  isoTimestamp: string;
}

export interface TimeContextOptions {
  now?: Date;
  timeZone?: string;
  locale?: string;
}

function resolveTimeZone(timeZone?: string): string {
  const configured = timeZone?.trim();
  if (configured) {
    return configured;
  }
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.trim() ? resolved : 'UTC';
}

export function classifyDayPeriod(hour: number): DayPeriod {
  if (hour >= 22 || hour < 5) {
    return 'Late night';
  }
  if (hour < 12) {
    return 'Morning';
  }
  if (hour < 17) {
    return 'Afternoon';
  }
  return 'Evening';
}

function partsToRecord(parts: readonly Intl.DateTimeFormatPart[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      record[part.type] = part.value;
    }
  }
  return record;
}

function formatLocalTime(now: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(now)
    .replace(/[\u00A0\u202F]/gu, ' ');
}

function resolveLocalHour(now: Date, timeZone: string, locale: string): number {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Number.parseInt(partsToRecord(parts).hour ?? '0', 10);
}

function formatUtcOffset(now: Date, timeZone: string, locale: string): string {
  const zoneName = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(now)
    .find(part => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/u.exec(zoneName);
  if (!match) {
    return '+00:00';
  }
  const hours = match[2].padStart(2, '0');
  const minutes = (match[3] ?? '00').padStart(2, '0');
  return `${match[1]}${hours}:${minutes}`;
}

export function buildTimeContext({
  now = new Date(),
  timeZone,
  locale = 'en-US',
}: TimeContextOptions = {}): TimeContext {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const dateParts = partsToRecord(new Intl.DateTimeFormat(locale, {
    timeZone: resolvedTimeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).formatToParts(now));
  const weekday = dateParts.weekday ?? '';
  const hour = resolveLocalHour(now, resolvedTimeZone, locale);

  return {
    date: `${weekday}, ${dateParts.month} ${dateParts.day}, ${dateParts.year}`,
    weekday,
    localTime: formatLocalTime(now, resolvedTimeZone, locale),
    dayPeriod: classifyDayPeriod(hour),
    timeZone: resolvedTimeZone,
    utcOffset: formatUtcOffset(now, resolvedTimeZone, locale),
    isoTimestamp: now.toISOString(),
  };
}

export function buildTimeAwarenessInstruction(context: TimeContext): string {
  return [
    TIME_AWARENESS_INSTRUCTION_MARKER,
    'The following is the current runtime time for this reply. It is not conversation history, transcript content, or a memory of a past event.',
    `- Date: ${context.date}`,
    `- Local time: ${context.localTime}`,
    `- Day period: ${context.dayPeriod}`,
    `- Timezone: ${context.timeZone}`,
    `- UTC offset: ${context.utcOffset}`,
    `- ISO timestamp: ${context.isoTimestamp}`,
    'Use this context only when it naturally helps. You may recognize a greeting that fits the current time, understand references to today, yesterday, tomorrow, and weekdays, recognize whether someone means morning, afternoon, evening, or late night, make an occasional natural observation about the time when relevant, and understand when a conversation crosses midnight or a date boundary.',
    'Do not announce the current time unnecessarily or force time-related remarks into ordinary conversations. Do not claim to know another participant\'s local timezone or assume everyone shares your timezone. Do not invent personal schedules, routines, or offline activities, and do not claim physical experiences or activities. Do not treat the current timestamp as conversational memory.',
  ].join('\n');
}

export function appendTimeAwarenessInstruction(
  systemInstruction: string,
  options: TimeContextOptions = {},
): string {
  const instruction = buildTimeAwarenessInstruction(buildTimeContext(options));
  const sections = systemInstruction.split(/\n{2,}/u);
  const sectionIndex = sections.findIndex(section =>
    section.trimStart().startsWith(TIME_AWARENESS_INSTRUCTION_MARKER)
  );
  if (sectionIndex >= 0) {
    sections[sectionIndex] = instruction;
    return sections.join('\n\n');
  }
  return [systemInstruction.trim(), instruction].filter(Boolean).join('\n\n');
}
