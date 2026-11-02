import type { PauseGate } from './pause-gate.js';
import { formatTerminalText, type TerminalStyle } from './terminal-formatting.js';

const DEBUG_RELIABILITY_WARNING =
  'Packet processing failed. IMPRACTICAL_BOT_DEBUG=1 bypasses key validation; ' +
  'rerun without debug mode to verify real reliability.';

const styled = formatTerminalText;

function packetPrefix(packetId: string): string {
  return `${styled('[packet ', 'cyan')}${styled(packetId, 'bold')}${styled(']', 'cyan')}`;
}

function formatPacketStage(
  packetId: string,
  stage: string,
  details = '',
  style: TerminalStyle = 'dim',
): string {
  return `${packetPrefix(packetId)} ${styled(`stage=${stage}`, style)}` +
    (details ? ` ${details}` : '');
}

export class PacketStaleError extends Error {
  constructor(readonly packetId: string) {
    super(
      `Packet ${packetId} was discarded because newer incoming messages ` +
      'superseded its context.',
    );
    this.name = 'PacketStaleError';
  }
}

export interface ProcessablePacket<Message = unknown> {
  packetId?: string;
  contextMessages?: Message[];
  newMessages?: Message[];
  triggerMessageId?: string;
}

export interface ComposeReplyOptions {
  beforeSend?: () => Promise<void>;
}

export interface PacketProcessorOptions<
  Message,
  ApiKey,
  PageType,
  Reply,
  Composition extends { status?: unknown; reason?: unknown },
> {
  page: PageType;
  apiKey: ApiKey;
  generateReply: (
    apiKey: ApiKey,
    messages: Message[],
    packet: ProcessablePacket<Message>,
  ) => Reply | Promise<Reply>;
  composeReply: (
    page: PageType,
    reply: Awaited<Reply>,
    options?: ComposeReplyOptions,
  ) => Composition | Promise<Composition>;
  pauseGate?: PauseGate;
  isCurrent?: (packet: ProcessablePacket<Message>) => boolean;
  isStale?: (packet: ProcessablePacket<Message>) => boolean;
  debugMode?: boolean;
  logError?: (message: string) => void;
  logWarning?: (message: string) => void;
}

async function waitForPacketWork(pauseGate: PauseGate | undefined): Promise<void> {
  if (!pauseGate) {
    return;
  }
  const result = await pauseGate.waitUntilResumed();
  if (result === 'cancelled') {
    throw new Error('Packet processing cancelled while the engine is stopping.');
  }
}

function assertPacketCurrent<Message>(
  isCurrent: ((packet: ProcessablePacket<Message>) => boolean) | undefined,
  packet: ProcessablePacket<Message>,
): void {
  if (isCurrent && !isCurrent(packet)) {
    throw new Error('Packet processing abandoned because the destination changed.');
  }
}

function assertPacketFresh<Message>(
  isStale: ((packet: ProcessablePacket<Message>) => boolean) | undefined,
  packet: ProcessablePacket<Message>,
): void {
  if (isStale && isStale(packet)) {
    throw new PacketStaleError(packet.packetId ?? 'unknown');
  }
}

export function createPacketProcessor<
  Message = unknown,
  ApiKey = unknown,
  PageType = unknown,
  Reply = unknown,
  Composition extends { status?: unknown; reason?: unknown } = {
    status?: unknown;
    reason?: unknown;
  },
>({
  page,
  apiKey,
  generateReply,
  composeReply,
  pauseGate,
  isCurrent,
  isStale,
  debugMode = false,
  logError = message => console.error(message),
  logWarning = message => console.warn(message),
}: PacketProcessorOptions<Message, ApiKey, PageType, Reply, Composition>):
  (packet: ProcessablePacket<Message>) => Promise<Composition> {
  if (typeof generateReply !== 'function' || typeof composeReply !== 'function') {
    throw new TypeError('generateReply and composeReply must be functions.');
  }

  return async packet => {
    const packetId = packet?.packetId ?? 'unknown';
    let stage = 'reply-generation';
    console.log(`\n${formatPacketStage(
      packetId,
      'start',
      `messages=${(packet.contextMessages?.length ?? 0) + (packet.newMessages?.length ?? 0)}`,
      'bold',
    )}`);
    try {
      const messages = [
        ...(packet.contextMessages ?? []),
        ...(packet.newMessages ?? []),
      ];

      assertPacketCurrent(isCurrent, packet);
      assertPacketFresh(isStale, packet);

      stage = 'reply-generation';
      console.log(formatPacketStage(packetId, 'reply-generation-start'));
      const reply = await generateReply(apiKey, messages, packet);
      console.log(
        formatPacketStage(
          packetId,
          'reply-generation-complete',
          `chars=${styled(String(typeof reply === 'string' ? reply.length : 'unknown'), 'bold')}`,
          'green',
        ),
      );
      stage = 'composition';
      assertPacketCurrent(isCurrent, packet);
      await waitForPacketWork(pauseGate);
      assertPacketCurrent(isCurrent, packet);
      assertPacketFresh(isStale, packet);
      console.log(formatPacketStage(packetId, 'composition-start'));
      const composition = await composeReply(
        page,
        reply,
        pauseGate || isCurrent || isStale
          ? {
            beforeSend: async () => {
              assertPacketFresh(isStale, packet);
              await waitForPacketWork(pauseGate);
              assertPacketCurrent(isCurrent, packet);
            },
          }
          : undefined,
      );
      console.log(
        formatPacketStage(
          packetId,
          'composition-returned',
          `status=${styled(String(composition?.status ?? 'unknown'), composition?.status === 'sent' ? 'green' : 'yellow')}`,
          composition?.status === 'sent' ? 'green' : 'yellow',
        ),
      );
      if (composition?.status !== 'sent') {
        const reason = composition?.reason ?? composition?.status ?? 'unknown';
        throw new Error(`Composer send blocked: ${reason}.`);
      }
      console.log(formatPacketStage(
        packetId,
        'complete',
        `status=${styled('sent', 'green')} delivery=${styled('unconfirmed', 'yellow')}`,
        'green',
      ));
      return composition;
    } catch (error) {
      const details = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
      const safeDetails = typeof apiKey === 'string' && apiKey
        ? details.replaceAll(apiKey, '[REDACTED]')
        : details;
      logError(
        `${packetPrefix(packetId)} ${styled(`stage=${stage}-failed`, 'red')} ` +
        `error=${styled(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 'red')}`,
      );
      logError(`${packetPrefix(packetId)} ${styled('Processing failed:', 'red')} ${styled(safeDetails, 'red')}`);
      if (debugMode) {
        logWarning(styled(DEBUG_RELIABILITY_WARNING, 'yellow'));
      }
      throw error;
    }
  };
}

export { DEBUG_RELIABILITY_WARNING };
