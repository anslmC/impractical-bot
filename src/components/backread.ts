import type { ElementHandle, Page } from 'playwright';
import {
  createMessageIdentityTracker,
  fingerprintMessageText,
} from './message-identity.js';

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const DEBUG_BACKREAD = false;
const TARGET_MESSAGE_COUNT = 30;
const TOP_SETTLE_MAX_SNAPSHOTS = 5;
const TOP_SETTLE_STABLE_COMPARISONS = 2;

interface RenderedMessage {
  messageId: string | null;
  ariaLabel: string | null;
  message: string;
}

export interface BackreadMessage {
  id: string;
  timestamp: MessageTimestamp;
  sender: string;
  direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN';
  message: string;
  ariaLabel: string | null;
}

export interface MessageTimestamp {
  original: string | null;
  normalized: string | null;
  resolved: boolean;
}

export interface BackreadResult {
  messages: BackreadMessage[];
  diagnostics: string[];
}

function unresolvedTimestamp(original: string | null): MessageTimestamp {
  return { original, normalized: null, resolved: false };
}

function normalizeFullTimestamp(original: string): MessageTimestamp {
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
  timestamp: MessageTimestamp;
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

export function classifyMessageLabel(
  ariaLabel: string | null,
): Pick<BackreadMessage, 'timestamp' | 'sender' | 'direction'> {
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

function stripTrailingDeliveryStatus(content: string): string {
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

function extractMessageContent(ariaLabel: string | null, textWithoutSenderHeading: string): string {
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

export async function readMessengerMessages(page: Page): Promise<BackreadResult> {
  const diagnostics: string[] = [];
  const messageLocator = page.locator(MESSAGE_SELECTOR);
  const initialCount = await messageLocator.count();
  let scrollContainer: ElementHandle<HTMLElement> | null;

  if (initialCount > 0) {
    const containerHandle = await messageLocator.first().evaluateHandle(message => {
      let ancestor = message.parentElement;
      while (ancestor && ancestor !== document.body &&
             ancestor !== document.documentElement) {
        const overflowY = window.getComputedStyle(ancestor).overflowY;
        const hasScrollableOverflow = ['auto', 'scroll', 'overlay'].includes(overflowY);
        if (hasScrollableOverflow && ancestor.scrollHeight > ancestor.clientHeight + 1) {
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
      return null;
    });
    scrollContainer = containerHandle.asElement() as ElementHandle<HTMLElement> | null;
  } else {
    scrollContainer = null;
  }

  if (scrollContainer) {
    await scrollContainer.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(300);
  } else {
    diagnostics.push(
      'No scrollable conversation container found; reading currently rendered messages only.',
    );
  }

  const collectRenderedMessages = async (): Promise<RenderedMessage[]> => {
    const elements = await messageLocator.evaluateAll(elements =>
      elements.map(element => ({
      messageId: element.getAttribute('data-message-id'),
      ariaLabel: element.getAttribute('aria-label'),
        innerText: ((element as HTMLElement).innerText || '').trim(),
        textWithoutSenderHeading: (() => {
          const clone = (element as HTMLElement).cloneNode(true) as HTMLElement;
          clone.querySelectorAll('h4').forEach(heading => heading.remove());
          return (clone.innerText || '').trim();
        })(),
      }))
    );
    return elements.map(element => ({
      messageId: element.messageId,
      ariaLabel: element.ariaLabel,
      message: extractMessageContent(
        element.ariaLabel,
        element.textWithoutSenderHeading,
      ),
    }));
  };

  const seenMessageIds = new Set<string>();
  let collectedMessages: RenderedMessage[] = [];
  const initialMessages = await collectRenderedMessages();

  for (const message of initialMessages) {
    if (message.messageId && !seenMessageIds.has(message.messageId)) {
      seenMessageIds.add(message.messageId);
      collectedMessages.push(message);
    }
  }
  collectedMessages = collectedMessages.slice(-TARGET_MESSAGE_COUNT);

  if (initialMessages.length === 0) {
    diagnostics.push('No rendered messages matched the requested message selector.');
  }

  let topSettleSnapshotCount = 0;
  let stableTopSnapshotComparisons = 0;
  let previousTopMessageCount: number | null = null;
  let previousTopOldestMessageId: string | null = null;
  while (scrollContainer && collectedMessages.length < TARGET_MESSAGE_COUNT) {
    let previousScrollTop: number;
    let previousMessageIds: string[];
    try {
      previousMessageIds = await messageLocator.evaluateAll(elements =>
        elements
          .map(element => element.getAttribute('data-message-id'))
          .filter((messageId): messageId is string => messageId !== null)
      );
      previousScrollTop = await scrollContainer.evaluate(element => {
        const previousPosition = element.scrollTop;
        const increment = Math.max(200, Math.floor(element.clientHeight * 0.75));
        element.scrollTop = Math.max(0, previousPosition - increment);
        return previousPosition;
      });
    } catch {
      diagnostics.push('Stopped: the conversation scroll container is no longer available.');
      break;
    }

    const progressHandle = await page.waitForFunction(
      ({ selector, previousIds }) => {
        const previousMessageIds = new Set(previousIds);
        return Array.from(document.querySelectorAll(selector)).some(element => {
          const messageId = element.getAttribute('data-message-id');
          return messageId !== null && !previousMessageIds.has(messageId);
        });
      },
      { selector: MESSAGE_SELECTOR, previousIds: previousMessageIds },
      { timeout: 1_500, polling: 100 },
    ).catch(() => undefined);
    await progressHandle?.dispose();
    const renderedMessages = await collectRenderedMessages();
    const newlyFoundMessages: RenderedMessage[] = [];

    for (const message of renderedMessages) {
      if (message.messageId && !seenMessageIds.has(message.messageId)) {
        seenMessageIds.add(message.messageId);
        newlyFoundMessages.push(message);
      }
    }
    const collectedIndexes = new Map(
      collectedMessages.map((message, index) => [message.messageId, index])
    );
    const knownMessagesInSnapshot: RenderedMessage[] = [];
    const seenSnapshotIds = new Set<string>();

    for (const message of renderedMessages) {
      const messageIndex = collectedIndexes.get(message.messageId);
      if (messageIndex !== undefined && !seenSnapshotIds.has(message.messageId!)) {
        seenSnapshotIds.add(message.messageId!);
        knownMessagesInSnapshot.push(collectedMessages[messageIndex]);
      }
    }

    const knownMessagePositions = knownMessagesInSnapshot
      .map(message => collectedIndexes.get(message.messageId))
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => left - right);
    knownMessagePositions.forEach((position, index) => {
      collectedMessages[position] = knownMessagesInSnapshot[index];
    });

    for (const message of newlyFoundMessages) {
      const snapshotIndex = renderedMessages.indexOf(message);
      let insertionIndex = -1;

      for (let index = snapshotIndex + 1; index < renderedMessages.length; index += 1) {
        const nextIndex = collectedMessages.findIndex(
          collected => collected.messageId === renderedMessages[index].messageId
        );
        if (nextIndex !== -1) {
          insertionIndex = nextIndex;
          break;
        }
      }

      if (insertionIndex === -1) {
        for (let index = snapshotIndex - 1; index >= 0; index -= 1) {
          const previousIndex = collectedMessages.findIndex(
            collected => collected.messageId === renderedMessages[index].messageId
          );
          if (previousIndex !== -1) {
            insertionIndex = previousIndex + 1;
            break;
          }
        }
      }

      collectedMessages.splice(insertionIndex === -1 ? 0 : insertionIndex, 0, message);
    }
    collectedMessages = collectedMessages.slice(-TARGET_MESSAGE_COUNT);

    if (collectedMessages.length >= TARGET_MESSAGE_COUNT) {
      break;
    }

    let currentScrollTop: number;
    try {
      currentScrollTop = await scrollContainer.evaluate(element => element.scrollTop);
    } catch {
      diagnostics.push('Stopped: the conversation scroll container is no longer available.');
      break;
    }

    if (currentScrollTop <= 0) {
      const oldestMessageId = collectedMessages[0]?.messageId ?? null;
      if (topSettleSnapshotCount > 0 &&
          collectedMessages.length === previousTopMessageCount &&
          oldestMessageId === previousTopOldestMessageId) {
        stableTopSnapshotComparisons += 1;
      } else {
        stableTopSnapshotComparisons = 0;
      }
      topSettleSnapshotCount += 1;
      previousTopMessageCount = collectedMessages.length;
      previousTopOldestMessageId = oldestMessageId;

      if (stableTopSnapshotComparisons >= TOP_SETTLE_STABLE_COMPARISONS) {
        break;
      }
      if (topSettleSnapshotCount >= TOP_SETTLE_MAX_SNAPSHOTS) {
        diagnostics.push(
          'Stopped settling at the conversation top after 5 snapshots without stable messages.'
        );
        break;
      }
      continue;
    }

    if (topSettleSnapshotCount > 0) {
      topSettleSnapshotCount = 0;
      stableTopSnapshotComparisons = 0;
      previousTopMessageCount = null;
      previousTopOldestMessageId = null;
    }

    if (currentScrollTop === previousScrollTop) {
      break;
    }
  }

  if (scrollContainer) {
    try {
      await scrollContainer.evaluate(element => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      });
      await page.waitForTimeout(300);
    } catch {
      diagnostics.push('Could not restore the conversation scroll container to the bottom.');
    }
  }

  if (collectedMessages.length === 0) {
    diagnostics.push('No messages with usable data-message-id values were collected.');
  }

  const collectedBackreadMessages = collectedMessages.map(message => {
    const classification = classifyMessageLabel(message.ariaLabel);
    return {
      id: message.messageId!,
      timestamp: classification.timestamp,
      sender: classification.sender,
      direction: classification.direction,
      message: message.message,
      ariaLabel: message.ariaLabel,
    };
  });
  const identity = createMessageIdentityTracker();
  const reconciled = identity.reconcile(collectedBackreadMessages.map(message => ({
    ...message,
    messageId: message.id,
  })));
  for (const duplicate of reconciled.duplicates) {
    diagnostics.push(
      `Merged duplicate rendered record: observed ${duplicate.observedMessageId}, ` +
      `canonical ${duplicate.canonicalMessageId}, ${duplicate.direction}, ` +
      `sender ${JSON.stringify(duplicate.sender)}, ` +
      `fingerprint ${fingerprintMessageText(duplicate.message)}.`,
    );
  }
  const messages = reconciled.messages.map(({ messageId, ...message }) => ({
    ...message,
    id: messageId,
  }));

  const aggregateMessages = messages.flatMap(message => {
    const lines: string[] = [];
    if (message.sender === 'UNKNOWN' || message.direction === 'UNKNOWN') {
      const rawLabel = message.ariaLabel === null
        ? '(missing)'
        : JSON.stringify(message.ariaLabel);
      lines.push(`UNKNOWN diagnostic | ID: ${message.id} | raw aria-label: ${rawLabel}`);
    }
    const text = message.message.replace(/\s+/g, ' ') || '(no text content)';
    lines.push(
      `${message.id} | ${JSON.stringify(message.timestamp)} | ${message.sender} | ` +
      `${message.direction} | ${text}`,
    );
    return lines;
  });
  if (DEBUG_BACKREAD) {
    diagnostics.push([
      `Collected ${messages.length} unique messages (oldest to newest):`,
      ...aggregateMessages,
    ].map(line => `[DEBUG] ${line}`).join('\n'));
  }

  return { messages, diagnostics };
}