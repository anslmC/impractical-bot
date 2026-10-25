const DEBUG_RELIABILITY_WARNING =
  'Packet processing failed. IMPRACTICAL_BOT_DEBUG=1 bypasses key validation; ' +
  'rerun without debug mode to verify real reliability.';

function createPacketProcessor({
  page,
  apiKey,
  generateReply,
  composeReply,
  debugMode = false,
  logError = message => console.error(message),
  logWarning = message => console.warn(message),
}) {
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

module.exports = { createPacketProcessor, DEBUG_RELIABILITY_WARNING };