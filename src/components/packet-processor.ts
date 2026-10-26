const DEBUG_RELIABILITY_WARNING =
  'Packet processing failed. IMPRACTICAL_BOT_DEBUG=1 bypasses key validation; ' +
  'rerun without debug mode to verify real reliability.';

export interface ProcessablePacket<Message = unknown> {
  packetId?: string;
  contextMessages?: Message[];
  newMessages?: Message[];
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
  composeReply: (page: PageType, reply: Awaited<Reply>) => Composition | Promise<Composition>;
  debugMode?: boolean;
  logError?: (message: string) => void;
  logWarning?: (message: string) => void;
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
  debugMode = false,
  logError = message => console.error(message),
  logWarning = message => console.warn(message),
}: PacketProcessorOptions<Message, ApiKey, PageType, Reply, Composition>):
  (packet: ProcessablePacket<Message>) => Promise<Composition> {
  if (typeof generateReply !== 'function' || typeof composeReply !== 'function') {
    throw new TypeError('generateReply and composeReply must be functions.');
  }

  return async packet => {
    try {
      const messages = [
        ...(packet.contextMessages ?? []),
        ...(packet.newMessages ?? []),
      ];
      const reply = await generateReply(apiKey, messages);
      const composition = await composeReply(page, reply);
      if (composition?.status !== 'sent') {
        const reason = composition?.reason ?? composition?.status ?? 'unknown';
        throw new Error(`Composer send blocked: ${reason}.`);
      }
      return composition;
    } catch (error) {
      const details = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
      const safeDetails = typeof apiKey === 'string' && apiKey
        ? details.replaceAll(apiKey, '[REDACTED]')
        : details;
      logError(`[packet ${packet?.packetId ?? 'unknown'}] Processing failed: ${safeDetails}`);
      if (debugMode) {
        logWarning(DEBUG_RELIABILITY_WARNING);
      }
      throw error;
    }
  };
}

export { DEBUG_RELIABILITY_WARNING };