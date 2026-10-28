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

function describePage(page: Page): string {
  try {
    const url = new URL(page.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'unknown-page';
  }
}

async function describeDocumentState(page: Page): Promise<string> {
  try {
    const state = await page.evaluate(() => ({
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    }));
    return `visibility=${state.visibility} hasFocus=${state.hasFocus}`;
  } catch {
    return 'visibility=unknown hasFocus=unknown';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export async function composeMessengerReply(
  page: Page,
  reply: string,
): Promise<ReplyCompositionResult> {
  const pageIdentity = describePage(page);
  const documentState = await describeDocumentState(page);
  console.log(`[compose] stage=start page=${pageIdentity} ${documentState}`);
  const visibleTextboxes = page.locator(
    '[role="textbox"][contenteditable="true"]:visible',
  );
  const textboxCount = await visibleTextboxes.count();
  const lexicalTextboxes = page.locator(
    '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]:visible',
  );
  const lexicalCount = await lexicalTextboxes.count();
  let composer;
  let strategy;

  if (textboxCount === 1) {
    composer = visibleTextboxes;
    strategy = 'general';
  } else if (lexicalCount === 1) {
    composer = lexicalTextboxes;
    strategy = 'lexical';
  } else if (textboxCount === 0) {
    console.log(
      `[compose] stage=locator-failed textboxes=${textboxCount} lexical=${lexicalCount}`,
    );
    throw new Error(
      'No visible Facebook Messages composer matched role="textbox" and ' +
      'contenteditable="true". Open a conversation and try again.',
    );
  } else {
    console.log(
      `[compose] stage=locator-failed textboxes=${textboxCount} lexical=${lexicalCount}`,
    );
    throw new Error(
      `Composer locator is ambiguous: ${textboxCount} visible editable ` +
      `textboxes found (${lexicalCount} with the Lexical hint). No text entered.`,
    );
  }

  console.log(
    `[compose] stage=fill-start strategy=${strategy} textboxes=${textboxCount} ` +
    `lexical=${lexicalCount} chars=${reply.length}`,
  );
  try {
    await composer.fill(reply);
  } catch (error) {
    console.log(`[compose] stage=fill-failed error=${describeError(error)}`);
    throw error;
  }
  console.log('[compose] stage=fill-complete');
  const composerRegions = page.locator('[aria-label="Thread composer"]');
  const composerRegionCount = await composerRegions.count();
  if (composerRegionCount === 0) {
    console.log('[compose] stage=send-control-failed reason=composer-region-missing');
    return { status: 'send-blocked', reason: 'composer-region-missing' };
  }
  if (composerRegionCount !== 1) {
    console.log(
      `[compose] stage=send-control-failed reason=composer-region-ambiguous ` +
      `regions=${composerRegionCount}`,
    );
    return { status: 'send-blocked', reason: 'composer-region-ambiguous' };
  }
  const sendButtons = composerRegions.locator(
    '[role="button"][aria-label="Press Enter to send"]',
  );
  const sendButtonCount = await sendButtons.count();
  if (sendButtonCount === 0) {
    console.log('[compose] stage=send-control-failed reason=send-control-missing');
    return { status: 'send-blocked', reason: 'send-control-missing' };
  }
  if (sendButtonCount !== 1) {
    console.log(
      `[compose] stage=send-control-failed reason=send-control-ambiguous ` +
      `buttons=${sendButtonCount}`,
    );
    return { status: 'send-blocked', reason: 'send-control-ambiguous' };
  }
  if (!await sendButtons.isVisible()) {
    console.log('[compose] stage=send-control-failed reason=hidden');
    return { status: 'send-blocked', reason: 'hidden' };
  }
  if (!await sendButtons.isEnabled()) {
    console.log('[compose] stage=send-control-failed reason=disabled');
    return { status: 'send-blocked', reason: 'disabled' };
  }

  console.log('[compose] stage=send-control-ready reason=visible-and-enabled');
  try {
    await sendButtons.click();
  } catch (error) {
    console.log(`[compose] stage=click-failed error=${describeError(error)}`);
    throw error;
  }
  console.log('[compose] stage=click-complete delivery=unconfirmed');
  return { status: 'sent' };
}
