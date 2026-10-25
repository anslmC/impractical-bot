const assert = require('node:assert/strict');
const { test } = require('node:test');
const { composeMessengerReply } = require('../components/composer');

function createPage(options = {}) {
  const state = {
    filledText: undefined,
    fillSelector: undefined,
    sendSelector: undefined,
    sendClicks: 0,
  };
  const visibleTextboxes = {
    count: async () => options.textboxCount ?? 1,
    fill: async text => {
      state.filledText = text;
      state.fillSelector = '[role="textbox"][contenteditable="true"]:visible';
    },
  };
  const lexicalTextboxes = {
    count: async () => options.lexicalCount ?? 1,
    fill: async text => {
      state.filledText = text;
      state.fillSelector =
        '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]:visible';
    },
  };
  const sendButton = {
    count: async () => options.sendCount ?? 1,
    isVisible: async () => options.sendVisible ?? true,
    isEnabled: async () => options.sendEnabled ?? true,
    click: async () => { state.sendClicks += 1; },
  };
  const composerRegion = {
    count: async () => options.composerRegionCount ?? 1,
    locator: selector => {
      state.sendSelector = selector;
      return sendButton;
    },
  };
  const page = {
    locator(selector) {
      if (selector === '[aria-label="Thread composer"]') {
        return composerRegion;
      }
      if (selector === '[role="textbox"][contenteditable="true"]:visible') {
        return visibleTextboxes;
      }
      if (selector === '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]:visible') {
        return lexicalTextboxes;
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
  };

  return { page, state };
}

test('fills the exact reply and clicks the unique verified send control', async () => {
  const { page, state } = createPage();
  const reply = '  Exact generated reply\nwith formatting.  ';

  const result = await composeMessengerReply(page, reply);

  assert.equal(state.filledText, reply);
  assert.equal(state.fillSelector, '[role="textbox"][contenteditable="true"]:visible');
  assert.equal(
    state.sendSelector,
    '[role="button"][aria-label="Press Enter to send"]',
  );
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(state.sendClicks, 1);
});

test('uses the unique Lexical textbox when visible editable textboxes are ambiguous', async () => {
  const { page, state } = createPage({ textboxCount: 2, lexicalCount: 1 });

  const result = await composeMessengerReply(page, 'Draft');

  assert.equal(
    state.fillSelector,
    '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]:visible',
  );
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(state.sendClicks, 1);
});

test('missing or ambiguous textboxes throw before entering text or clicking Send', async () => {
  for (const options of [
    { textboxCount: 0, lexicalCount: 0 },
    { textboxCount: 2, lexicalCount: 0 },
    { textboxCount: 2, lexicalCount: 2 },
  ]) {
    const { page, state } = createPage(options);

    await assert.rejects(composeMessengerReply(page, 'Draft'), /composer|Composer/);

    assert.equal(state.filledText, undefined);
    assert.equal(state.sendClicks, 0);
  }
});

test('blocked send conditions preserve the draft and never click Send', async () => {
  const blockedCases = [
    { options: { composerRegionCount: 0 }, reason: 'composer-region-missing' },
    { options: { composerRegionCount: 2 }, reason: 'composer-region-ambiguous' },
    { options: { sendCount: 0 }, reason: 'send-control-missing' },
    { options: { sendCount: 2 }, reason: 'send-control-ambiguous' },
    { options: { sendVisible: false }, reason: 'hidden' },
    { options: { sendEnabled: false }, reason: 'disabled' },
  ];

  for (const { options, reason } of blockedCases) {
    const { page, state } = createPage(options);

    const result = await composeMessengerReply(page, 'Draft');

    assert.deepEqual(result, { status: 'send-blocked', reason });
    assert.equal(state.filledText, 'Draft');
    assert.equal(state.sendClicks, 0);
    if (options.composerRegionCount === 0 || options.composerRegionCount === 2) {
      assert.equal(state.sendSelector, undefined);
    }
  }
});