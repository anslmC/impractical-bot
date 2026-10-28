function unresolvedTimestamp(original) {
  return { original, normalized: null, resolved: false };
}

function normalizeFullTimestamp(original) {
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
  const pad = value => String(value).padStart(2, '0');
  return {
    original,
    normalized: `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:00`,
    resolved: true,
  };
}

function parseTimestampLabel(ariaLabel) {
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

function classifyMessageLabel(ariaLabel) {
  if (typeof ariaLabel !== 'string') {
    return {
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
    return { timestamp, sender: 'UNKNOWN', direction: 'UNKNOWN' };
  }

  return {
    timestamp,
    sender,
    direction: sender === 'You' ? 'OUTGOING' : 'INCOMING',
  };
}

const LEGITIMATE_SENT_PRECEDING_WORDS = new Set(['have', 'has', 'had']);

function stripTrailingDeliveryStatus(content) {
  const withoutAttachedStatus = content.replace(/(\S)Sent$/u, '$1');
  const separatedStatus = withoutAttachedStatus.match(/^(.*?\S)\s+Sent$/su);
  if (!separatedStatus) {
    return withoutAttachedStatus;
  }
  const precedingWord = separatedStatus[1].match(/(\S+)$/u)?.[1].toLowerCase() ?? '';
  if (LEGITIMATE_SENT_PRECEDING_WORDS.has(precedingWord)) {
    return withoutAttachedStatus;
  }
  return separatedStatus[1];
}

function extractMessageContent(ariaLabel, textWithoutSenderHeading) {
  if (ariaLabel === null) {
    return stripTrailingDeliveryStatus(textWithoutSenderHeading);
  }

  const { remainder } = parseTimestampLabel(ariaLabel);
  const match = remainder.match(/^([^:\r\n]+):\s+([\s\S]*)$/);
  if (!match) {
    return stripTrailingDeliveryStatus(textWithoutSenderHeading);
  }

  const sender = classifyMessageLabel(ariaLabel).sender;
  if (sender === 'UNKNOWN' || match[1].trim() !== sender) {
    return stripTrailingDeliveryStatus(textWithoutSenderHeading);
  }

  return stripTrailingDeliveryStatus(match[2].trim());
}

function extractMessageDetails({ messageId, ariaLabel, textWithoutSenderHeading }) {
  const { sender, direction } = classifyMessageLabel(ariaLabel);
  return {
    messageId,
    message: extractMessageContent(ariaLabel, textWithoutSenderHeading),
    sender,
    direction,
  };
}

module.exports = {
  classifyMessageLabel,
  extractMessageContent,
  extractMessageDetails,
};