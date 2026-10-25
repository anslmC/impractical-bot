const { chromium } = require('playwright');

const CDP_ENDPOINT = 'http://127.0.0.1:35858';
const TARGET_CONVERSATION_URL =
  'https://www.facebook.com/messages/t/1618007223454558';
const PIN_DIALOG_HEADING = 'Enter your PIN to restore your chats';
const TARGET_URL = new URL(TARGET_CONVERSATION_URL);
const EXPECTED_CONVERSATION_ID =
  TARGET_URL.pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1];
const PIN_SELECTOR =
  'input[aria-label="PIN"], input[autocomplete="one-time-code"], input[maxlength="6"]';
const TEST_PIN = '000000';
const REJECTION_MESSAGE = 'Incorrect PIN. Try again.';
const WAIT_TIMEOUT = 3000;
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
const CONFIRMATION_DIALOG_SELECTOR =
  '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]';
const SKIP_RESTORATION_BUTTON_SELECTOR =
  '[aria-label="Don\'t restore messages"][role="button"]';

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

async function runScenarioA(page, pinDialog) {
  console.log('Scenario A - Incorrect PIN');
  const dialogPinInputs = pinDialog.locator(PIN_SELECTOR);
  const inputCount = await dialogPinInputs.count();

  if (inputCount !== 1) {
    console.log(`Blocked: expected one PIN input in the dialog, found ${inputCount}.`);
  } else {
    const pinInput = dialogPinInputs.first();
    if (!await pinInput.isVisible() || !await pinInput.isEnabled()) {
      console.log('Blocked: the unique PIN input is not both visible and enabled.');
    } else {
      try {
        await pinInput.fill(TEST_PIN);
        const rejection = page.getByText(REJECTION_MESSAGE, { exact: true });
        try {
          await rejection.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
        } catch {
          // Report the observed absence below; never retry the PIN.
        }
        console.log(
          `Rejection confirmed: ${await rejection.isVisible() ? 'yes' : 'no'}.`
        );
      } catch {
        console.log('Blocked: entering the test PIN did not complete cleanly; not retried.');
      }
    }
  }
}

function selectFacebookPage(browser) {
  const facebookPages = browser.contexts()
    .flatMap(context => context.pages())
    .map(page => ({ page, url: getFacebookUrl(page) }))
    .filter(candidate => candidate.url);

  if (facebookPages.length === 0) {
    throw new Error(
      'No existing Facebook tab was found in Brave. Open Facebook in Brave and try again.'
    );
  }

  const exactTargetPages = facebookPages.filter(candidate =>
    getConversationId(candidate.url) === EXPECTED_CONVERSATION_ID
  );
  if (exactTargetPages.length === 1) {
    return exactTargetPages[0];
  }
  if (exactTargetPages.length > 1) {
    throw new Error(
      `Found ${exactTargetPages.length} tabs already on the target conversation; ` +
      'cannot choose one reliably.'
    );
  }

  const messengerPages = facebookPages.filter(candidate =>
    /^\/messages(?:\/|$)/.test(candidate.url.pathname)
  );
  if (messengerPages.length === 1) {
    return messengerPages[0];
  }
  if (messengerPages.length > 1) {
    throw new Error(
      `Found ${messengerPages.length} Messenger tabs and none is on the target ` +
      'conversation; cannot choose one reliably.'
    );
  }

  if (facebookPages.length === 1) {
    return facebookPages[0];
  }

  throw new Error(
    `Found ${facebookPages.length} Facebook tabs and no unique Messenger tab; ` +
    'cannot choose a tab reliably.'
  );
}

async function main() {
  let browser;
  try {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch {
      throw new Error(`Could not connect to the existing browser at ${CDP_ENDPOINT}.`);
    }

    const { page } = selectFacebookPage(browser);
    console.log('Stage: locating visible PIN restoration dialog.');
    const modalDialogs = page.locator(MODAL_DIALOG_SELECTOR);
    const modalCount = await modalDialogs.count();
    const pinDialogs = [];
    for (let index = 0; index < modalCount; index += 1) {
      const dialog = modalDialogs.nth(index);
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

    if (pinDialogs.length !== 1) {
      console.log(
        `Stopped at PIN dialog lookup: expected one visible dialog headed ` +
        `"${PIN_DIALOG_HEADING}", found ${pinDialogs.length}.`
      );
      return;
    }

    const pinDialog = pinDialogs[0];
    await runScenarioA(page, pinDialog);

    const closeButtons = pinDialog.locator('[aria-label="Close"][role="button"]');
    const closeCount = await closeButtons.count();
    console.log(`Stage: PIN dialog verified; matching Close buttons: ${closeCount}.`);

    let closeButton = null;
    for (let index = 0; index < closeCount; index += 1) {
      const candidate = closeButtons.nth(index);
      if (await candidate.isVisible() && await candidate.isEnabled()) {
        closeButton = candidate;
        break;
      }
    }
    if (!closeButton) {
      console.log('Stopped at Close lookup: no matching Close button is both visible and enabled.');
      return;
    }

    try {
      await closeButton.evaluate(element => element.click(), undefined, { timeout: 5000 });
    } catch (error) {
      console.log(`Stopped at Close click: ${error.message}`);
      return;
    }
    console.log('Stage: first available Close button clicked once; waiting for confirmation dialog.');

    const confirmationDialog = page.locator(CONFIRMATION_DIALOG_SELECTOR);
    try {
      await confirmationDialog.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    } catch {
      console.log('Stopped: confirmation dialog did not appear after the Close click.');
      return;
    }
    if (!await confirmationDialog.isVisible()) {
      console.log('Stopped: confirmation dialog is not visible.');
      return;
    }
    console.log('Stage: confirmation dialog verified.');

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
      console.log(
        `Stopped: none of the ${skipCount} matching skip-restoration buttons is both visible and enabled.`
      );
      return;
    }

    try {
      await skipButton.evaluate(element => element.click(), undefined, { timeout: 5000 });
    } catch (error) {
      console.log(`Stopped at skip button click: ${error.message}`);
      return;
    }
    console.log('Stage: skip-restoration button clicked once; verifying dialog dismissal.');

    let confirmationDisappeared = false;
    try {
      await confirmationDialog.waitFor({ state: 'hidden', timeout: WAIT_TIMEOUT });
      confirmationDisappeared = !await confirmationDialog.isVisible();
    } catch {
      // Report unsuccessful dismissal below.
    }

    const remainingPinDialogs = page.locator(MODAL_DIALOG_SELECTOR).filter({
      has: page.getByRole('heading', { name: PIN_DIALOG_HEADING, exact: true }),
    });
    let pinDialogRemainsVisible = false;
    const remainingCount = await remainingPinDialogs.count();
    for (let index = 0; index < remainingCount; index += 1) {
      if (await remainingPinDialogs.nth(index).isVisible()) {
        pinDialogRemainsVisible = true;
        break;
      }
    }

    const completed = confirmationDisappeared && !pinDialogRemainsVisible;
    console.log(`Confirmation dialog disappeared: ${confirmationDisappeared ? 'yes' : 'no'}.`);
    console.log(`PIN restoration dialog remains visible: ${pinDialogRemainsVisible ? 'yes' : 'no'}.`);
    console.log(`Skip-restoration flow completed successfully: ${completed ? 'yes' : 'no'}.`);
  } finally {
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external Brave browser was not launched or intentionally closed.');
    }
  }
}

main().catch(error => {
  console.error(`PIN navigation test failed: ${error.message}`);
  process.exitCode = 1;
});
