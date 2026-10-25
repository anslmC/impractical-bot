const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContextStore } = require('../components/context-store');

function message(messageId, text, participant) {
  return { messageId, message: text, participant };
}

test('starts empty with the default capacity', () => {
  const store = createContextStore();

  assert.deepEqual(store.getRecent(10), []);
  assert.deepEqual(store.getState(), {
    maxMessages: 60,
    size: 0,
    messageIds: [],
  });
});

test('adds unique messages in observation order', () => {
  const store = createContextStore();
  const messages = [message('m-2', 'second', 'other'), message('m-1', 'first', 'bot')];

  store.add(messages);

  assert.deepEqual(store.getRecent(10), messages);
});

test('deduplicates IDs across overlapping poll snapshots without refreshing order', () => {
  const store = createContextStore();
  store.add([message('m-2', 'second'), message('m-1', 'first')]);

  store.add([message('m-1', 'first'), message('m-3', 'third')]);

  assert.deepEqual(store.getState().messageIds, ['m-2', 'm-1', 'm-3']);
});

test('retains messages from both participants, including bot messages', () => {
  const store = createContextStore();

  store.add([message('other-1', 'incoming', 'other'), message('bot-1', 'outgoing', 'bot')]);

  assert.deepEqual(store.getRecent(2).map(item => item.participant), ['other', 'bot']);
});

test('enforces the default capacity and evicts the oldest retained messages', () => {
  const store = createContextStore();
  store.add(Array.from({ length: 61 }, (_, index) =>
    message(`m-${index}`, `message ${index}`)
  ));

  assert.equal(store.getState().size, 60);
  assert.equal(store.getState().maxMessages, 60);
  assert.deepEqual(store.getState().messageIds.slice(0, 2), ['m-1', 'm-2']);
  assert.equal(store.getState().messageIds.at(-1), 'm-60');
});

test('returns the most recent messages in chronological observation order', () => {
  const store = createContextStore();
  store.add([message('m-3', 'third'), message('m-1', 'first'), message('m-2', 'second')]);

  assert.deepEqual(store.getRecent(2).map(item => item.messageId), ['m-1', 'm-2']);
  assert.deepEqual(store.getRecent(0), []);
});

test('returned messages cannot mutate the retained records', () => {
  const store = createContextStore();
  store.add([{ ...message('m-1', 'original'), metadata: { source: 'poll' } }]);
  const result = store.getRecent(1);
  result[0].message = 'changed';
  result[0].metadata.source = 'changed';
  result.push(message('m-2', 'extra'));

  assert.deepEqual(store.getRecent(1), [
    { ...message('m-1', 'original'), metadata: { source: 'poll' } },
  ]);
});

test('does not retain duplicate IDs or move them to the newest position', () => {
  const store = createContextStore({ maxMessages: 3 });
  store.add([message('m-1', 'first'), message('m-2', 'second'), message('m-3', 'third')]);

  store.add([message('m-1', 'first')]);
  store.add([message('m-4', 'fourth')]);

  assert.deepEqual(store.getState().messageIds, ['m-2', 'm-3', 'm-4']);
});