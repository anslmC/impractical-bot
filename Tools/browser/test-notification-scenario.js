const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const NOTIFICATION_DIALOG_NAME = 'Push notifications request';
const DISMISS_TIMEOUT = 10000;

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
  return configuration;
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

  const exactTargetPages = expectedConversationId
    ? facebookPages.filter(candidate => getConversationId(candidate.url) === expectedConversationId)
    : [];
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

async function main() {
  const configuration = loadConfiguration();
  const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;
  const expectedConversationId = configuration.messageDestination
    ? getConversationId(new URL(configuration.messageDestination))
    : null;
  let browser;

  try {
    console.log(`Connecting to the configured browser at ${cdpEndpoint}.`);
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch {
      throw new Error(`Could not connect to the configured browser at ${cdpEndpoint}.`);
    }

    const page = selectFacebookPage(browser, expectedConversationId);
    console.log(`Selected existing Facebook page: ${page.url()}`);

    const dialog = page.getByRole('alertdialog', {
      name: NOTIFICATION_DIALOG_NAME,
      exact: true,
    });
    if (!await dialog.isVisible()) {
      throw new Error(`The "${NOTIFICATION_DIALOG_NAME}" alert dialog is not visible.`);
    }
    console.log(`Visible alert dialog found: ${NOTIFICATION_DIALOG_NAME}.`);

    const closeButton = dialog.getByRole('button', { name: 'Close', exact: true });
    if (await closeButton.count() !== 1) {
      throw new Error('Expected one Close button in the push-notification dialog.');
    }
    if (!await closeButton.isVisible() || !await closeButton.isEnabled()) {
      throw new Error('The push-notification Close button must be visible and enabled.');
    }

    console.log('Clicking the visible, enabled Close button once.');
    await closeButton.click({ timeout: 5000 });
    console.log('Waiting for the push-notification dialog to disappear.');
    await dialog.waitFor({ state: 'hidden', timeout: DISMISS_TIMEOUT });
    if (await dialog.isVisible()) {
      throw new Error('The push-notification dialog remains visible after clicking Close.');
    }

    console.log('SUCCESS: the Facebook push-notification dialog disappeared.');
  } finally {
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external browser was not intentionally closed.');
    }
  }
}

main().catch(error => {
  console.error(`Notification scenario failed: ${error.message}`);
  process.exitCode = 1;
});