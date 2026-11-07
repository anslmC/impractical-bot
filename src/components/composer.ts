import type { Page } from 'playwright';
import { formatTerminalText, type TerminalStyle } from './terminal-formatting.js';

const styled = formatTerminalText;

function formatComposeLog(stage: string, style: TerminalStyle = 'dim', details = ''): string {
  return `${styled('[compose]', 'cyan')} ${styled(`stage=${stage}`, style)}` +
    (details ? ` ${details}` : '');
}

function formatComposeField(name: string, value: string | number, style: TerminalStyle = 'dim'): string {
  return `${styled(`${name}=`, 'dim')}${styled(String(value), style)}`;
}

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
      | 'disabled'
      | 'payload-too-long';
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

export type AutomatedInputRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ReplyCompositionOptions {
  beforeSend?: () => Promise<void>;
  maxCharacters?: number;
  runAutomatedInput?: AutomatedInputRunner;
}

export async function composeMessengerReply(
  page: Page,
  reply: string,
  { beforeSend, maxCharacters, runAutomatedInput }: ReplyCompositionOptions = {},
): Promise<ReplyCompositionResult> {
  const runAutomated = runAutomatedInput ?? (<T>(operation: () => Promise<T>) => operation());
  if (maxCharacters !== undefined) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new RangeError('maxCharacters must be a positive integer.');
    }
    if (reply.length > maxCharacters) {
      console.log(
        formatComposeLog(
          'payload-rejected',
          'red',
          `reason=${styled('payload-too-long', 'red')} ` +
          `${formatComposeField('chars', reply.length, 'red')} ` +
          `${formatComposeField('maxCharacters', maxCharacters)}`,
        ),
      );
      return { status: 'send-blocked', reason: 'payload-too-long' };
    }
  }
  const pageIdentity = describePage(page);
  const documentState = await describeDocumentState(page);
  console.log(`${formatComposeLog('start', 'bold')}\n  ${formatComposeField('page', pageIdentity)} ${styled(documentState, 'dim')}`);
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
      formatComposeLog(
        'locator-failed',
        'red',
        `${formatComposeField('textboxes', textboxCount)} ${formatComposeField('lexical', lexicalCount)}`,
      ),
    );
    throw new Error(
      'No visible Facebook Messages composer matched role="textbox" and ' +
      'contenteditable="true". Open a conversation and try again.',
    );
  } else {
    console.log(
      formatComposeLog(
        'locator-failed',
        'red',
        `${formatComposeField('textboxes', textboxCount)} ${formatComposeField('lexical', lexicalCount)}`,
      ),
    );
    throw new Error(
      `Composer locator is ambiguous: ${textboxCount} visible editable ` +
      `textboxes found (${lexicalCount} with the Lexical hint). No text entered.`,
    );
  }

  console.log(
    formatComposeLog(
      'fill-start',
      'dim',
      `${formatComposeField('strategy', strategy)} ${formatComposeField('textboxes', textboxCount)} ` +
      `${formatComposeField('lexical', lexicalCount)} ${formatComposeField('chars', reply.length, 'bold')}`,
    ),
  );
  try {
    await runAutomated(() => composer.fill(reply));
  } catch (error) {
    console.log(
      `${formatComposeLog('fill-failed', 'red')}\n  ` +
      `${formatComposeField('error', describeError(error), 'red')}`,
    );
    throw error;
  }
  console.log(formatComposeLog('fill-complete', 'green'));
  const composerRegions = page.locator('[aria-label="Thread composer"]');
  const composerRegionCount = await composerRegions.count();
  if (composerRegionCount === 0) {
    console.log(formatComposeLog('send-control-failed', 'red', 'reason=composer-region-missing'));
    return { status: 'send-blocked', reason: 'composer-region-missing' };
  }
  if (composerRegionCount !== 1) {
    console.log(
      formatComposeLog(
        'send-control-failed',
        'red',
        `reason=composer-region-ambiguous ${formatComposeField('regions', composerRegionCount)}`,
      ),
    );
    return { status: 'send-blocked', reason: 'composer-region-ambiguous' };
  }
  const sendButtons = composerRegions.locator(
    '[role="button"][aria-label="Press Enter to send"]',
  );
  const sendButtonCount = await sendButtons.count();
  if (sendButtonCount === 0) {
    console.log(formatComposeLog('send-control-failed', 'red', 'reason=send-control-missing'));
    return { status: 'send-blocked', reason: 'send-control-missing' };
  }
  if (sendButtonCount !== 1) {
    console.log(
      formatComposeLog(
        'send-control-failed',
        'red',
        `reason=send-control-ambiguous ${formatComposeField('buttons', sendButtonCount)}`,
      ),
    );
    return { status: 'send-blocked', reason: 'send-control-ambiguous' };
  }
  if (!await sendButtons.isVisible()) {
    console.log(formatComposeLog('send-control-failed', 'red', 'reason=hidden'));
    return { status: 'send-blocked', reason: 'hidden' };
  }
  if (!await sendButtons.isEnabled()) {
    console.log(formatComposeLog('send-control-failed', 'red', 'reason=disabled'));
    return { status: 'send-blocked', reason: 'disabled' };
  }

  console.log(formatComposeLog('send-control-ready', 'green', 'reason=visible-and-enabled'));
  if (beforeSend) {
    try {
      await beforeSend();
    } catch (error) {
      console.log(
        `${formatComposeLog('send-gate-failed', 'red')}\n  ` +
        `${formatComposeField('error', describeError(error), 'red')}`,
      );
      throw error;
    }
  }
  try {
    await runAutomated(() => sendButtons.click());
  } catch (error) {
    console.log(
      `${formatComposeLog('click-failed', 'red')}\n  ` +
      `${formatComposeField('error', describeError(error), 'red')}`,
    );
    throw error;
  }
  console.log(formatComposeLog(
    'click-complete',
    'green',
    `delivery=${styled('unconfirmed', 'yellow')}`,
  ));
  return { status: 'sent' };
}
