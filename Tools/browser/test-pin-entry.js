const { chromium } = require('playwright');

const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const PIN_SELECTOR =
  'input[aria-label="PIN"], input[autocomplete="one-time-code"], input[maxlength="6"]';
const TEST_PIN = '111111';

function isFacebookPage(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

function findFacebookPage(browser) {
  const pages = browser.contexts()
    .flatMap(context => context.pages())
    .filter(isFacebookPage);

  if (pages.length === 0) {
    throw new Error(
      'No existing Facebook tab was found in Brave. Open Facebook in Brave and try again.'
    );
  }
  if (pages.length > 1) {
    throw new Error(
      `Found ${pages.length} Facebook tabs; cannot choose one reliably. Leave one Facebook tab open and try again.`
    );
  }
  return pages[0];
}

async function reportVisibleSubmissionControls(page) {
  const buttons = await page.getByRole('button').all();
  const visibleControls = [];

  for (const button of buttons) {
    if (await button.isVisible()) {
      visibleControls.push(await button.ariaSnapshot());
    }
  }

  if (visibleControls.length === 0) {
    console.log('Visible submission controls: none found with the button role.');
    return;
  }

  console.log('Visible controls with the button role (not activated):');
  for (const control of visibleControls) {
    console.log(control);
  }
}

async function main() {
  let browser;
  try {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch {
      throw new Error(
        `Could not connect to Brave at ${CDP_ENDPOINT}. Ensure Brave is already ` +
        'running with remote debugging enabled on this address and port.'
      );
    }

    const page = findFacebookPage(browser);
    console.log(`Using existing Facebook tab: ${page.url()}`);

    const pinInputs = page.locator(PIN_SELECTOR);
    const inputCount = await pinInputs.count();
    console.log(`Matching PIN inputs: ${inputCount}`);

    if (inputCount === 1) {
      const input = pinInputs.first();
      const visible = await input.isVisible();
      const enabled = await input.isEnabled();
      console.log(`Unique input visible: ${visible ? 'yes' : 'no'}`);
      console.log(`Unique input enabled: ${enabled ? 'yes' : 'no'}`);

      if (visible && enabled) {
        try {
          await input.fill(TEST_PIN);
          const enteredSuccessfully = await input.inputValue() === TEST_PIN;
          console.log(`Artificial test value entered successfully: ${enteredSuccessfully ? 'yes' : 'no'}`);
        } catch {
          console.log('Artificial test value entered successfully: no');
        }
      } else {
        console.log('No value entered because the unique input is not both visible and enabled.');
      }
    } else if (inputCount === 0) {
      console.log('PIN input missing; no page changes made.');
    } else {
      console.log('PIN input is ambiguous; no page changes made.');
    }

    await reportVisibleSubmissionControls(page);
  } finally {
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external Brave browser was not intentionally closed.');
    }
  }
}

main().catch(error => {
  console.error(`PIN entry test failed: ${error.message}`);
  process.exitCode = 1;
});