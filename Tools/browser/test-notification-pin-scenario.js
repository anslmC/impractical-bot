const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const NOTIFICATION_DIALOG_NAME = 'Push notifications request';
const PIN_DIALOG_HEADING = 'Enter your PIN to restore your chats';
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
const CONFIRMATION_DIALOG_SELECTOR =
  '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]';
const SKIP_RESTORATION_BUTTON_SELECTOR =
  '[aria-label="Don\'t restore messages"][role="button"]';
const WAIT_TIMEOUT = 20000;
const NOTIFICATION_DISMISS_TIMEOUT = 10000;

function loadConfiguration() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set; unable to locate the impractical-bot configuration.');
  }

  const configurationPath = join(localAppData, 'Impractical Bot', 'config.json');
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  if (!Number.isInteger(configuration.cdpPort) || configuration.cdpPort < 1 || configuration.cdpPort > 65535) {
    throw new Error('The configured CDP port is missing or invalid.');
  }
  if (typeof configuration.messageDestination !== 'string') {
    throw new Error('The configured message destination is missing or invalid.');
  }

  let destinationUrl;
  try {
    destinationUrl = new URL(configuration.messageDestination);
  } catch {
    throw new Error('The configured message destination is not a valid URL.');
  }
  const expectedConversationId = getConversationId(destinationUrl);
  if (!expectedConversationId) {
    throw new Error('The configured message destination does not identify a Messenger conversation.');
  }

  return { configuration, expectedConversationId };
}

function getFacebookUrl(page) {
  try {
    const url = new URL(page.url());
    const isFacebookHost = url.hostname === 'facebook.com' ||
      url.hostname.endsWith('.facebook.com');
    return isFacebookHost ? url : null;
  } catch {
    return null;
  }
}

function getConversationId(url) {
  return url?.pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1] ?? null;
}

function selectFacebookPage(browser, expectedConversationId) {
  const facebookPages = browser.contexts()
    .flatMap(context => context.pages())
    .map(page => ({ page, url: getFacebookUrl(page) }))
    .filter(candidate => candidate.url);

  if (facebookPages.length === 0) {
    throw new Error('No existing Facebook tab was found in the configured browser.');
  }

  const exactTargetPages = facebookPages.filter(candidate =>
    getConversationId(candidate.url) === expectedConversationId
  );
  if (exactTargetPages.length === 1) {
    return exactTargetPages[0].page;
  }
  if (exactTargetPages.length > 1) {
    throw new Error('Multiple Facebook tabs already show the configured conversation.');
  }

  const messengerPages = facebookPages.filter(candidate =>
    /^\/messages(?:\/|$)/.test(candidate.url.pathname)
  );
  if (messengerPages.length === 1) {
    return messengerPages[0].page;
  }
  if (messengerPages.length > 1) {
    throw new Error('Multiple Messenger tabs were found; cannot choose one reliably.');
  }
  if (facebookPages.length === 1) {
    return facebookPages[0].page;
  }

  throw new Error('Multiple Facebook tabs were found and none is a unique Messenger tab.');
}

async function findVisiblePinDialogs(page) {
  const dialogs = page.locator(MODAL_DIALOG_SELECTOR);
  const dialogCount = await dialogs.count();
  const pinDialogs = [];

  for (let index = 0; index < dialogCount; index += 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible()) {
      continue;
    }

    const heading = dialog.getByRole('heading', {
      name: PIN_DIALOG_HEADING,
      exact: true,
    });
    if (await heading.filter({ visible: true }).count() === 1) {
      pinDialogs.push(dialog);
    }
  }

  return pinDialogs;
}

async function dismissNotificationDialog(page) {
  const dialog = page.getByRole('alertdialog', {
    name: NOTIFICATION_DIALOG_NAME,
    exact: true,
  });
  if (!await dialog.isVisible()) {
    console.log(`Challenge 0: no visible "${NOTIFICATION_DIALOG_NAME}" dialog; continuing.`);
    return;
  }
  console.log(`Challenge 0: visible alert dialog found: ${NOTIFICATION_DIALOG_NAME}.`);

  const closeButton = dialog.getByRole('button', { name: 'Close', exact: true });
  if (await closeButton.count() !== 1) {
    throw new Error('Expected one Close button in the push-notification dialog.');
  }
  if (!await closeButton.isVisible() || !await closeButton.isEnabled()) {
    throw new Error('The push-notification Close button must be visible and enabled.');
  }

  console.log('Challenge 0: clicking the Close button once.');
  await closeButton.click({ timeout: 5000 });
  await dialog.waitFor({ state: 'hidden', timeout: NOTIFICATION_DISMISS_TIMEOUT });
  if (await dialog.isVisible()) {
    throw new Error('The push-notification dialog remains visible after clicking Close.');
  }
  console.log('Challenge 0: notification dialog dismissed.');
}

