const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const LOG_SELECTOR = '[role="log"][aria-live="polite"]';
const MESSAGE_SELECTOR = '[data-message-id]';
const LOG_PREFIX = '__MESSENGER_WAKER__:';
const DEBUG_WAKER = false;

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
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          const addedNodes = [];
          for (const node of mutation.addedNodes) {
            const isElement = node.nodeType === Node.ELEMENT_NODE;
            const nodeMatchesMessage = isElement && node.matches(options.messageSelector);
            const messageElements = [];
            if (nodeMatchesMessage) {
              messageElements.push(node);
            }
            if (isElement) {
              messageElements.push(...node.querySelectorAll(options.messageSelector));
            }
            if (messageElements.length === 0) {
              continue;
            }

            addedNodes.push({
              tagName: isElement ? node.tagName.toLowerCase() : node.nodeName.toLowerCase(),
              role: isElement ? node.getAttribute('role') : null,
              nodeMatchesMessage: Boolean(nodeMatchesMessage),
              subtreeContainsMessageElements: messageElements.length > 0,
              messages: messageElements.map(message => ({
                id: message.getAttribute('data-message-id'),
                ariaRoleDescription: message.getAttribute('aria-roledescription'),
              })),
            });
          }

          if (addedNodes.length > 0) {
            const diagnostic = options.debug
              ? JSON.stringify({ mutationType: mutation.type, addedNodes })
              : 'New message detected; waking poller.';
            console.log(`${options.logPrefix}${diagnostic}`);
          }
        }
      });
      observer.observe(log, { childList: true, subtree: true });
      window.__impracticalBotWakerObserver = observer;
    }, { messageSelector: MESSAGE_SELECTOR, logPrefix: LOG_PREFIX, debug: DEBUG_WAKER });
    observerAttached = true;

    console.log(
      `MutationObserver attached to ${LOG_SELECTOR} on ${page.url()}. ` +
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
          const observer = window.__impracticalBotWakerObserver;
          if (observer) {
            observer.disconnect();
            delete window.__impracticalBotWakerObserver;
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
  console.error(`Messenger waker diagnostic failed: ${error.message}`);
  process.exitCode = 1;
});
