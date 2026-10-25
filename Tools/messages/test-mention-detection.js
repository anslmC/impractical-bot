const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { generateAliases } = require('../components/alias-engine');

const LOG_SELECTOR = '[role="log"][aria-live="polite"]';
const MESSAGE_SELECTOR = '[data-message-id]';
const LOG_PREFIX = '__MESSENGER_MENTION__:';

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
  if (typeof configuration.puppetName !== 'string' || !configuration.puppetName.trim()) {
    throw new Error('The configured puppetName is missing or empty; set it before running this experiment.');
  }
  return configuration;
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
  let page;
  let observerAttached = false;
  let stopRequested = false;
  let resolveStop;
  const stopped = new Promise(resolve => {
    resolveStop = resolve;
  });
  const onInterrupt = () => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    console.log('\nCtrl+C received; disconnecting the observer.');
    resolveStop();
  };
  process.on('SIGINT', onInterrupt);

  try {
    const configuration = loadConfiguration();
    const { valids } = generateAliases(configuration.puppetName);
    const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;

    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch {
      throw new Error(
        `Could not connect to Brave at ${cdpEndpoint}. ` +
        'Ensure Brave is already running with CDP enabled on this address and port.'
      );
    }

    if (stopRequested) {
      return;
    }

    page = findMessagesPage(browser);
    if (!page) {
      throw new Error(
        'No open Facebook Messages tab found in the connected Brave browser. ' +
        'Open Facebook Messages in Brave and run this script again.'
      );
    }

    page.on('console', message => {
      const text = message.text();
      if (text.startsWith(LOG_PREFIX)) {
        console.log(text.slice(LOG_PREFIX.length));
      }
    });

    await page.locator(LOG_SELECTOR).evaluate((log, options) => {
      const processedMessageIds = new Set();
      const normalize = value => value.replace(/\s+/g, ' ').trim().toLowerCase();
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            const isElement = node.nodeType === Node.ELEMENT_NODE;
            if (!isElement) {
              continue;
            }

            const messageElements = [];
            if (node.matches(options.messageSelector)) {
              messageElements.push(node);
            }
            messageElements.push(...node.querySelectorAll(options.messageSelector));

            for (const message of messageElements) {
              const id = message.getAttribute('data-message-id');
              if (id === null || processedMessageIds.has(id)) {
                continue;
              }
              processedMessageIds.add(id);

              const text = message.innerText || message.textContent || '';
              const normalizedText = normalize(text);
              let matchedAlias = null;
              let matchedText = null;
              for (const alias of options.aliases) {
                const escapedAlias = alias.trim().split(/\s+/)
                  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  .join('\\s+');
                const aliasMatch = text.match(new RegExp(escapedAlias, 'iu'));
                if (aliasMatch) {
                  matchedAlias = alias;
                  matchedText = aliasMatch[0];
                  break;
                }
              }

              const mention = matchedAlias !== null;
              const result = { id, mention, matchedAlias, matchedText };
              console.log(`${options.logPrefix}${JSON.stringify(result)}`);
            }
          }
        }
      });
      observer.observe(log, { childList: true, subtree: true });
      window.__impracticalBotMentionObserver = observer;
    }, {
      messageSelector: MESSAGE_SELECTOR,
      logPrefix: LOG_PREFIX,
      aliases: valids,
    });
    observerAttached = true;

    console.log(
      `Mention observer attached to ${LOG_SELECTOR} on ${page.url()} ` +
      `for configured puppetName ${JSON.stringify(configuration.puppetName)}. ` +
      'Waiting for added message elements; press Ctrl+C to stop.'
    );
    if (!stopRequested) {
      await stopped;
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (observerAttached && page) {
      try {
        await page.evaluate(() => {
          const observer = window.__impracticalBotMentionObserver;
          if (observer) {
            observer.disconnect();
            delete window.__impracticalBotMentionObserver;
          }
        });
      } catch {
        // The browser page may have closed before cleanup.
      }
    }
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected from Brave.');
    }
  }
}

main().catch(error => {
  console.error(`Messenger mention-detection experiment failed: ${error.message}`);
  process.exitCode = 1;
});
