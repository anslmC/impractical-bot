import type { PauseGate } from './pause-gate.js';

const DEBUG_RELIABILITY_WARNING =
  'Packet processing failed. IMPRACTICAL_BOT_DEBUG=1 bypasses key validation; ' +
  'rerun without debug mode to verify real reliability.';

export interface ProcessablePacket<Message = unknown> {
  packetId?: string;
  contextMessages?: Message[];
  newMessages?: Message[];
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
  generateReply: (apiKey: ApiKey, messages: Message[]) => Reply | Promise<Reply>;
  composeReply: (
    page: PageType,
    reply: Awaited<Reply>,
    options?: ComposeReplyOptions,
  ) => Composition | Promise<Composition>;
  pauseGate?: PauseGate;
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
    console.log(`[packet ${packetId}] stage=start messages=${(packet.contextMessages?.length ?? 0) + (packet.newMessages?.length ?? 0)}`);
    try {
      const messages = [
        ...(packet.contextMessages ?? []),
        ...(packet.newMessages ?? []),
      ];
      console.log(`[packet ${packetId}] stage=reply-generation-start`);
      const reply = await generateReply(apiKey, messages);
      console.log(
        `[packet ${packetId}] stage=reply-generation-complete ` +
        `chars=${typeof reply === 'string' ? reply.length : 'unknown'}`,
      );
      stage = 'composition';
      await waitForPacketWork(pauseGate);
      console.log(`[packet ${packetId}] stage=composition-start`);
      const composition = await composeReply(
        page,
        reply,
        pauseGate
          ? { beforeSend: () => waitForPacketWork(pauseGate) }
          : undefined,
      );
      console.log(
        `[packet ${packetId}] stage=composition-returned ` +
        `status=${String(composition?.status ?? 'unknown')}`,
      );
      if (composition?.status !== 'sent') {
        const reason = composition?.reason ?? composition?.status ?? 'unknown';
        throw new Error(`Composer send blocked: ${reason}.`);
      }
      console.log(`[packet ${packetId}] stage=complete status=sent delivery=unconfirmed`);
      return composition;
    } catch (error) {
      const details = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
      const safeDetails = typeof apiKey === 'string' && apiKey
        ? details.replaceAll(apiKey, '[REDACTED]')
        : details;
      logError(
        `[packet ${packetId}] stage=${stage}-failed ` +
        `error=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      logError(`[packet ${packetId}] Processing failed: ${safeDetails}`);
      if (debugMode) {
        logWarning(DEBUG_RELIABILITY_WARNING);
      }
      throw error;
    }
  };
}

export { DEBUG_RELIABILITY_WARNING };