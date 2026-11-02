import { extractConversationMessageBody } from './conversation-context.js';

export interface ExtractedTimestamp {
  original: string | null;
  normalized: string | null;
  resolved: boolean;
}

export interface MessageDetails {
  messageId: string;
  message: string;
  sender: string;
  direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN';
}

function unresolvedTimestamp(original: string | null): ExtractedTimestamp {
  return { original, normalized: null, resolved: false };
}

function normalizeFullTimestamp(original: string): ExtractedTimestamp {
  const match = original.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (!match) {
    return unresolvedTimestamp(original);
  }

  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const month = monthNames.indexOf(match[1].toLowerCase()) + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6].toUpperCase();
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (day < 1 || day > daysInMonth[month - 1] || hour < 1 || hour > 12 || minute > 59) {
    return unresolvedTimestamp(original);
  }

  const hour24 = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    original,
    normalized: `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:00`,
    resolved: true,
  };
}

function parseTimestampLabel(ariaLabel: string): {
  timestamp: ExtractedTimestamp;
  remainder: string;
} {
  const fullDateMatch = ariaLabel.match(
    /^At\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s+(?:AM|PM)),\s*(.*)$/i,
  );
  if (fullDateMatch) {
    return {
      timestamp: normalizeFullTimestamp(fullDateMatch[1]),
      remainder: fullDateMatch[2].trim(),
    };
  }

  const weekdayTimeMatch = ariaLabel.match(
    /^At\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}:\d{2}),\s*(.*)$/i,
  );
  if (weekdayTimeMatch) {
    return {
      timestamp: unresolvedTimestamp(weekdayTimeMatch[1]),
      remainder: weekdayTimeMatch[2].trim(),
    };
  }

  const twelveHourTimeMatch = ariaLabel.match(/^At\s+(\d{1,2}:\d{2}\s+(?:AM|PM)),\s*(.*)$/i);
  if (twelveHourTimeMatch) {
    return {
      timestamp: unresolvedTimestamp(twelveHourTimeMatch[1]),
      remainder: twelveHourTimeMatch[2].trim(),
    };
  }

  const twentyFourHourTimeMatch = ariaLabel.match(/^At\s+(\d{1,2}:\d{2}),\s*(.*)$/);
  if (twentyFourHourTimeMatch) {
    return {
      timestamp: unresolvedTimestamp(twentyFourHourTimeMatch[1]),
      remainder: twentyFourHourTimeMatch[2].trim(),
    };
  }

  const unknownTimestampMatch = ariaLabel.match(/^At\s+([^,]+),\s*(.*)$/);
  if (unknownTimestampMatch) {
    return {
      timestamp: unresolvedTimestamp(unknownTimestampMatch[1].trim()),
      remainder: unknownTimestampMatch[2].trim(),
    };
  }

  const timestampOnlyMatch = ariaLabel.match(/^At\s+(.+)$/);
  return {
    timestamp: unresolvedTimestamp(timestampOnlyMatch?.[1].trim() ?? null),
    remainder: '',
  };
}

const OUTGOING_PRESENTATION_PREFIX = /^(?:You\s+sent(?:\s*:\s*|\s+)|You:\s+)/u;

function hasOutgoingPresentation(textWithoutSenderHeading: string | undefined): boolean {
  return typeof textWithoutSenderHeading === 'string' &&
    OUTGOING_PRESENTATION_PREFIX.test(textWithoutSenderHeading.trimStart());
}

export function classifyMessageLabel(
  ariaLabel: string | null,
  textWithoutSenderHeading?: string,
): {
  timestamp: ExtractedTimestamp;
  sender: string;
  direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN';
} {
  if (typeof ariaLabel !== 'string') {
    return hasOutgoingPresentation(textWithoutSenderHeading)
      ? {
          timestamp: unresolvedTimestamp(null),
          sender: 'You',
          direction: 'OUTGOING',
        }
      : {
          timestamp: unresolvedTimestamp(null),
          sender: 'UNKNOWN',
          direction: 'UNKNOWN',
        };
  }

  const { timestamp, remainder } = parseTimestampLabel(ariaLabel);
  const messageMatch = remainder.match(/^([^:\r\n]+):\s+\S[\s\S]*$/);
  const senderOnlyMatch = remainder.match(/^([^:\r\n]+)$/);
  const sender = messageMatch
    ? messageMatch[1].trim()
    : senderOnlyMatch
      ? senderOnlyMatch[1].trim()
      : '';

  if (!sender) {
    return hasOutgoingPresentation(textWithoutSenderHeading)
      ? { timestamp, sender: 'You', direction: 'OUTGOING' }
      : { timestamp, sender: 'UNKNOWN', direction: 'UNKNOWN' };
  }

  return {
    timestamp,
    sender,
    direction: sender === 'You' ? 'OUTGOING' : 'INCOMING',
  };
}

