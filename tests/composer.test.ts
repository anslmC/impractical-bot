import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { composeMessengerReply } from '../src/messages/composer.js';

interface ComposerMockOptions {
  textboxCount?: number;
  lexicalCount?: number;
  composerRegionCount?: number;
  sendCount?: number;
  sendVisible?: boolean;
  sendEnabled?: boolean;
}

function createPage(options: ComposerMockOptions = {}) {
  let filledText: string | undefined;
  let sendClicks = 0;
  let sendSelector = '';
  const textboxCount = options.textboxCount ?? 1;
  const lexicalCount = options.lexicalCount ?? 1;
  const textbox = {
    count: async () => textboxCount,
    fill: async (text: string) => { filledText = text; },
  };
  const lexicalTextbox = {
    count: async () => lexicalCount,
    fill: async (text: string) => { filledText = text; },
  };
  const sendButton = {
    count: async () => options.sendCount ?? 1,
    isVisible: async () => options.sendVisible ?? true,
    isEnabled: async () => options.sendEnabled ?? true,
    click: async () => { sendClicks += 1; },
  };
  const composerRegion = {
    count: async () => options.composerRegionCount ?? 1,
    locator(selector: string) {
      sendSelector = selector;
      return sendButton;
    },
  };
  const page = {
    locator(selector: string) {
      if (selector === '[aria-label="Thread composer"]') {
        return composerRegion;
      }
      return selector.includes('data-lexical-editor') ? lexicalTextbox : textbox;
    },
  } as unknown as Page;

  return {
    page,
    get filledText() { return filledText; },
    get sendClicks() { return sendClicks; },
    get sendSelector() { return sendSelector; },
  };
}

test('fills the exact reply and sends automatically through the verified control', async () => {
  const mock = createPage();
  const reply = '  Exact generated reply\nwith formatting.  ';
  const result = await composeMessengerReply(mock.page, reply);

  assert.equal(mock.filledText, reply);
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(mock.sendClicks, 1);
});

test('uses the unique Lexical composer when multiple visible textboxes exist', async () => {
  const mock = createPage({ textboxCount: 2, lexicalCount: 1 });

  const result = await composeMessengerReply(mock.page, 'Draft');

  assert.equal(mock.filledText, 'Draft');
  assert.deepEqual(result, { status: 'sent' });
});

test('missing or ambiguous composers prevent text entry', async () => {
  for (const options of [
    { textboxCount: 0, lexicalCount: 0 },
    { textboxCount: 2, lexicalCount: 0 },
  ]) {
    const mock = createPage(options);
    await assert.rejects(
      composeMessengerReply(mock.page, 'Draft'),
      /composer|Composer/,
    );
    assert.equal(mock.filledText, undefined);
    assert.equal(mock.sendClicks, 0);
  }
});

test('automatic sending clicks only one matching visible enabled control', async () => {
  const blockedCases: { options: ComposerMockOptions; reason: string }[] = [
    { options: { sendCount: 0 }, reason: 'send-control-missing' },
    { options: { sendCount: 2 }, reason: 'send-control-ambiguous' },
    { options: { sendVisible: false }, reason: 'hidden' },
    { options: { sendEnabled: false }, reason: 'disabled' },
  ];

  for (const { options, reason } of blockedCases) {
    const mock = createPage(options);
    const result = await composeMessengerReply(mock.page, 'Draft');
    assert.equal(mock.filledText, 'Draft');
    assert.deepEqual(result, {
      status: 'send-blocked',
      reason,
    });
    assert.equal(mock.sendClicks, 0);
  }

  const approved = createPage();
  const result = await composeMessengerReply(approved.page, 'Draft');
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(approved.sendClicks, 1);
  assert.equal(approved.sendSelector, '[role="button"][aria-label="Press Enter to send"]');
});

test('automatic sending requires one Thread composer region before looking up its control', async () => {
  for (const [composerRegionCount, reason] of [[0, 'composer-region-missing'], [2, 'composer-region-ambiguous']] as const) {
    const mock = createPage({ composerRegionCount });
    const result = await composeMessengerReply(mock.page, 'Draft');

    assert.deepEqual(result, { status: 'send-blocked', reason });
    assert.equal(mock.sendSelector, '');
    assert.equal(mock.sendClicks, 0);
  }
});