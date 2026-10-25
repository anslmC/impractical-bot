const { chromium } = require('playwright');
const { loadConfiguration } = require('../../dist/src/config/configuration.js');
const {
  generateNvidiaReply,
  loadNvidiaApiKey,
  resolveNvidiaEnvironmentPath,
  validateNvidiaApiKey,
} = require('../../dist/src/ai/nvidia.js');
const { generateAliases } = require('../../dist/src/messages/alias-engine.js');
const { composeMessengerReply } = require('../components/composer');
const {
  buildPacketTurn,
  createPacketBuilderState,
} = require('../components/packet-builder');
const { createContextStore } = require('../components/context-store');
const { createPacketScheduler } = require('../components/packet-scheduler');
const { extractMessageDetails } = require('../components/message-extraction');
const { createPacketProcessor } = require('../components/packet-processor');

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const LOG_SELECTOR = '[role="log"][aria-live="polite"]';
const WAKER_MESSAGE_SELECTOR = '[data-message-id]';
const MESSAGE_LIMIT = 8;
const CONTEXT_STORE_CAPACITY = 60;
const POLL_INTERVAL_MS = 3000;
const IDLE_THRESHOLD_MS = 30000;
const LOG_PREFIX = '__MESSENGER_WAKER__:';
const DEBUG_ENGINE = true;

function loadExperimentConfiguration() {
  const result = loadConfiguration();
  if (result.status === 'missing') {
    throw new Error('Configuration file was not found.');
  }
  if (result.status === 'malformed') {
    throw new Error(`Configuration is malformed: ${result.message}`);
  }
  if (result.status === 'unsupported-version') {
    throw new Error(`Configuration schema version ${result.version} is not supported.`);
  }
  if (result.status === 'pin-required') {
    throw new Error('Configuration requires PIN reconfiguration before it can be used.');
  }

  const puppetName = result.configuration.puppetName;
  if (typeof puppetName !== 'string' || !puppetName.trim()) {
    throw new Error('The configured puppetName is missing or empty.');
  }
  const cdpPort = result.configuration.cdpPort;
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw new Error('The configured CDP port is missing or invalid.');
  }
  return { puppetName, cdpPort };
}

function createWakeSignal() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function containsMention(message, aliases) {
  for (const alias of aliases) {
    const escapedAlias = alias.trim().split(/\s+/)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    if (message.match(new RegExp(escapedAlias, 'iu'))) {
      return true;
    }
  }
  return false;
}

function formatPacketMessages(messages) {
  if (messages.length === 0) {
    return '  (none)';
  }
  return messages.map(message =>
    `  - id=${message.messageId}; mention=${message.mention}; ` +
    `text=${JSON.stringify(message.message.replace(/\s+/g, ' ') || '(no text content)')}`
  ).join('\n');
}

function formatMessages(messages) {
  if (messages.length === 0) {
    return '  (none)';
  }
  return messages.map(message =>
    `  - id=${message.messageId}; ` +
    `text=${JSON.stringify(message.message.replace(/\s+/g, ' ') || '(no text content)')}`
  ).join('\n');
}

function displayContextStore({
  appendedMessages,
  evictedMessages = [],
  maxMessages,
  retainedMessages,
  state,
}) {
  if (appendedMessages.length === 0) {
    return;
  }

  const deferred = state === null || retainedMessages === null;
  const border = '='.repeat(80);
  console.log(
    `\n${border}\nCONTEXT STORE UPDATE\n${border}\n` +
    `Newly appended: ${appendedMessages.length}\n` +
    `Currently retained: ${deferred ? '(deferred)' : state.size}\n` +
    `Maximum capacity: ${maxMessages}\n` +
    `New messages:\n${formatMessages(appendedMessages)}\n` +
    (deferred
      ? 'Eviction details and aggregate contents skipped; packet work prevents safe reads.\n'
      : `Evicted this update (${evictedMessages.length}):\n` +
        `${formatMessages(evictedMessages)}\n` +
        `Full retained store, in observation order:\n` +
        `${formatMessages(retainedMessages)}\n`) +
    border
  );
}

function canReadContextStore(packetScheduler, packetBuilderState, packetAwaitingSubmission) {
  const schedulerState = packetScheduler.getState();
  return !packetAwaitingSubmission &&
    !schedulerState.activePacket &&
    schedulerState.pendingPackets.length === 0 &&
    !packetBuilderState.pendingPacket;
}

function readContextStore(
  contextStore,
  packetScheduler,
  packetBuilderState,
  packetAwaitingSubmission,
  method,
  ...args
) {
  if (!canReadContextStore(packetScheduler, packetBuilderState, packetAwaitingSubmission)) {
    return null;
  }
  return contextStore[method](...args);
}

