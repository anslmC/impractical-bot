const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { classifyMessageLabel, extractMessageDetails } = require('../components/message-extraction');

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const TARGET_MESSAGE_COUNT = 30;
const TOP_SETTLE_MAX_SNAPSHOTS = 5;
const TOP_SETTLE_STABLE_COMPARISONS = 2;

function loadConfiguration() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set; unable to locate the impractical-bot configuration.');
  }

  const configurationPath = join(localAppData, 'Impractical Bot', 'config.json');
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  if (sender === 'UNKNOWN' || match[1].trim() !== sender) {
    return textWithoutSenderHeading;
  }

  return match[2].trim();
}

async function main() {
  let browser;

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

    const page = browser.contexts()
      .flatMap(context => context.pages())
      .find(candidate => {
        const url = new URL(candidate.url());
        const isFacebookHost = url.hostname === 'facebook.com' ||
          url.hostname.endsWith('.facebook.com');
        return isFacebookHost && /^\/messages(?:\/|$)/.test(url.pathname);
      });

    if (!page) {
      throw new Error(
        'No open Facebook Messages tab found in the connected Brave browser. ' +
        'Open Facebook Messages in Brave and run this script again.'
      );
    }

    console.log(`Connected Facebook Messages tab: ${page.url()}`);

    const messageLocator = page.locator(MESSAGE_SELECTOR);
    const initialCount = await messageLocator.count();
    let scrollContainer;

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
      scrollContainer = containerHandle.asElement();
    }

    if (scrollContainer) {
      console.log('Found a scrollable conversation container; moving to the latest messages.');
      await scrollContainer.evaluate(element => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(300);
    } else {
      console.log(
        'No scrollable conversation container found; reading currently rendered messages only.'
      );
    }

    const collectRenderedMessages = async () => {
      const elements = await messageLocator.evaluateAll(elements =>
        elements.map(element => ({
          messageId: element.getAttribute('data-message-id'),
          ariaLabel: element.getAttribute('aria-label'),
          textWithoutSenderHeading: (() => {
            const clone = element.cloneNode(true);
            clone.querySelectorAll('h4').forEach(heading => heading.remove());
            return (clone.innerText || '').trim();
          })(),
        }))
      );
      return elements.map(extractMessageDetails);
    };

    const seenMessageIds = new Set();
    let collectedMessages = [];
    const initialMessages = await collectRenderedMessages();

    for (const message of initialMessages) {
      if (message.messageId && !seenMessageIds.has(message.messageId)) {
        seenMessageIds.add(message.messageId);
        collectedMessages.push(message);
      }
    }
    collectedMessages = collectedMessages.slice(-TARGET_MESSAGE_COUNT);

    if (initialMessages.length === 0) {
      console.log('No rendered messages matched the requested message selector.');
    }

    let topSettleSnapshotCount = 0;
    let stableTopSnapshotComparisons = 0;
    let previousTopMessageCount = null;
    let previousTopOldestMessageId = null;
    while (scrollContainer && collectedMessages.length < TARGET_MESSAGE_COUNT) {
      let previousScrollTop;
      let previousMessageIds;
      try {
        previousMessageIds = await messageLocator.evaluateAll(elements =>
          elements
            .map(element => element.getAttribute('data-message-id'))
            .filter(messageId => messageId !== null)
        );
        previousScrollTop = await scrollContainer.evaluate(element => {
          const previousPosition = element.scrollTop;
          const increment = Math.max(200, Math.floor(element.clientHeight * 0.75));
          element.scrollTop = Math.max(0, previousPosition - increment);
          return previousPosition;
        });
      } catch {
        console.log('Stopped: the conversation scroll container is no longer available.');
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
      const newlyFoundMessages = [];

      for (const message of renderedMessages) {
        if (message.messageId && !seenMessageIds.has(message.messageId)) {
          seenMessageIds.add(message.messageId);
          newlyFoundMessages.push(message);
        }
      }

      const collectedIndexes = new Map(
        collectedMessages.map((message, index) => [message.messageId, index])
      );
      const knownMessagesInSnapshot = [];
      const seenSnapshotIds = new Set();

      for (const message of renderedMessages) {
        const messageIndex = collectedIndexes.get(message.messageId);
        if (messageIndex !== undefined && !seenSnapshotIds.has(message.messageId)) {
          seenSnapshotIds.add(message.messageId);
          knownMessagesInSnapshot.push(collectedMessages[messageIndex]);
        }
      }

      const knownMessagePositions = knownMessagesInSnapshot
        .map(message => collectedIndexes.get(message.messageId))
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

      let currentScrollTop;
      try {
        currentScrollTop = await scrollContainer.evaluate(element => element.scrollTop);
      } catch {
        console.log('Stopped: the conversation scroll container is no longer available.');
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
          console.log(
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
        console.log('Could not restore the conversation scroll container to the bottom.');
      }
    }

    if (collectedMessages.length === 0) {
      console.log('No messages with usable data-message-id values were collected.');
    } else {
      console.log(
        `Collected ${collectedMessages.length} unique messages (oldest to newest):`
      );
      for (const message of collectedMessages) {
        const { timestamp, sender, direction } = classifyMessageLabel(message.ariaLabel);
        if (sender === 'UNKNOWN' || direction === 'UNKNOWN') {
          const rawLabel = message.ariaLabel === null
            ? '(missing)'
            : JSON.stringify(message.ariaLabel);
          console.log(
            `UNKNOWN diagnostic | ID: ${message.messageId} | raw aria-label: ${rawLabel}`
          );
        }
        const text = message.message.replace(/\s+/g, ' ') || '(no text content)';
        console.log(
          `${message.messageId} | ${JSON.stringify(timestamp)} | ${sender} | ${direction} | ${text}`
        );
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch(error => {
  console.error(`Backread test failed: ${error.message}`);
  process.exitCode = 1;
});