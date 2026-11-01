import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import {
  classifyMessageLabel,
  readMessengerMessages,
} from '../src/components/backread.js';

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

function createPage(batches: TestMessage[][], scrollHeight = 4_000) {
  let batchIndex = 0;
  const waitDurations: number[] = [];
  const progressWaits: { timeout?: number; polling?: number }[] = [];
  const scrollPositions: number[] = [];
  const scrollElement = {
    clientHeight: 1_000,
    scrollHeight,
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
    waitForFunction: async (
      _callback: (argument: { selector: string; previousIds: string[] }) => boolean,
      { previousIds }: { selector: string; previousIds: string[] },
      options: { timeout?: number; polling?: number },
    ) => {
      progressWaits.push(options);
      const nextBatchIndex = Math.min(batchIndex + 1, batches.length - 1);
      const batch = batches[nextBatchIndex] ?? [];
      if (!batch.some(message =>
        message.messageId !== null && !previousIds.includes(message.messageId)
      )) {
        throw new Error('Timed out waiting for new messages.');
      }
      batchIndex = nextBatchIndex;
      return { dispose: async () => undefined };
    },
  } as unknown as Page;

  return { page, waitDurations, progressWaits, scrollPositions };
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

test('aggregates overlapping scroll batches oldest-to-newest and caps at 30', async () => {
  const latest = Array.from({ length: 20 }, (_, index) => createMessage(index + 60));
  const middle = Array.from({ length: 26 }, (_, index) => createMessage(index + 40));
  const oldest = Array.from({ length: 26 }, (_, index) => createMessage(index + 20));
  const { page, waitDurations, scrollPositions } = createPage([latest, middle, oldest]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 30);
  assert.deepEqual(
    result.messages.map(message => message.id),
    Array.from({ length: 30 }, (_, index) => `message-${index + 50}`),
  );
  assert.equal(new Set(result.messages.map(message => message.id)).size, 30);
  assert.equal(result.messages[0].message, 'message 50');
  assert.deepEqual(result.messages[0].timestamp, {
    original: 'October 18, 2026, 1:15 PM',
    normalized: '2026-10-18T13:15:00',
    resolved: true,
  });
  assert.equal(result.messages[0].ariaLabel, 'At October 18, 2026, 1:15 PM, Sender: message 50');
  assert.deepEqual(scrollPositions, [4_000, 3_250, 3_000]);
  assert.deepEqual(waitDurations, [300, 300]);
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

test('backread uses shared normalization for status and fallback presentation', async () => {
  const renderedMessages: TestMessage[] = [
    {
      messageId: 'outgoing-delivered',
      ariaLabel: "At October 18, 2026, 1:15 PM, You: Gg it's borken Delivered",
      message: "You sent Gg it's borken Delivered",
    },
    {
      messageId: 'outgoing-fallback',
      ariaLabel: null,
      message: "You sent Gg it's borken Seen",
    },
    {
      messageId: 'legitimate-status-body',
      ariaLabel: 'At October 18, 2026, 1:15 PM, You: I have Sent',
      message: 'You sent I have Sent',
    },
  ];
  const { page } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.deepEqual(
    result.messages.map(message => [message.id, message.message]),
    [
      ['outgoing-delivered', "Gg it's borken"],
      ['outgoing-fallback', "Gg it's borken"],
      ['legitimate-status-body', 'I have Sent'],
    ],
  );
});

test('continues scrolling without new IDs until the conversation top', async () => {
  const renderedMessages = [createMessage(1), createMessage(2)];
  const { page, waitDurations, progressWaits, scrollPositions } = createPage([
    renderedMessages,
    renderedMessages,
  ]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 2);
  assert.equal(scrollPositions.at(-1), 3_000);
  assert.deepEqual(waitDurations, [300, 300]);
  assert.equal(progressWaits.length, 8);
  assert.ok(progressWaits.every(wait => wait.timeout === 1_500 && wait.polling === 100));
});

test('continues past eight upward scroll attempts when each finds a new ID', async () => {
  const batches = [
    [createMessage(8)],
    ...Array.from({ length: 8 }, (_, index) => [createMessage(7 - index)]),
  ];
  const { page, progressWaits, scrollPositions } = createPage(batches, 16_000);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 9);
  assert.ok(scrollPositions.length > 9);
  assert.ok(progressWaits.length > 8);
  assert.equal(scrollPositions.at(-1), 15_000);
  assert.deepEqual(
    result.messages.map(message => message.id),
    Array.from({ length: 9 }, (_, index) => `message-${index}`),
  );
});

test('backread returns one logical message when a reply has two rendered ids', async () => {
  const reply = 'I literally just said it. Like, one message ago.';
  const renderedMessages: TestMessage[] = [
    {
      messageId: '7521591905785117407',
      ariaLabel: `At October 18, 2026, 1:15 PM, You: ${reply}`,
      message: reply,
    },
    {
      messageId: 'mid.$gAAW_kanMS16nuYVAE2hiD_y5xnrf',
      ariaLabel: `At October 18, 2026, 1:15 PM, You: ${reply}`,
      message: reply,
    },
  ];
  const { page } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.deepEqual(
    result.messages.map(message => message.id),
    ['7521591905785117407'],
    'the numeric id and its mid$ copy seed the Context Store once',
  );
  assert.match(result.diagnostics.join('\n'), /Merged duplicate rendered record/);
});

test('backread merges alternate ids observed in different scroll batches', async () => {
  const reply = 'I literally just said it. Like, one message ago.';
  const numericId = '7521591905785117407';
  const midId = 'mid.$gAAW_kanMS16nuYVAE2hiD_y5xnrf';
  const { page } = createPage([
    [
      {
        messageId: numericId,
        ariaLabel: `At October 18, 2026, 1:15 PM, You: ${reply}`,
        message: reply,
      },
      {
        messageId: 'message-9',
        ariaLabel: 'At October 18, 2026, 1:16 PM, Alex: newer message',
        message: 'newer message',
      },
    ],
    [
      {
        messageId: midId,
        ariaLabel: `At October 18, 2026, 1:15 PM, You: ${reply}`,
        message: reply,
      },
      {
        messageId: 'message-1',
        ariaLabel: 'At October 18, 2026, 1:14 PM, Alex: older message',
        message: 'older message',
      },
    ],
  ]);

  const result = await readMessengerMessages(page);

  assert.equal(
    result.messages.filter(message => message.message === reply).length,
    1,
    'the reply observed under another id in a later batch is not seeded twice',
  );
  assert.ok(result.messages.some(message => message.id === numericId));
  assert.equal(result.messages.some(message => message.id === midId), false);
  assert.match(result.diagnostics.join('\n'), /Merged duplicate rendered record/);
});

test('backread keeps legitimate repeated messages that share one id namespace', async () => {
  const renderedMessages: TestMessage[] = [
    {
      messageId: 'mid.$first',
      ariaLabel: 'At October 18, 2026, 1:15 PM, Alex: say it again',
      message: 'say it again',
    },
    {
      messageId: 'mid.$second',
      ariaLabel: 'At October 18, 2026, 1:16 PM, Alex: say it again',
      message: 'say it again',
    },
  ];
  const { page } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.deepEqual(
    result.messages.map(message => message.id),
    ['mid.$first', 'mid.$second'],
    'a repeated request is not mistaken for a duplicate rendering',
  );
  assert.doesNotMatch(result.diagnostics.join('\n'), /Merged duplicate rendered record/);
});

test('keeps only the latest 30 rendered messages when already over target', async () => {
  const renderedMessages = Array.from({ length: 70 }, (_, index) => createMessage(index));
  const { page, scrollPositions } = createPage([renderedMessages]);

  const result = await readMessengerMessages(page);

  assert.equal(result.messages.length, 30);
  assert.equal(result.messages[0].id, 'message-40');
  assert.equal(result.messages[29].id, 'message-69');
  assert.deepEqual(scrollPositions, [4_000, 3_000]);
});