function appendContextMessages(
  contextStore,
  incomingMessages,
  packetScheduler,
  packetBuilderState,
  packetAwaitingSubmission = false,
) {
  const validMessages = incomingMessages.filter(message => message.messageId);
  if (validMessages.length === 0) {
    return;
  }

  const previousMessages = readContextStore(
    contextStore,
    packetScheduler,
    packetBuilderState,
    packetAwaitingSubmission,
    'getRecent',
    CONTEXT_STORE_CAPACITY,
  );
  contextStore.add(validMessages);
  if (previousMessages === null) {
    displayContextStore({
      appendedMessages: validMessages,
      maxMessages: CONTEXT_STORE_CAPACITY,
      retainedMessages: null,
      state: null,
    });
    return;
  }

  const previousIds = new Set(previousMessages.map(message => message.messageId));

  const seenNewIds = new Set();
  const newlyAppended = validMessages.filter(message => {
    if (previousIds.has(message.messageId) || seenNewIds.has(message.messageId)) {
      return false;
    }
    seenNewIds.add(message.messageId);
    return true;
  });
  if (newlyAppended.length === 0) {
    return;
  }

  const state = readContextStore(
    contextStore,
    packetScheduler,
    packetBuilderState,
    packetAwaitingSubmission,
    'getState',
  );
  if (state === null) {
    displayContextStore({
      appendedMessages: newlyAppended,
      maxMessages: CONTEXT_STORE_CAPACITY,
      retainedMessages: null,
      state: null,
    });
    return;
  }
  const retainedMessages = readContextStore(
    contextStore,
    packetScheduler,
    packetBuilderState,
    packetAwaitingSubmission,
    'getRecent',
    state.maxMessages,
  );
  if (retainedMessages === null) {
    displayContextStore({
      appendedMessages: newlyAppended,
      maxMessages: state.maxMessages,
      retainedMessages: null,
      state: null,
    });
    return;
  }
  const retainedIds = new Set(retainedMessages.map(message => message.messageId));
  const evictedMessages = [...previousMessages, ...newlyAppended]
    .filter(message => !retainedIds.has(message.messageId));
  displayContextStore({
    appendedMessages: newlyAppended,
    evictedMessages,
    maxMessages: state.maxMessages,
    retainedMessages,
    state,
  });
}

function printPacketBoundary(label, packetId) {
  const border = '='.repeat(80);
  console.log(`\n${border}\n${label}: ${packetId}\n${border}`);
}

function describePacketClosureReason(newMessageCount) {
  if (newMessageCount === 0) {
    return 'Next poll completed (no new messages)';
  }

  return 'Poll included new work before packet finalization';
}

function logPacket(label, packet) {
  console.log(
    `${label}: ${packet.packetId}\n` +
    ` New work (${packet.newMessages.length}):\n${formatPacketMessages(packet.newMessages)}\n` +
    ` Mention messages (${packet.mentionMessages.length}):\n` +
    `${formatPacketMessages(packet.mentionMessages)}\n` +
    ` Context only (${packet.contextMessages.length}):\n` +
    `${formatPacketMessages(packet.contextMessages)}`
  );
}

function printQueueSnapshot(scheduler) {
  const { activePacket, pendingPackets } = scheduler.getState();
  const packetIds = [
    ...(activePacket ? [activePacket.packetId] : []),
    ...pendingPackets.map(packet => packet.packetId),
  ];
  const border = '='.repeat(80);

  console.log(
    `\n${border}\nIN QUEUE\n${border}\n` +
    `[queue] active packet (held): ${activePacket?.packetId ?? '(none)'}\n` +
    `[queue] packets waiting: ${pendingPackets.length}\n` +
    `[queue] waiting packet IDs (FIFO): ` +
    `${pendingPackets.map(packet => packet.packetId).join(' -> ') || '(none)'}\n` +
    `[queue] packets retained: ${packetIds.length}\n` +
    `[queue] packet IDs (active, then waiting): ${packetIds.join(' -> ') || '(none)'}\n` +
    border
  );
}

