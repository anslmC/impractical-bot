import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import {
  classifyMessageLabel,
  readMessengerMessages,
} from '../src/messages/backread.js';

interface TestMessage {
  messageId: string | null;
  ariaLabel: string | null;
  message: string;
  senderHeading?: string;
  messageWithoutSenderHeading?: string;
}

function createMessage(messageId: number): TestMessage {
  return {
    messageId: `message-${messageId}`,
    ariaLabel: `At October 18, 2026, 1:15 PM, Sender: message ${messageId}`,
    message: ` message ${messageId} `,
  };
}

function createPage(batches: TestMessage[][]) {
  let batchIndex = 0;
  const waitDurations: number[] = [];
  const scrollPositions: number[] = [];
  const scrollElement = {
    clientHeight: 1_000,
    scrollHeight: 4_000,
    scrollTop: 0,
  };
  const scrollContainer = {
    evaluate: async (callback: (element: typeof scrollElement) => unknown) => {
      const result = callback(scrollElement);
      scrollPositions.push(scrollElement.scrollTop);
      return result;
    },
  };
  const locator = {
    count: async () => batches[0]?.length ?? 0,
    first: () => ({
      evaluateHandle: async () => ({ asElement: () => scrollContainer }),
    }),
    evaluateAll: async (callback: (elements: Element[]) => unknown) => {
      const batch = batches[Math.min(batchIndex, batches.length - 1)] ?? [];
      batchIndex += 1;
      const elements = batch.map(message => ({
        getAttribute: (name: string) =>
          name === 'data-message-id' ? message.messageId :
            name === 'aria-label' ? message.ariaLabel : null,
        innerText: message.message,
        cloneNode: () => ({
          innerText: message.messageWithoutSenderHeading ?? message.message,
          querySelectorAll: (selector: string) => {
            assert.equal(selector, 'h4');
            return message.senderHeading ? [{ remove() {} }] : [];
          },
        }),
      }) as unknown as Element);
      return callback(elements);
    },
  };
  const page = {
    locator: (selector: string) => {
      assert.equal(
        selector,
        '[data-scope="messages_table"][aria-roledescription="message"][data-message-id]',
      );
      return locator;
    },
    waitForTimeout: async (milliseconds: number) => {
      waitDurations.push(milliseconds);
    },
  } as unknown as Page;

  return { page, waitDurations, scrollPositions };
}

