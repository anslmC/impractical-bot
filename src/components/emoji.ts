export const EMOJI_RETRY_INSTRUCTION =
  'The previous proposed reply was rejected because it contained an emoji or pictographic symbol. Write a fresh reply with no emojis, emoticons, pictographs, flags, or decorative symbols. Keep the meaning, tone, and personality in plain text, and return only the reply text.';

const EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{20E3}]/u;

export function containsEmoji(reply: string): boolean {
  return typeof reply === 'string' && EMOJI_PATTERN.test(reply.normalize('NFC'));
}