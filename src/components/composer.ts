import type { Page } from 'playwright';

export type ReplyCompositionResult =
  | { status: 'sent' }
  | {
    status: 'send-blocked';
    reason:
      | 'composer-region-missing'
      | 'composer-region-ambiguous'
      | 'send-control-missing'
      | 'send-control-ambiguous'
      | 'hidden'
      | 'disabled';
  };

export async function composeMessengerReply(
  page: Page,
  reply: string,
): Promise<ReplyCompositionResult> {
  const visibleTextboxes = page.locator(
    '[role="textbox"][contenteditable="true"]:visible',
  );
  const textboxCount = await visibleTextboxes.count();
  const lexicalTextboxes = page.locator(
    '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]:visible',
  );
  const lexicalCount = await lexicalTextboxes.count();
  let composer;

  if (textboxCount === 1) {
    composer = visibleTextboxes;
  } else if (lexicalCount === 1) {
    composer = lexicalTextboxes;
  } else if (textboxCount === 0) {
    throw new Error(
      'No visible Facebook Messages composer matched role="textbox" and ' +
      'contenteditable="true". Open a conversation and try again.',
    );
  } else {
    throw new Error(
      `Composer locator is ambiguous: ${textboxCount} visible editable ` +
      `textboxes found (${lexicalCount} with the Lexical hint). No text entered.`,
    );
  }

  await composer.fill(reply);
  const composerRegions = page.locator('[aria-label="Thread composer"]');
  const composerRegionCount = await composerRegions.count();
  if (composerRegionCount === 0) {
    return { status: 'send-blocked', reason: 'composer-region-missing' };
  }
  if (composerRegionCount !== 1) {
    return { status: 'send-blocked', reason: 'composer-region-ambiguous' };
  }
  const sendButtons = composerRegions.locator(
    '[role="button"][aria-label="Press Enter to send"]',
  );
  const sendButtonCount = await sendButtons.count();
  if (sendButtonCount === 0) {
    return { status: 'send-blocked', reason: 'send-control-missing' };
  }
  if (sendButtonCount !== 1) {
    return { status: 'send-blocked', reason: 'send-control-ambiguous' };
  }
  if (!await sendButtons.isVisible()) {
    return { status: 'send-blocked', reason: 'hidden' };
  }
  if (!await sendButtons.isEnabled()) {
    return { status: 'send-blocked', reason: 'disabled' };
  }

  await sendButtons.click();
  return { status: 'sent' };
}