test('classifies legacy and observed Messenger labels without inventing dates', () => {
  assert.deepEqual(
    classifyMessageLabel('At October 18, 2026, 1:15 PM, You: hello'),
    {
      timestamp: {
        original: 'October 18, 2026, 1:15 PM',
        normalized: '2026-10-18T13:15:00',
        resolved: true,
      },
      sender: 'You',
      direction: 'OUTGOING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At 1:15 PM, Alex: hello'),
    {
      timestamp: { original: '1:15 PM', normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At October 18, 2026, 1:15 PM, Alex'),
    {
      timestamp: {
        original: 'October 18, 2026, 1:15 PM',
        normalized: '2026-10-18T13:15:00',
        resolved: true,
      },
      sender: 'Alex',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At Friday 20:25, Anselmo'),
    {
      timestamp: { original: 'Friday 20:25', normalized: null, resolved: false },
      sender: 'Anselmo',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At Friday 20:25, You: fuck you all'),
    {
      timestamp: { original: 'Friday 20:25', normalized: null, resolved: false },
      sender: 'You',
      direction: 'OUTGOING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At 15:02, Anselmo: \u{1F604}'),
    {
      timestamp: { original: '15:02', normalized: null, resolved: false },
      sender: 'Anselmo',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('At 23:05, Anselmo: yo bro hows your day'),
    {
      timestamp: { original: '23:05', normalized: null, resolved: false },
      sender: 'Anselmo',
      direction: 'INCOMING',
    },
  );
  assert.deepEqual(
    classifyMessageLabel(null),
    {
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'UNKNOWN',
      direction: 'UNKNOWN',
    },
  );
  assert.deepEqual(
    classifyMessageLabel('unrecognized label'),
    {
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'UNKNOWN',
      direction: 'UNKNOWN',
    },
  );
});

test('aggregates overlapping scroll batches oldest-to-newest and caps at 60', async () => {
  const latest = Array.from({ length: 20 }, (_, index) => createMessage(index + 60));
  const middle = Array.from({ length: 26 }, (_, index) => createMessage(index + 40));
  const oldest = Array.from({ length: 26 }, (_, index) => createMessage(index + 20));
  const { page, waitDurations, scrollPositions } = createPage([latest, middle, oldest]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 60);
  assert.deepEqual(
    result.messages.map(message => message.id),
    Array.from({ length: 60 }, (_, index) => `message-${index + 20}`),
  );
  assert.equal(new Set(result.messages.map(message => message.id)).size, 60);
  assert.equal(result.messages[0].message, 'message 20');
  assert.deepEqual(result.messages[0].timestamp, {
    original: 'October 18, 2026, 1:15 PM',
    normalized: '2026-10-18T13:15:00',
    resolved: true,
  });
  assert.equal(result.messages[0].ariaLabel, 'At October 18, 2026, 1:15 PM, Sender: message 20');
  assert.deepEqual(scrollPositions, [4_000, 3_250, 2_500]);
  assert.deepEqual(waitDurations, [300, 400, 400]);
});

test('uses accessible sender/body boundaries without stripping genuine message prefixes', async () => {
  const renderedMessages: TestMessage[] = [
    {
      messageId: 'duplicate-name',
      ariaLabel: 'At Friday 20:25, Katsuyo: Katsuyo',
      message: 'Katsuyo',
    },
    {
      messageId: 'body-starts-with-sender',
      ariaLabel: 'At Friday 20:25, Anselmo: Anselmo said hello',
      message: 'Anselmo said hello',
    },
    {
      messageId: 'outgoing-prefix',
      ariaLabel: 'At Friday 20:25, You: fuck you all',
      message: 'You sent fuck you all',
    },
    {
      messageId: 'emoji-only',
      ariaLabel: 'At 15:02, Anselmo: \u{1F604}',
      message: '',
    },
    {
      messageId: 'inner-text-fallback',
      ariaLabel: 'At 23:05, Anselmo',
      message: 'Anselmo',
      senderHeading: 'Anselmo',
      messageWithoutSenderHeading: '',
    },
  ];
  const { page } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.deepEqual(
    result.messages.map(message => [message.id, message.message]),
    [
      ['duplicate-name', 'Katsuyo'],
      ['body-starts-with-sender', 'Anselmo said hello'],
      ['outgoing-prefix', 'fuck you all'],
      ['emoji-only', '\u{1F604}'],
      ['inner-text-fallback', ''],
    ],
  );
  assert.equal(
    result.messages.find(message => message.id === 'emoji-only')?.ariaLabel,
    'At 15:02, Anselmo: \u{1F604}',
  );
});

test('stops after three scrolls without new message IDs', async () => {
  const renderedMessages = [createMessage(1), createMessage(2)];
  const { page, waitDurations, scrollPositions } = createPage([
    renderedMessages,
    renderedMessages,
  ]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 2);
  assert.equal(scrollPositions.length, 4);
  assert.deepEqual(waitDurations, [300, 400, 400, 400]);
});

test('stops after eight upward scroll attempts when each attempt finds a new ID', async () => {
  const batches = [
    [createMessage(8)],
    ...Array.from({ length: 8 }, (_, index) => [createMessage(7 - index)]),
  ];
  const { page, waitDurations, scrollPositions } = createPage(batches);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 9);
  assert.equal(scrollPositions.length, 9);
  assert.equal(waitDurations.length, 9);
  assert.deepEqual(
    result.messages.map(message => message.id),
    Array.from({ length: 9 }, (_, index) => `message-${index}`),
  );
});

test('keeps only the latest 60 rendered messages when already over target', async () => {
  const renderedMessages = Array.from({ length: 70 }, (_, index) => createMessage(index));
  const { page, scrollPositions } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 60);
  assert.equal(result.messages[0].id, 'message-10');
  assert.equal(result.messages[59].id, 'message-69');
  assert.deepEqual(scrollPositions, [4_000]);
});