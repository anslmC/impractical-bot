import type { ConsoleMessage, Page } from 'playwright';
import {
  generateNvidiaReply,
} from '../ai/nvidia.js';
import { navigatePageToMessengerDestination } from '../browser/launch.js';
import type { BackreadMessage } from './backread.js';
import {
  composeMessengerReply,
  type ReplyCompositionResult,
} from './composer.js';
import type { Configuration } from '../config/configuration.js';
import {
  getBotTemperamentYesProbability,
  resolveBotTemperament,
  resolveBotPersonalityMode,
  type BotTemperament,
} from '../config/configuration.js';
import type { ContextMessage, ContextStore } from './context-store.js';
import {
  extractMessageDetails,
  type MessageDetails,
} from './message-extraction.js';
import {
  buildPacketTurn,
  createPacketBuilderState,
  type PacketBuilderMessage,
  type PacketBuilderPacket,
  type PacketBuilderState,
} from './mention-packet-builder.js';
import { createPacketProcessor } from './packet-processor.js';
import { createPacketScheduler } from './packet-scheduler.js';
import { createPauseGate } from './pause-gate.js';
import { getPersonalityInstruction } from './personality.js';
import { buildRngPacket, type RngPacket } from './rng-packet-builder.js';
import { formatPollSummary, formatTerminalText } from './terminal-formatting.js';

const MESSAGE_SELECTOR =
  '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]';
const LOG_SELECTOR = '[role="log"][aria-live="polite"]';
const WAKER_MESSAGE_SELECTOR = '[data-message-id]';
const MESSAGE_LIMIT = 8;
const CONTEXT_STORE_CAPACITY = 60;
const POLL_INTERVAL_MS = 3000;
const RNG_POLL_INTERVAL_MS = 15000;
const RNG_CONTEXT_MESSAGE_LIMIT = 10;
const RNG_COOLDOWN_MS = 35000;
const IDLE_THRESHOLD_MS = 120000;
const LOG_PREFIX = '__MESSENGER_WAKER__:';
const DEBUG_ENGINE = true;

const styled = formatTerminalText;

function styledLabel(text: string): string {
  return styled(text.padEnd(20), 'dim');
}

function formatSubsystemStatus(label: string, message: string): string {
  return `  ${styled(`[${label}]`.padStart(8), 'cyan')} ${message}`;
}

function debugBorder(): string {
  return styled('='.repeat(80), 'dim');
}

type EngineMessage = MessageDetails & { mention?: boolean };
type ScheduledPacket = (PacketBuilderPacket | RngPacket) & {
  mentionMessages?: PacketBuilderMessage[];
};
type PacketScheduler = ReturnType<typeof createPacketScheduler<ScheduledPacket>>;
type ContextStoreState = ReturnType<ContextStore['getState']>;
type MessageText = Pick<ContextMessage, 'messageId' | 'message' | 'mention'>;

export function shouldRngRespond(
  temperament: BotTemperament,
  randomValue: number = Math.random(),
): boolean {
  return randomValue < getBotTemperamentYesProbability(temperament);
}

export interface CombustionOptions {
  page: Page;
  contextStore: ContextStore;
  configuration: Configuration;
  aliases: readonly string[];
  apiKey: string;
  debugMode?: boolean;
  navigateDestination?: (destination: string) => Promise<void>;
}

export type DestinationChangeResult =
  | { status: 'changed'; resumed: boolean }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: string };

export interface DestinationChangeOptions {
  resume: boolean;
  persist?: (destination: string) => void | Promise<void>;
}