async function main() {
  let browser;
  let page;
  let observerAttached = false;
  let stopRequested = false;
  let mode = 'polling';
  let wakerActive = false;
  let pollDelayResolve;
  let idleTimer;
  let idleDeadline;
  let wakePending = false;
  let wakeSignal = createWakeSignal();
  const contextStore = createContextStore({ maxMessages: CONTEXT_STORE_CAPACITY });
  let packetScheduler;
  const onInterrupt = () => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    console.log('\nCtrl+C received; stopping the polling loop.');
    clearTimeout(idleTimer);
    pollDelayResolve?.();
    wakeSignal.resolve();
  };
  process.on('SIGINT', onInterrupt);

  const setWakerActive = async active => {
    if (!observerAttached || wakerActive === active) {
      return;
    }
    wakerActive = active;
    console.log(active
      ? '[waker] Active; listening for potential message activity.'
      : '[waker] Standby; poller is responsible for checking messages.');
    try {
      await page.evaluate(isActive => {
        const observer = window.__impracticalBotWakerObserver;
        if (observer) {
          observer.active = isActive;
        }
      }, active);
    } catch (error) {
      if (!stopRequested) {
        console.error(`[waker] Could not update observer state: ${error.message}`);
      }
    }
  };

  const enterIdle = async () => {
    if (stopRequested || mode === 'idle') {
      return;
    }
    mode = 'idle';
    console.log('[poller] Idle; no genuinely new message was detected before the threshold.');
    await setWakerActive(true);
    pollDelayResolve?.();
  };

  const resetIdleTimer = async () => {
    if (mode === 'idle') {
      mode = 'polling';
      console.log('[poller] Confirmed new message while idle; resuming periodic polling.');
      await setWakerActive(false);
    }

    clearTimeout(idleTimer);
    idleDeadline = Date.now() + IDLE_THRESHOLD_MS;
    if (DEBUG_ENGINE) {
      console.log(`[idle] Timer reset (${IDLE_THRESHOLD_MS / 1000}s).`);
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void enterIdle();
    }, IDLE_THRESHOLD_MS);
  };

  const signalPollerWake = () => {
    if (mode !== 'idle') {
      return;
    }
    mode = 'polling';
    wakePending = true;
    console.log('[poller] Wake-up signal received; verifying rendered messages now.');
    void setWakerActive(false);
    wakeSignal.resolve();
  };

  const consumeWakeSignal = () => {
    if (!wakePending) {
      return false;
    }
    wakePending = false;
    wakeSignal = createWakeSignal();
    return true;
  };

  const waitForPollInterval = () => new Promise(resolve => {
    const timeout = setTimeout(() => {
      pollDelayResolve = undefined;
      resolve();
    }, POLL_INTERVAL_MS);
    pollDelayResolve = () => {
      clearTimeout(timeout);
      pollDelayResolve = undefined;
      resolve();
    };
  });

  try {
    console.log('[engine] Starting combined poller and waker.');
    const { puppetName, cdpPort } = loadExperimentConfiguration();
    const debugMode = process.env.IMPRACTICAL_BOT_DEBUG === '1';
    const apiKey = loadNvidiaApiKey(resolveNvidiaEnvironmentPath());
    if (!apiKey) {
      throw new Error('The application NVIDIA API key is missing.');
    }
    if (debugMode) {
      console.log('Debug mode enabled; skipping NVIDIA API key validation.');
    } else {
      await validateNvidiaApiKey(apiKey);
      console.log('NVIDIA API key validated successfully.');
    }
    const { valids: aliases } = generateAliases(puppetName);
    const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch {
      throw new Error(
        `Could not connect to Brave at ${cdpEndpoint}. ` +
        'Ensure Brave is already running with CDP enabled on this address and port.'
      );
    }

    page = findMessagesPage(browser);
    if (!page) {
      throw new Error(
        'No open Facebook Messages tab found in the connected Brave browser. ' +
        'Open Facebook Messages in Brave and run this script again.'
      );
    }
    packetScheduler = createPacketScheduler(createPacketProcessor({
      page,
      apiKey,
      generateReply: generateNvidiaReply,
      composeReply: composeMessengerReply,
      debugMode,
    }));

    page.on('console', message => {
      const text = message.text();
      if (!text.startsWith(LOG_PREFIX) || mode !== 'idle') {
        return;
      }
      const diagnostic = text.slice(LOG_PREFIX.length);
      console.log(DEBUG_ENGINE
        ? `[waker] Potential DOM activity; ${diagnostic}`
        : '[waker] Potential DOM activity detected.');
      signalPollerWake();
    });

    await page.locator(LOG_SELECTOR).evaluate((log, options) => {
      const observer = new MutationObserver(mutations => {
        if (!observer.active) {
          return;
        }
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
              : 'Potential DOM activity detected; waking poller.';
            console.log(`${options.logPrefix}${diagnostic}`);
          }
        }
      });
      observer.active = false;
      observer.observe(log, { childList: true, subtree: true });
      window.__impracticalBotWakerObserver = observer;
    }, {
      messageSelector: WAKER_MESSAGE_SELECTOR,
      logPrefix: LOG_PREFIX,
      debug: DEBUG_ENGINE,
    });
    observerAttached = true;
    console.log(DEBUG_ENGINE
      ? `[waker] Standby; observing ${LOG_SELECTOR} for added message elements.`
      : '[waker] Standby.');

    console.log(`Connected Facebook Messages tab: ${page.url()}`);
    if (stopRequested) {
      return;
    }

    const messageLocator = page.locator(MESSAGE_SELECTOR);
    const readLatestMessages = async () => {
      const elements = await messageLocator.evaluateAll((items, limit) =>
        items.slice(-limit).map(element => ({
          messageId: element.getAttribute('data-message-id'),
          ariaLabel: element.getAttribute('aria-label'),
          textWithoutSenderHeading: (() => {
            const clone = element.cloneNode(true);
            clone.querySelectorAll('h4').forEach(heading => heading.remove());
            return (clone.innerText || '').trim();
          })(),
        })), MESSAGE_LIMIT
      );
      return elements.map(extractMessageDetails);
    };

    const baseline = await readLatestMessages();
    const seenMessageIds = new Set(
      baseline.map(message => message.messageId).filter(Boolean)
    );
    console.log(`Baseline recorded: ${seenMessageIds.size} unique message IDs.`);

    let packetBuilderState = createPacketBuilderState();
    appendContextMessages(
      contextStore,
      baseline,
      packetScheduler,
      packetBuilderState,
    );
    packetBuilderState = buildPacketTurn({
      newMessages: [],
      recentContext: baseline
        .filter(message => message.messageId)
        .map(message => ({
          ...message,
          mention: containsMention(message.message, aliases),
        })),
      state: packetBuilderState,
    }).state;

    console.log(DEBUG_ENGINE
      ? `[poller] Active; sampling every ${POLL_INTERVAL_MS} ms.`
      : '[poller] Active.');
    await resetIdleTimer();

    while (!stopRequested) {
      if (mode === 'idle' && !wakePending) {
        await wakeSignal.promise;
      }
      if (stopRequested) {
        break;
      }

      let wokePoller = consumeWakeSignal();
      if (mode === 'idle') {
        continue;
      }
      if (!wokePoller) {
        await waitForPollInterval();
        if (stopRequested) {
          break;
        }
        if (mode === 'idle') {
          continue;
        }
        wokePoller = consumeWakeSignal();
      }
      if (mode !== 'polling') {
        continue;
      }

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

      const newMessagesWithMentions = newMessages.map(message => ({
        ...message,
        mention: containsMention(message.message, aliases),
      }));
      const mentionCount = newMessagesWithMentions.filter(message => message.mention).length;
      console.log(
        `Poll: ${newMessages.length} new messages checked; ${mentionCount} mention detected.`
      );
      for (const message of newMessagesWithMentions) {
        console.log(
          ` New message: id=${message.messageId}; mention=${message.mention}; ` +
          `text=${JSON.stringify(message.message.replace(/\s+/g, ' ') || '(no text content)')}`
        );
      }

      const newMessageIds = new Set(newMessagesWithMentions.map(message => message.messageId));
      const recentContext = messages
        .filter(message => message.messageId && !newMessageIds.has(message.messageId))
        .map(message => ({
          ...message,
          mention: containsMention(message.message, aliases),
        }));
      const hadPendingPacket = packetBuilderState.pendingPacket !== null;
      const result = buildPacketTurn({
        newMessages: newMessagesWithMentions,
        recentContext,
        state: packetBuilderState,
      });
      packetBuilderState = result.state;
      appendContextMessages(
        contextStore,
        newMessages,
        packetScheduler,
        packetBuilderState,
        result.packet !== null,
      );

      if (result.pendingPacket && !hadPendingPacket) {
        printPacketBoundary('PACKET OPENED', result.pendingPacket.packetId);
        console.log(`Packet opened this poll: ${result.pendingPacket.packetId}`);
        logPacket('Initial packet contents', result.pendingPacket);
      } else if (result.pendingPacket) {
        console.log(
          `Packet ${result.pendingPacket.packetId} is pending` +
          ' (still pending).'
        );
      }
      if (result.packet) {
        printPacketBoundary('PACKET FINALIZED', result.packet.packetId);
        console.log(`Closure reason: ${describePacketClosureReason(newMessagesWithMentions.length)}`);
        logPacket('Final packet contents', result.packet);
        if (packetScheduler.submit(result.packet)) {
          printQueueSnapshot(packetScheduler);
        }
      }

      if (newMessagesWithMentions.length > 0) {
        consumeWakeSignal();
        await resetIdleTimer();
      } else if (idleDeadline <= Date.now() && !wakePending) {
        await enterIdle();
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    clearTimeout(idleTimer);
    if (packetScheduler) {
      await packetScheduler.waitForIdle();
    }
    console.log('[engine] Shutting down.');
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
  console.error(`Messenger mention-poll experiment failed: ${error.message}`);
  process.exitCode = 1;
});