const DELIVERY_STATUS_PATTERN = 'Sent|Delivered|Seen|Sending';
const TRAILING_DELIVERY_STATUS = new RegExp(
  `^(.*\\S)(\\s+|[\\s]*[·•|;\\-–—✓✔][\\s]*)?(${DELIVERY_STATUS_PATTERN})([.!…✓✔·•]*)$`,
  'su',
);
const LEGITIMATE_STATUS_PRECEDING_WORDS = new Set([
  'have', 'has', 'had',
  'was', 'were', 'is', 'are', 'am', 'be', 'been', 'being',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'do', 'does', 'did', 'not', 'never', 'just', 'already', 'still', 'ever',
  "i've", "we've", "they've", "you've", "he's", "she's", "it's", "that's",
]);

function normalizeText(content: string): string {
  return content
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u00a0\u202f]/gu, ' ')
    .trim();
}

function stripOutgoingPresentationPrefix(content: string): string {
  const withoutPrefix = content.replace(
    /^(?:You\s+sent(?:\s*:\s*|\s+)|You:\s+)/u,
    '',
  );
  return withoutPrefix.trim() ? withoutPrefix : content;
}

function stripTrailingDeliveryStatus(content: string): string {
  const match = content.match(TRAILING_DELIVERY_STATUS);
  if (!match) {
    return content;
  }

  const body = match[1].replace(/[\s·•|;\-–—✓✔]+$/u, '').trim();
  const precedingWord = body.match(/([A-Za-z']+)[^A-Za-z']*$/u)?.[1].toLowerCase() ?? '';
  if (LEGITIMATE_STATUS_PRECEDING_WORDS.has(precedingWord)) {
    return content;
  }
  return body;
}

function normalizeMessageContent(
  content: string,
  { stripOutgoingPrefix = false }: { stripOutgoingPrefix?: boolean } = {},
): string {
  let normalized = normalizeText(content);
  if (stripOutgoingPrefix) {
    normalized = stripOutgoingPresentationPrefix(normalized);
  }
  return stripTrailingDeliveryStatus(normalized).trim();
}

function extractAriaLabelBody(ariaLabel: string | null): string | null {
  if (typeof ariaLabel !== 'string') {
    return null;
  }

  const { remainder } = parseTimestampLabel(ariaLabel);
  const match = remainder.match(/^([^:\r\n]+):\s+([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const sender = classifyMessageLabel(ariaLabel).sender;
  if (sender === 'UNKNOWN' || match[1].trim() !== sender) {
    return null;
  }

  return match[2];
}

export function extractMessageContent(ariaLabel: string | null, textWithoutSenderHeading: string): string {
  const labelBody = extractAriaLabelBody(ariaLabel);
  if (labelBody !== null) {
    return normalizeMessageContent(labelBody);
  }

  return normalizeMessageContent(textWithoutSenderHeading, {
    stripOutgoingPrefix: true,
  });
}

export function extractMessageDetails({
  messageId,
  ariaLabel,
  textWithoutSenderHeading,
}: {
  messageId: string;
  ariaLabel: string | null;
  textWithoutSenderHeading: string;
}): MessageDetails {
  const { sender, direction } = classifyMessageLabel(
    ariaLabel,
    textWithoutSenderHeading,
  );
  return {
    messageId,
    message: extractConversationMessageBody(
      extractMessageContent(ariaLabel, textWithoutSenderHeading),
    ).text,
    sender,
    direction,
  };
}