export interface CombustionController {
  stopped: Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setTemperament(temperament: BotTemperament): void;
  setPersonality(instruction: string): void;
  changeDestination(
    destination: string,
    options: DestinationChangeOptions,
  ): Promise<DestinationChangeResult>;
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWakeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function containsMention(message: string, aliases: readonly string[]): boolean {
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

function formatPacketMessages(messages: PacketBuilderMessage[]): string {
  if (messages.length === 0) {
    return `  ${styled('(none)', 'dim')}`;
  }
  return messages.map(message => {
    const mentionValue = String(message.mention);
    return `  ${styled('-', 'dim')} ${styled(`id=${message.messageId}`, 'dim')}; ` +
      `${styled('mention=', 'dim')}` +
      `${message.mention ? styled(mentionValue, 'yellow') : mentionValue}; ` +
      `${styled('text=', 'dim')}` +
      `${JSON.stringify(message.message.replace(/\s+/g, ' ') || '(no text content)')}`;
  }).join('\n');
}

function formatMessages(messages: MessageText[]): string {
  if (messages.length === 0) {
    return `  ${styled('(none)', 'dim')}`;
  }
  return messages.map(message =>
    `  ${styled('-', 'dim')} ${styled(`id=${message.messageId}`, 'dim')}; ` +
    `${styled('text=', 'dim')}` +
    `${JSON.stringify(message.message.replace(/\s+/g, ' ') || '(no text content)')}`
  ).join('\n');
}

function displayContextStore({
  appendedMessages,
  evictedMessages = [],
  maxMessages,
  retainedMessages,
  state,
}: {
  appendedMessages: MessageText[];
  evictedMessages?: MessageText[];
  maxMessages: number;
  retainedMessages: MessageText[] | null;
  state: ContextStoreState | null;
}): void {
  if (appendedMessages.length === 0) {
    return;
  }

  const deferred = state === null || retainedMessages === null;
  const border = debugBorder();
  console.log(
    `\n${border}\n${styled('CONTEXT STORE UPDATE', 'bold')}\n${border}\n` +
    `${styledLabel('Newly appended:')}` +
    `${styled(String(appendedMessages.length), 'green')}\n` +
    `${styledLabel('Currently retained:')}` +
    `${deferred ? styled('(deferred)', 'yellow') : state.size}\n` +
    `${styledLabel('Maximum capacity:')}${maxMessages}\n` +
    `${styled('New messages:', 'cyan')}\n${formatMessages(appendedMessages)}\n` +
    (deferred
      ? `${styled(
          'Eviction details and aggregate contents skipped; ' +
            'packet work prevents safe reads.',
          'yellow',
        )}\n`
      : `${styledLabel(`Evicted this update (${evictedMessages.length}):`)}\n` +
        `${formatMessages(evictedMessages)}\n` +
        `${styled('Full retained store, in observation order:', 'cyan')}\n` +
        `${formatMessages(retainedMessages)}\n`) +
    border
  );
}

function canReadContextStore(
  packetScheduler: PacketScheduler | undefined,
  packetBuilderState: PacketBuilderState | undefined,
  packetAwaitingSubmission: boolean,
): boolean {
  if (!packetScheduler || !packetBuilderState) {
    return false;
  }
  const schedulerState = packetScheduler.getState();
  return !packetAwaitingSubmission &&
    !schedulerState.activePacket &&
    schedulerState.pendingPackets.length === 0 &&
    !packetBuilderState.pendingPacket;
}

function getRngSkipReason({
  mainPollInProgress,
  packetScheduler,
  packetBuilderState,
  rngOperationActive,
  rngCooldownActive,
}: {
  mainPollInProgress: boolean;
  packetScheduler: PacketScheduler;
  packetBuilderState: PacketBuilderState;
  rngOperationActive: boolean;
  rngCooldownActive: boolean;
}): string | null {
  if (mainPollInProgress) {
    return 'main poll in progress';
  }
  if (packetBuilderState.pendingPacket) {
    return 'mention packet open or awaiting submission';
  }
  const { activePacket, pendingPackets } = packetScheduler.getState();
  if ((activePacket?.mentionMessages?.length ?? 0) > 0) {
    return 'mention packet active';
  }
  if (pendingPackets.some(packet => (packet.mentionMessages?.length ?? 0) > 0)) {
    return 'mention packet queued';
  }
  if (rngOperationActive) {
    return 'RNG operation already active';
  }
  if (rngCooldownActive) {
    return 'RNG cooldown active';
  }
  return null;
}

function readContextStore(
  contextStore: ContextStore,
  packetScheduler: PacketScheduler | undefined,
  packetBuilderState: PacketBuilderState | undefined,
  packetAwaitingSubmission: boolean,
  method: 'getRecent',
  limit: number,
): ContextMessage[] | null;
function readContextStore(
  contextStore: ContextStore,
  packetScheduler: PacketScheduler | undefined,
  packetBuilderState: PacketBuilderState | undefined,
  packetAwaitingSubmission: boolean,
  method: 'getState',
): ContextStoreState | null;
function readContextStore(
  contextStore: ContextStore,
  packetScheduler: PacketScheduler | undefined,
  packetBuilderState: PacketBuilderState | undefined,
  packetAwaitingSubmission: boolean,
  method: 'getRecent' | 'getState',
  ...args: number[]
): ContextMessage[] | ContextStoreState | null {
  if (!canReadContextStore(packetScheduler, packetBuilderState, packetAwaitingSubmission)) {
    return null;
  }
  return method === 'getRecent'
    ? contextStore.getRecent(args[0])
    : contextStore.getState();
}

function appendContextMessages(
  contextStore: ContextStore,
  incomingMessages: EngineMessage[],
  packetScheduler: PacketScheduler | undefined,
  packetBuilderState: PacketBuilderState | undefined,
  packetAwaitingSubmission = false,
): void {
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
  contextStore.add(validMessages.map(message => ({
    ...message,
    messageId: message.messageId,
  })));
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
  const seenNewIds = new Set<string>();
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

function printPacketBoundary(label: string, packetId: string): void {
  const border = debugBorder();
  const labelStyle = label === 'PACKET FINALIZED' ? 'green' : 'cyan';
  console.log(
    `\n${border}\n${styled(`${label}:`, labelStyle)} ${styled(packetId, 'bold')}\n${border}`,
  );
}

function describePacketClosureReason(newMessageCount: number): string {
  if (newMessageCount === 0) {
    return 'Next poll completed (no new messages)';
  }
  return 'Poll included new work before packet finalization';
}

function logPacket(label: string, packet: PacketBuilderPacket): void {
  console.log(
    `${styled(`${label}:`, 'cyan')} ${styled(packet.packetId, 'bold')}\n` +
    ` ${styled(`New work (${packet.newMessages.length}):`, 'dim')}\n` +
    `${formatPacketMessages(packet.newMessages)}\n` +
    ` ${styled(`Mention messages (${packet.mentionMessages.length}):`, 'dim')}\n` +
    `${formatPacketMessages(packet.mentionMessages)}\n` +
    ` ${styled(`Context only (${packet.contextMessages.length}):`, 'dim')}\n` +
    `${formatPacketMessages(packet.contextMessages)}`
  );
}

function printQueueSnapshot(scheduler: PacketScheduler): void {
  const { activePacket, pendingPackets } = scheduler.getState();
  const packetIds = [
    ...(activePacket ? [activePacket.packetId] : []),
    ...pendingPackets.map(packet => packet.packetId),
  ];
  const border = debugBorder();
  console.log(
    `\n${border}\n${styled('IN QUEUE', 'bold')}\n${border}\n` +
    `${styled('[queue] active packet (held):', 'dim')} ` +
    `${activePacket ? styled(activePacket.packetId, 'bold') : '(none)'}\n` +
    `${styled('[queue] packets waiting:', 'dim')} ${pendingPackets.length}\n` +
    `${styled('[queue] waiting packet IDs (FIFO):', 'dim')} ` +
    `${pendingPackets.map(packet => packet.packetId).join(' -> ') || '(none)'}\n` +
    `${styled('[queue] packets retained:', 'dim')} ${packetIds.length}\n` +
    `${styled('[queue] packet IDs (active, then waiting):', 'dim')} ` +
    `${packetIds.join(' -> ') || '(none)'}\n` +
    border
  );
}

export async function startCombustion({
  page,
  contextStore,
  configuration,
  aliases,
  apiKey,
  debugMode = false,
  navigateDestination,
}: CombustionOptions): Promise<CombustionController> {
  const pauseGate = createPauseGate();
  const navigateToDestination = navigateDestination ?? ((destination: string) =>
    navigatePageToMessengerDestination(page, configuration, destination));
  let observerAttached = false;
  let stopRequested = false;
  let destinationChangeInProgress = false;
  let pendingDestination: string | null = null;
  let destinationEpoch = 0;
  const packetEpochs = new WeakMap<object, number>();
  let mode: 'polling' | 'idle' = 'polling';
  let wakerActive = false;
  let mainPollInProgress = false;
  const mainPollIdleWaiters: (() => void)[] = [];
  let rngOperationActive = false;
  let rngCooldownActive = false;
  let botTemperament = resolveBotTemperament(configuration);
  let rngPacketInFlightId: string | null = null;
  let rngPacketEpoch: number | null = null;
  let lastRngSkipReason: string | null = null;
  let rngPollTimer: ReturnType<typeof setInterval> | undefined;
  let rngCooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let pollDelayResolve: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDeadline = 0;
  let wakePending = false;
  let wakeSignal = createWakeSignal();
  let packetScheduler: PacketScheduler | undefined;
  let packetBuilderState: PacketBuilderState | undefined;
  let pollRng: (() => void) | undefined;
  let listenerAttached = false;

  const stopRngPolling = (message?: string): void => {
    if (rngPollTimer === undefined) {
      return;
    }
    clearInterval(rngPollTimer);
    rngPollTimer = undefined;
    if (message) {
      console.log(formatSubsystemStatus('rng', message.replace(/^\[rng\]\s*/, '')));
    }
  };
  const startRngPolling = (
    message = '[rng] Polling resumed: main poller active',
    leadingNewline = false,
  ): void => {
    if (rngPollTimer !== undefined || !pollRng || stopRequested || pauseGate.isPaused()) {
      return;
    }
    rngPollTimer = setInterval(pollRng, RNG_POLL_INTERVAL_MS);
    const details = message.replace(/^\[rng\]\s*/, '');
    console.log(`${leadingNewline ? '\n' : ''}${formatSubsystemStatus('rng', details)}`);
  };
  const completeRngPacket = (packetId: string, succeeded: boolean, error?: unknown): void => {
    if (packetId !== rngPacketInFlightId) {
      return;
    }
    const completedEpoch = rngPacketEpoch;
    rngPacketInFlightId = null;
    rngPacketEpoch = null;
    rngOperationActive = false;
    const outcome = succeeded
      ? 'success'
      : `failure: ${error instanceof Error ? error.message : String(error)}`;
    console.log(formatSubsystemStatus(
      'rng',
      `Processing completed: ${styled(packetId, 'bold')} ` +
      `(${styled(outcome, succeeded ? 'green' : 'red')})`,
    ));
    if (stopRequested || completedEpoch !== destinationEpoch) {
      return;
    }
    rngCooldownActive = true;
    console.log(formatSubsystemStatus(
      'rng',
      `Cooldown started: ${styled(`${RNG_COOLDOWN_MS / 1000}s`, 'bold')}`,
    ));
    rngCooldownTimer = setTimeout(() => {
      rngCooldownTimer = undefined;
      rngCooldownActive = false;
      console.log(formatSubsystemStatus('rng', 'Cooldown ended'));
    }, RNG_COOLDOWN_MS);
  };
  const requestStop = (): void => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    pauseGate.cancel();
    clearTimeout(idleTimer);
    pollDelayResolve?.();
    wakeSignal.resolve();
  };
  let wakerTransition: Promise<void> = Promise.resolve();
  const setWakerActive = (active: boolean): Promise<void> => {
    wakerTransition = wakerTransition.then(async () => {
      if (!observerAttached || stopRequested || wakerActive === active) {
        return;
      }
      try {
        await page.evaluate((isActive: boolean) => {
          const pageWindow = window as Window & {
            __impracticalBotWakerObserver?: MutationObserver & { active: boolean };
          };
          const observer = pageWindow.__impracticalBotWakerObserver;
          if (observer) {
            observer.active = isActive;
          }
        }, active);
        wakerActive = active;
        console.log(active
          ? '[waker] Active; listening for potential message activity.'
          : '[waker] Standby; poller is responsible for checking messages.');
      } catch (error) {
        if (!stopRequested) {
          console.error(`[waker] Could not update observer state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    return wakerTransition;
  };
  const enterIdle = async (): Promise<void> => {
    if (stopRequested || pauseGate.isPaused() || mode === 'idle') {
      return;
    }
    mode = 'idle';
    stopRngPolling('[rng] Polling paused: main poller idle');
    console.log(formatSubsystemStatus(
      'poller',
      styled('Idle; no genuinely new message was detected before the threshold.', 'dim'),
    ));
    await setWakerActive(true);
    pollDelayResolve?.();
  };
  const resetIdleTimer = async (): Promise<void> => {
    if (stopRequested || pauseGate.isPaused()) {
      return;
    }
    if (mode === 'idle') {
      mode = 'polling';
      console.log(formatSubsystemStatus(
        'poller',
        styled('Confirmed new message while idle; resuming periodic polling.', 'green'),
      ));
      await setWakerActive(false);
    }
    clearTimeout(idleTimer);
    idleDeadline = Date.now() + IDLE_THRESHOLD_MS;
    if (DEBUG_ENGINE) {
      console.log(formatSubsystemStatus(
        'idle',
        `Timer reset (${styled(`${IDLE_THRESHOLD_MS / 1000}s`, 'bold')}).`,
      ));
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void enterIdle();
    }, IDLE_THRESHOLD_MS);
  };
  const signalPollerWake = (): void => {
    if (stopRequested || pauseGate.isPaused() || mode !== 'idle') {
      return;
    }
    mode = 'polling';
    startRngPolling();
    wakePending = true;
    console.log(formatSubsystemStatus(
      'poller',
      styled('Wake-up signal received; verifying rendered messages now.', 'cyan'),
    ));
    void setWakerActive(false);
    wakeSignal.resolve();
  };
  const isIdle = (): boolean => mode === 'idle';
  const consumeWakeSignal = (): boolean => {
    if (!wakePending) {
      return false;
    }
    wakePending = false;
    wakeSignal = createWakeSignal();
    return true;
  };
  const waitForPollInterval = (): Promise<void> => new Promise(resolve => {
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
  const notifyMainPollIdle = (): void => {
    while (mainPollIdleWaiters.length > 0) {
      mainPollIdleWaiters.shift()!();
    }
  };
  const waitForMainPollIdle = (): Promise<void> => {
    if (!mainPollInProgress) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => mainPollIdleWaiters.push(resolve));
  };
  const pauseEngine = async (): Promise<void> => {
    if (stopRequested || pauseGate.isPaused()) {
      return;
    }
    pauseGate.pause();
    stopRngPolling('[rng] Polling paused: engine paused');
    clearTimeout(idleTimer);
    idleTimer = undefined;
    pollDelayResolve?.();
    console.log('[engine] Pausing Combustion; waiting for the current poll to finish.');
    await waitForMainPollIdle();
    if (stopRequested) {
      return;
    }
    console.log('[engine] Combustion paused.');
  };
  const resumeEngine = async (): Promise<void> => {
    if (stopRequested || !pauseGate.isPaused()) {
      return;
    }
    pauseGate.resume();
    if (mode === 'idle') {
      mode = 'polling';
      wakePending = true;
      console.log(formatSubsystemStatus(
        'poller',
        styled('Resuming after pause; verifying rendered messages now.', 'cyan'),
      ));
      await setWakerActive(false);
      wakeSignal.resolve();
    }
    startRngPolling('[rng] Polling resumed: engine resumed');
    await resetIdleTimer();
    console.log('[engine] Combustion resumed.');
  };

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      stopRngPolling();
      clearTimeout(rngCooldownTimer);
      clearTimeout(idleTimer);
      if (packetScheduler) {
        await packetScheduler.waitForIdle();
      }
      await wakerTransition;
      if (listenerAttached) {
        page.off('console', onConsole);
        listenerAttached = false;
      }
      if (observerAttached) {
        try {
          await page.evaluate(() => {
            const pageWindow = window as Window & {
              __impracticalBotWakerObserver?: MutationObserver & { active: boolean };
            };
            const observer = pageWindow.__impracticalBotWakerObserver;
            if (observer) {
              observer.disconnect();
              delete pageWindow.__impracticalBotWakerObserver;
            }
          });
        } catch {
          // The page may have closed before observer cleanup.
        }
        observerAttached = false;
      }
      console.log('[engine] Combustion stopped.');
    })();
    return cleanupPromise;
  };

  const onConsole = (message: ConsoleMessage): void => {
    const text = message.text();
    if (!text.startsWith(LOG_PREFIX) || mode !== 'idle') {
      return;
    }
    const diagnostic = text.slice(LOG_PREFIX.length);
    console.log(DEBUG_ENGINE
      ? `[waker] Potential DOM activity; ${diagnostic}`
      : '[waker] Potential DOM activity detected.');
    signalPollerWake();
  };

  const runPollLoop = async (): Promise<void> => {
    await resetIdleTimer();
    while (!stopRequested) {
      if (pauseGate.isPaused()) {
        const result = await pauseGate.waitUntilResumed();
        if (stopRequested || result === 'cancelled') {
          break;
        }
        continue;
      }
      if (mode === 'idle' && !wakePending) {
        await wakeSignal.promise;
      }
      if (stopRequested) {
        break;
      }
      if (pauseGate.isPaused()) {
        continue;
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
        if (pauseGate.isPaused()) {
          continue;
        }
        if (isIdle()) {
          continue;
        }
        wokePoller = consumeWakeSignal();
      }
      if (pauseGate.isPaused() || mode !== 'polling') {
        continue;
      }

      mainPollInProgress = true;
      try {
        const messages = await readLatestMessages();
        if (stopRequested) {
          break;
        }

        const newMessages: MessageDetails[] = [];
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
        console.log(formatPollSummary(newMessages.length, mentionCount));
        for (const message of newMessagesWithMentions) {
          console.log(
            `  ${styled('New message:', 'green')} id=${message.messageId}; ` +
            `${styled('mention=', 'dim')}${message.mention
              ? styled(String(message.mention), 'yellow')
              : styled(String(message.mention), 'dim')}; ` +
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
        const hadPendingPacket = packetBuilderState!.pendingPacket !== null;
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
          console.log(
            `${styled('Packet opened this poll:', 'cyan')} ` +
            `${styled(result.pendingPacket.packetId, 'bold')}`,
          );
          logPacket('Initial packet contents', result.pendingPacket);
        } else if (result.pendingPacket) {
          console.log(
            `${styled(`Packet ${result.pendingPacket.packetId}`, 'cyan')} ` +
            styled('is pending (still pending).', 'dim'),
          );
        }
        if (result.packet) {
          printPacketBoundary('PACKET FINALIZED', result.packet.packetId);
          console.log(
            `${styled('Closure reason:', 'dim')} ` +
            `${styled(describePacketClosureReason(newMessagesWithMentions.length), 'dim')}`,
          );
          logPacket('Final packet contents', result.packet);
          if (packetScheduler!.submit(result.packet)) {
            printQueueSnapshot(packetScheduler!);
          }
        }

        if (newMessagesWithMentions.length > 0) {
          consumeWakeSignal();
          await resetIdleTimer();
        } else if (idleDeadline <= Date.now() && !wakePending) {
          await enterIdle();
        }
      } finally {
        mainPollInProgress = false;
        notifyMainPollIdle();
      }
    }
  };

  const messageLocator = page.locator(MESSAGE_SELECTOR);
  const readLatestMessages = async (): Promise<MessageDetails[]> => {
    const elements = await messageLocator.evaluateAll((items, limit) =>
      items.slice(-limit).map(element => {
        const message = element as HTMLElement;
        const clone = message.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('h4').forEach(heading => heading.remove());
        return {
          messageId: message.getAttribute('data-message-id') ?? '',
          ariaLabel: message.getAttribute('aria-label'),
          textWithoutSenderHeading: (clone.innerText || '').trim(),
        };
      }),
    MESSAGE_LIMIT,
    );
    return elements.map(extractMessageDetails);
  };
  let seenMessageIds = new Set<string>();

  const resetConversationState = async (baseline: MessageDetails[]): Promise<void> => {
    destinationEpoch += 1;
    packetScheduler?.discardPending();
    const nextPacketNumber = packetBuilderState?.nextPacketNumber ?? 1;
    packetBuilderState = createPacketBuilderState();
    packetBuilderState.nextPacketNumber = nextPacketNumber;
    contextStore.clear();
    seenMessageIds = new Set(baseline.map(message => message.messageId).filter(Boolean));
    appendContextMessages(contextStore, baseline, packetScheduler, packetBuilderState);
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

    rngOperationActive = false;
    rngPacketInFlightId = null;
    rngPacketEpoch = null;
    lastRngSkipReason = null;
    rngCooldownActive = false;
    clearTimeout(rngCooldownTimer);
    rngCooldownTimer = undefined;
  };

  const returnToPreviousDestination = async (
    previousDestination: string | undefined,
  ): Promise<void> => {
    if (!previousDestination) {
      return;
    }
    try {
      await navigateToDestination(previousDestination);
      console.log('[engine] Returned to the previous message destination.');
    } catch (error) {
      console.error(
        '[engine] Could not return to the previous message destination: ' +
        `${describeError(error)}`,
      );
    }
  };

  const changeDestination = async (
    destination: string,
    { resume, persist }: DestinationChangeOptions,
  ): Promise<DestinationChangeResult> => {
    if (destinationChangeInProgress || pendingDestination !== null) {
      return { status: 'rejected', reason: 'A destination change is already in progress.' };
    }
    if (stopRequested) {
      return { status: 'failed', reason: 'The engine is stopping.' };
    }

    const previousDestination = configuration.messageDestination;
    destinationChangeInProgress = true;
    pendingDestination = destination;
    try {
      await pauseEngine();
      if (stopRequested) {
        return { status: 'failed', reason: 'The engine stopped during the destination change.' };
      }

      let baseline: MessageDetails[];
      try {
        await navigateToDestination(destination);
        if (stopRequested) {
          return {
            status: 'failed',
            reason: 'The engine stopped during destination navigation.',
          };
        }
        baseline = await readLatestMessages();
      } catch (error) {
        const reason = describeError(error);
        console.error(`[engine] Destination change rejected: ${reason}`);
        await returnToPreviousDestination(previousDestination);
        return {
          status: 'rejected',
          reason: `The proposed destination is not a valid or accessible group conversation. ${reason}`,
        };
      }

      try {
        await persist?.(destination);
        configuration.messageDestination = destination;
      } catch (error) {
        const reason = describeError(error);
        await returnToPreviousDestination(previousDestination);
        return {
          status: 'failed',
          reason: `The destination was validated but the configuration could not be saved. ${reason}`,
        };
      }

      pendingDestination = null;
      try {
        await resetConversationState(baseline);
      } catch (error) {
        return {
          status: 'failed',
          reason:
            'The destination was saved but the engine session could not be reset. ' +
            `${describeError(error)}`,
        };
      }

      if (stopRequested) {
        return { status: 'failed', reason: 'The engine stopped during the destination change.' };
      }
      if (resume) {
        await resumeEngine();
      }
      return { status: 'changed', resumed: resume && !pauseGate.isPaused() };
    } finally {
      pendingDestination = null;
      destinationChangeInProgress = false;
    }
  };

  try {
    console.log(
      `\n${styled('[COMBUSTION]', 'cyan')} ` +
      styled(`Starting Combustion for ${configuration.messageDestination}.`, 'bold'),
    );
    let systemInstruction = getPersonalityInstruction(
      resolveBotPersonalityMode(configuration),
      configuration.customPersonalityInstruction,
    );
    const processPacket = createPacketProcessor<
      PacketBuilderMessage,
      string,
      Page,
      string,
      ReplyCompositionResult
    >({
      page,
      apiKey,
      generateReply: (requestApiKey, messages) => generateNvidiaReply(
        requestApiKey,
        messages as unknown as readonly BackreadMessage[],
        { systemInstruction },
      ),
      composeReply: composeMessengerReply,
      pauseGate,
      isCurrent: packet => packetEpochs.get(packet) === destinationEpoch,
      debugMode,
    });
    packetScheduler = createPacketScheduler<ScheduledPacket>(async packet => {
      packetEpochs.set(packet, destinationEpoch);
      if (packet.packetId === rngPacketInFlightId) {
        console.log(formatSubsystemStatus(
          'rng',
          `${styled('Processing started:', 'green')} ${styled(packet.packetId, 'bold')}`,
        ));
      }
      let succeeded = false;
      let processingError: unknown;
      try {
        const result = await processPacket(packet);
        succeeded = true;
        return result;
      } catch (error) {
        processingError = error;
        throw error;
      } finally {
        completeRngPacket(packet.packetId, succeeded, processingError);
      }
    }, { pauseGate });

    page.on('console', onConsole);
    listenerAttached = true;
    await page.locator(LOG_SELECTOR).evaluate((log, options) => {
      const observer = new MutationObserver(mutations => {
        if (!observer.active) {
          return;
        }
        const logs = Array.from(log.ownerDocument.querySelectorAll(options.logSelector));
        for (const mutation of mutations) {
          const addedNodes = [];
          for (const node of mutation.addedNodes) {
            const isElement = node.nodeType === Node.ELEMENT_NODE;
            const nodeMatchesMessage = isElement && (node as Element).matches(options.messageSelector);
            const messageElements: Element[] = [];
            if (nodeMatchesMessage) {
              messageElements.push(node as Element);
            }
            if (isElement) {
              messageElements.push(...(node as Element).querySelectorAll(options.messageSelector));
            }
            const messageElementsInLogs = messageElements.filter(message =>
              logs.some(candidate => candidate.contains(message))
            );
            if (messageElementsInLogs.length === 0) {
              continue;
            }
            addedNodes.push({
              tagName: isElement ? (node as Element).tagName.toLowerCase() : node.nodeName.toLowerCase(),
              role: isElement ? (node as Element).getAttribute('role') : null,
              nodeMatchesMessage: Boolean(nodeMatchesMessage),
              subtreeContainsMessageElements: messageElementsInLogs.length > 0,
              messages: messageElementsInLogs.map(message => ({
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
      }) as MutationObserver & { active: boolean };
      observer.active = false;
      observer.observe(log.ownerDocument.body, { childList: true, subtree: true });
      (window as Window & {
        __impracticalBotWakerObserver?: MutationObserver & { active: boolean };
      }).__impracticalBotWakerObserver = observer;
    }, {
      messageSelector: WAKER_MESSAGE_SELECTOR,
      logSelector: LOG_SELECTOR,
      logPrefix: LOG_PREFIX,
      debug: DEBUG_ENGINE,
    });
    observerAttached = true;

    const baseline = await readLatestMessages();
    seenMessageIds = new Set(baseline.map(message => message.messageId).filter(Boolean));
    console.log(
      `${styled('Baseline recorded:', 'cyan')} ` +
      `${styled(String(seenMessageIds.size), 'bold')} unique message IDs.`,
    );
    packetBuilderState = createPacketBuilderState();
    appendContextMessages(contextStore, baseline, packetScheduler, packetBuilderState);
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

    pollRng = () => {
      console.log(formatSubsystemStatus('rng', styled('Evaluating cycle', 'dim')));
      const skipReason = getRngSkipReason({
        mainPollInProgress,
        packetScheduler: packetScheduler!,
        packetBuilderState: packetBuilderState!,
        rngOperationActive,
        rngCooldownActive,
      });
      if (skipReason) {
        if (skipReason !== lastRngSkipReason) {
          console.log(formatSubsystemStatus(
            'rng',
            `${styled('Skipped:', 'yellow')} ${skipReason}`,
          ));
        }
        lastRngSkipReason = skipReason;
        return;
      }
      lastRngSkipReason = null;
      const latestMessage = contextStore.getRecent(1)[0];
      if (latestMessage?.sender === 'You' && latestMessage.direction === 'OUTGOING') {
        console.log(formatSubsystemStatus(
          'rng',
          `${styled('Skipping dice roll:', 'yellow')} ` +
          'latest Context Store message is OUTGOING.',
        ));
        return;
      }
      if (!shouldRngRespond(botTemperament)) {
        const noProbability = Math.round(
          (1 - getBotTemperamentYesProbability(botTemperament)) * 100,
        );
        console.log(formatSubsystemStatus(
          'rng',
          `${styled('Roll: NO', 'dim')} (${styled(`${noProbability}%`, 'dim')} chance)`,
        ));
        return;
      }
      const yesProbability = Math.round(getBotTemperamentYesProbability(botTemperament) * 100);
      console.log(formatSubsystemStatus(
        'rng',
        `${styled('Roll: YES', 'green')} (${styled(`${yesProbability}%`, 'bold')} chance)`,
      ));

      rngOperationActive = true;
      try {
        const recentMessages = contextStore.getRecent(RNG_CONTEXT_MESSAGE_LIMIT);
        console.log(formatSubsystemStatus(
          'rng',
          `Context snapshot: ${styled(String(recentMessages.length), 'bold')} messages`,
        ));
        const hasUsableIncomingMessage = recentMessages.some(message =>
          message.direction === 'INCOMING' && message.message.trim().length > 0
        );
        if (!hasUsableIncomingMessage) {
          rngOperationActive = false;
          console.log(formatSubsystemStatus(
            'rng',
            `${styled('Skipped:', 'yellow')} no usable incoming Messenger message`,
          ));
          console.log(formatSubsystemStatus('rng', 'No cooldown; normal polling resumes'));
          return;
        }

        const packet = buildRngPacket(recentMessages);
        rngPacketInFlightId = packet.packetId;
        rngPacketEpoch = destinationEpoch;
        console.log(formatSubsystemStatus(
          'rng',
          `${styled('Packet created:', 'cyan')} ${styled(packet.packetId, 'bold')} ` +
          `(${styled(String(packet.contextMessages.length), 'bold')} context messages)`,
        ));
        if (!packetScheduler!.submit(packet)) {
          rngPacketInFlightId = null;
          rngOperationActive = false;
          console.log(formatSubsystemStatus(
            'rng',
            `${styled('Scheduler rejected packet:', 'yellow')} ${styled(packet.packetId, 'bold')}`,
          ));
          return;
        }
        console.log(formatSubsystemStatus('rng', styled('Submitted to scheduler', 'green')));
      } catch (error) {
        rngPacketInFlightId = null;
        rngOperationActive = false;
        const details = error instanceof Error ? error.message : String(error);
        console.error(formatSubsystemStatus(
          'rng',
          styled(`Could not submit an RNG packet: ${details}`, 'red'),
        ));
      }
    };
    startRngPolling('[rng] Polling started', true);
    console.log(DEBUG_ENGINE
      ? formatSubsystemStatus(
        'poller',
        `Active; sampling every ${styled(String(POLL_INTERVAL_MS), 'bold')} ms.`,
      )
      : formatSubsystemStatus('poller', 'Active.'));

    const stopped = runPollLoop().then(
      async () => {
        await cleanup();
      },
      async error => {
        await cleanup();
        throw error;
      },
    );
    return {
      stopped,
      pause: pauseEngine,
      resume: resumeEngine,
      setTemperament(temperament) {
        botTemperament = temperament;
      },
      setPersonality(instruction) {
        systemInstruction = instruction;
      },
      changeDestination,
      async stop() {
        requestStop();
        await stopped.catch(() => undefined);
      },
    };
  } catch (error) {
    requestStop();
    await cleanup();
    throw error;
  }
}