async function skipPinRestoration(page, pinDialog) {
  const closeButtons = pinDialog.locator('[aria-label="Close"][role="button"]');
  const closeCount = await closeButtons.count();
  console.log(`Challenge 1: matching PIN-dialog Close buttons: ${closeCount}.`);

  let closeButton = null;
  for (let index = 0; index < closeCount; index += 1) {
    const candidate = closeButtons.nth(index);
    if (await candidate.isVisible() && await candidate.isEnabled()) {
      closeButton = candidate;
      break;
    }
  }
  if (!closeButton) {
    throw new Error('No matching PIN-dialog Close button is both visible and enabled.');
  }

  console.log('Challenge 1: clicking the first available Close button once.');
  await closeButton.evaluate(element => element.click(), undefined, { timeout: 5000 });

  const confirmationDialog = page.locator(CONFIRMATION_DIALOG_SELECTOR);
  console.log('Challenge 1: waiting for the explicit skip confirmation.');
  await confirmationDialog.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  if (!await confirmationDialog.isVisible()) {
    throw new Error('The PIN skip confirmation dialog is not visible.');
  }

  const skipButtons = confirmationDialog.locator(SKIP_RESTORATION_BUTTON_SELECTOR);
  const skipCount = await skipButtons.count();
  let skipButton = null;
  for (let index = 0; index < skipCount; index += 1) {
    const candidate = skipButtons.nth(index);
    if (await candidate.isVisible() && await candidate.isEnabled()) {
      skipButton = candidate;
      break;
    }
  }
  if (!skipButton) {
    throw new Error(`None of the ${skipCount} skip-restoration buttons is both visible and enabled.`);
  }

  console.log('Challenge 1: clicking "Don\'t restore messages" once.');
  await skipButton.evaluate(element => element.click(), undefined, { timeout: 5000 });

  let confirmationDisappeared = false;
  try {
    await confirmationDialog.waitFor({ state: 'hidden', timeout: WAIT_TIMEOUT });
    confirmationDisappeared = !await confirmationDialog.isVisible();
  } catch {
    // Report unsuccessful dismissal below.
  }

  const remainingPinDialogs = await findVisiblePinDialogs(page);
  const pinDialogRemainsVisible = remainingPinDialogs.length > 0;
  console.log(`Challenge 1: confirmation dialog disappeared: ${confirmationDisappeared ? 'yes' : 'no'}.`);
  console.log(`Challenge 1: PIN dialog remains visible: ${pinDialogRemainsVisible ? 'yes' : 'no'}.`);
  if (!confirmationDisappeared || pinDialogRemainsVisible) {
    throw new Error('PIN-restoration skip did not complete successfully.');
  }
}

async function runPinChallenge(page) {
  const pinDialogs = await findVisiblePinDialogs(page);
  if (pinDialogs.length === 0) {
    console.log(`Challenge 1: no visible PIN restoration dialog headed "${PIN_DIALOG_HEADING}"; continuing.`);
    return;
  }
  if (pinDialogs.length > 1) {
    throw new Error(`Expected at most one visible PIN restoration dialog, found ${pinDialogs.length}.`);
  }

  console.log('Challenge 1: visible PIN restoration dialog found; skipping restoration.');
  await skipPinRestoration(page, pinDialogs[0]);
}

async function verifyFinalState(page, expectedConversationId) {
  const currentUrl = getFacebookUrl(page);
  const currentConversationId = currentUrl && getConversationId(currentUrl);
  if (currentConversationId !== expectedConversationId) {
    throw new Error('The selected page is no longer on the configured Messenger conversation.');
  }

  const notificationVisible = await page.getByRole('alertdialog', {
    name: NOTIFICATION_DIALOG_NAME,
    exact: true,
  }).isVisible();
  const pinDialogs = await findVisiblePinDialogs(page);
  const confirmationVisible = await page.locator(CONFIRMATION_DIALOG_SELECTOR).isVisible();
  if (notificationVisible || pinDialogs.length > 0 || confirmationVisible) {
    throw new Error(
      `A blocker dialog remains visible (notification: ${notificationVisible ? 'yes' : 'no'}, ` +
      `PIN: ${pinDialogs.length > 0 ? 'yes' : 'no'}, confirmation: ${confirmationVisible ? 'yes' : 'no'}).`
    );
  }

  console.log(`Final verification: configured conversation ${currentConversationId} is still selected.`);
  console.log('Final verification: notification and PIN dialogs are no longer visible.');
}

async function main() {
  const { configuration, expectedConversationId } = loadConfiguration();
  const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;
  let browser;

  try {
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch {
      throw new Error(`Could not connect to the configured browser at ${cdpEndpoint}.`);
    }

    const page = selectFacebookPage(browser, expectedConversationId);
    const selectedConversationId = getConversationId(getFacebookUrl(page));
    if (selectedConversationId !== expectedConversationId) {
      throw new Error('The selected existing tab is not already at the configured Messenger conversation.');
    }

    await dismissNotificationDialog(page);
    await runPinChallenge(page);
    await verifyFinalState(page, expectedConversationId);
    console.log('SUCCESS: both applicable Messenger blocker checks passed.');
  } finally {
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external browser was not intentionally closed.');
    }
  }
}

main().catch(error => {
  console.error(`Notification and PIN scenario failed: ${error.message}`);
  process.exitCode = 1;
});
