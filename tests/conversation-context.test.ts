import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONVERSATION_METADATA_RETRY_INSTRUCTION,
  extractConversationMessageBody,
  serializeConversationMessage,
} from '../src/components/conversation-context.js';
import { extractMessageDetails } from '../src/components/message-extraction.js';

const header = {
  id: 'outgoing-1',
  timestamp: null,
  sender: 'You',
  participant: 'TestBot',
  direction: 'OUTGOING' as const,
  addressedTo: null,
  isTrigger: false,
};

test('serialized metadata is removed only as a leading transcript envelope', () => {
  const serialized = serializeConversationMessage(header, 'plain reply');

  assert.deepEqual(extractConversationMessageBody(serialized), {
    text: 'plain reply',
    hadEnvelope: true,
  });
  assert.deepEqual(extractConversationMessageBody(`  \n${serialized}`), {
    text: 'plain reply',
    hadEnvelope: true,
  });
  assert.deepEqual(
    extractConversationMessageBody('[MESSAGE not a transcript envelope]\nplain reply'),
    {
      text: '[MESSAGE not a transcript envelope]\nplain reply',
      hadEnvelope: false,
    },
  );
  assert.deepEqual(
    extractConversationMessageBody(`prefix ${serialized}`),
    {
      text: `prefix ${serialized}`,
      hadEnvelope: false,
    },
  );
});

test('rendered metadata envelopes never reach extracted message text', () => {
  const details = extractMessageDetails({
    messageId: 'outgoing-1',
    ariaLabel: null,
    textWithoutSenderHeading: serializeConversationMessage(header, 'plain reply'),
  });

  assert.equal(details.message, 'plain reply');
});

test('the metadata retry instruction preserves the plain-text and no-emoji rule', () => {
  assert.match(CONVERSATION_METADATA_RETRY_INSTRUCTION, /Return only the final message/);
  assert.match(CONVERSATION_METADATA_RETRY_INSTRUCTION, /no message id/);
  assert.match(CONVERSATION_METADATA_RETRY_INSTRUCTION, /Do not use emojis/);
});
