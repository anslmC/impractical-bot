const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const MESSAGE_LIMIT = 8;
const POLL_INTERVAL_MS = 3000;
const DEBUG_POLL = false;

function loadConfiguration() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set; unable to locate the impractical-bot configuration.');
  }

  const configurationPath = join(localAppData, 'Impractical Bot', 'config.json');
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  if (!configuration || !Number.isInteger(configuration.cdpPort) ||
      configuration.cdpPort < 1 || configuration.cdpPort > 65535) {
    throw new Error('The configured CDP port is missing or invalid.');
  }
  return configuration;
}

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

function stripTrailingDeliveryStatus(content) {
  return content.replace(/(\S)Sent$/u, '$1');
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

function findMessagesPage(browser) {
  return browser.contexts()
    .flatMap(context => context.pages())
    .find(candidate => {
      try {
        const url = new URL(candidate.url());
        const isFacebookHost = url.hostname === 'facebook.com' ||
          url.hostname.endsWith('.facebook.com');
        return isFacebookHost && /^\/messages(?:\/|$)/.test(url.pathname);
      } catch {
        return false;
      }
    });
}

async function main() {
  let browser;
  let stopRequested = false;
  let wakePollDelay;
  const onInterrupt = () => {
    stopRequested = true;
    console.log('\nCtrl+C received; stopping the polling loop.');
    wakePollDelay?.();
  };
  process.on('SIGINT', onInterrupt);

  try {
    const configuration = loadConfiguration();
    const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;

    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch {
      throw new Error(
        `Could not connect to Brave at ${cdpEndpoint}. ` +
        'Ensure Brave is already running with CDP enabled on this address and port.'
      );
    }

    const page = findMessagesPage(browser);
    if (!page) {
      throw new Error(
        'No open Facebook Messages tab found in the connected Brave browser. ' +
        'Open Facebook Messages in Brave and run this script again.'
      );
    }

    console.log(`Connected Facebook Messages tab: ${page.url()}`);
    if (stopRequested) {
      return;
    }

    const messageLocator = page.locator(MESSAGE_SELECTOR);
    const readLatestMessages = async () => {
      const elements = await messageLocator.evaluateAll((elements, limit) =>
        elements.slice(-limit).map(element => ({
        messageId: element.getAttribute('data-message-id'),
        ariaLabel: element.getAttribute('aria-label'),
          textWithoutSenderHeading: (() => {
            const clone = element.cloneNode(true);
            clone.querySelectorAll('h4').forEach(heading => heading.remove());
            return (clone.innerText || '').trim();
          })(),
        })), MESSAGE_LIMIT
      );
      return elements.map(element => ({
        messageId: element.messageId,
        ariaLabel: element.ariaLabel,
        message: extractMessageContent(element.ariaLabel, element.textWithoutSenderHeading),
      }));
    };

    const baseline = await readLatestMessages();
    const seenMessageIds = new Set(
      baseline.map(message => message.messageId).filter(Boolean)
    );
    console.log(`Baseline recorded: ${seenMessageIds.size} unique message IDs.`);

    let pollNumber = 0;
    while (!stopRequested) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          wakePollDelay = undefined;
          resolve();
        }, POLL_INTERVAL_MS);
        wakePollDelay = () => {
          clearTimeout(timeout);
          wakePollDelay = undefined;
          resolve();
        };
      });
      if (stopRequested) {
        break;
      }

      pollNumber += 1;
      const messages = await readLatestMessages();
      if (stopRequested) {
        break;
      }

      const newMessages = [];
      for (const message of messages) {
        if (message.messageId && !seenMessageIds.has(message.messageId)) {
          seenMessageIds.add(message.messageId);
          newMessages.push(message);
        }
      }

      console.log(
        `Poll ${pollNumber}: sampled ${messages.length} rendered messages; ` +
        `${newMessages.length} new.`
      );
      if (DEBUG_POLL) {
        const snapshot = messages.map((message, index) => {
          const { timestamp, sender, direction } = classifyMessageLabel(message.ariaLabel);
          return [
            `${index + 1}. ID: ${message.messageId}`,
            `   Timestamp: ${JSON.stringify(timestamp)}`,
            `   Sender: ${sender}`,
            `   Direction: ${direction}`,
            `   Message: ${JSON.stringify(message.message || '(no text content)')}`,
          ].join('\n');
        }).join('\n');
        console.log(
          `=== Poll ${pollNumber} snapshot (${messages.length} messages) ===\n` +
          `${snapshot || '(no messages sampled)'}\n` +
          `=== End poll ${pollNumber} snapshot ===`
        );
      }
      for (const message of newMessages) {
        const { timestamp, sender, direction } = classifyMessageLabel(message.ariaLabel);
        console.log(`New message: ${JSON.stringify({
          id: message.messageId,
          timestamp,
          sender,
          direction,
          ariaLabel: message.ariaLabel,
          message: message.message.replace(/\s+/g, ' ') || '(no text content)',
        })}`);
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected from Brave.');
    }
  }
}

main().catch(error => {
  console.error(`Messenger polling failed: ${error.message}`);
  process.exitCode = 1;
});
