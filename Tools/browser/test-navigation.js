const { chromium } = require('playwright');

const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const TARGET_CONVERSATION_URL =
  'https://www.facebook.com/messages/t/1618007223454558';
const EXPECTED_GROUP_NAME = 'Bot Test';
const TARGET_URL = new URL(TARGET_CONVERSATION_URL);
const EXPECTED_CONVERSATION_ID =
  TARGET_URL.pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1];

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

function describeFacebookState(url) {
  if (!url) {
    return 'an unrecognized state';
  }

  if (/^\/(?:login(?:\.php)?|checkpoint)(?:\/|$)/.test(url.pathname)) {
    return url.pathname.startsWith('/login')
      ? 'the Facebook login page'
      : 'a Facebook checkpoint';
  }
  if (url.pathname === '/' || url.pathname === '/home.php') {
    return 'the Facebook News Feed';
  }
  if (getConversationId(url)) {
    return 'a Messenger conversation';
  }
  if (/^\/messages(?:\/|$)/.test(url.pathname)) {
    return 'Messenger without a conversation identified in the URL';
  }
  return 'another Facebook page';
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

async function inspectExpectedGroupHeading(page) {
  const heading = page.getByRole('heading', {
    name: EXPECTED_GROUP_NAME,
    exact: true,
  });
  const found = await heading.count() > 0;
  const visible = found && await heading.filter({ visible: true }).count() > 0;
  return { found, visible };
}

async function main() {
  if (!EXPECTED_CONVERSATION_ID) {
    throw new Error('The configured target URL does not contain a conversation ID.');
  }

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

    const { page } = selectFacebookPage(browser);
    const currentUrl = page.url();
    const currentFacebookUrl = getFacebookUrl(page);
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Current state: ${describeFacebookState(currentFacebookUrl)}`);

    let navigationError = null;
    if (getConversationId(currentFacebookUrl) === EXPECTED_CONVERSATION_ID) {
      console.log('The target conversation is already open; skipping navigation.');
    } else {
      try {
        await page.goto(TARGET_CONVERSATION_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (error) {
        navigationError = error;
        const timedOut = error.name === 'TimeoutError';
        console.log(
          `Navigation ${timedOut ? 'timed out' : 'did not complete'}: ${error.message}`
        );
      }
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // Messenger may keep network activity open; inspect the settled DOM state below.
    }

    const resultingUrl = page.url();
    const resultingFacebookUrl = getFacebookUrl(page);
    const resultingConversationId = getConversationId(resultingFacebookUrl);
    const stateDescription = describeFacebookState(resultingFacebookUrl);
    console.log(`Resulting URL: ${resultingUrl}`);
    console.log(`Resulting state: ${stateDescription}`);
    console.log(
      `Conversation ID: ${resultingConversationId || 'not present'} ` +
      `(expected ${EXPECTED_CONVERSATION_ID})`
    );

    const groupHeading = await inspectExpectedGroupHeading(page);
    console.log(
      `Expected group heading "${EXPECTED_GROUP_NAME}" found: ${groupHeading.found ? 'yes' : 'no'}.`
    );
    console.log(
      `Expected group heading "${EXPECTED_GROUP_NAME}" visible: ${groupHeading.visible ? 'yes' : 'no'}.`
    );

    const verified = !navigationError &&
      resultingConversationId === EXPECTED_CONVERSATION_ID &&
      groupHeading.found &&
      groupHeading.visible;
    if (verified) {
      console.log('Navigation verified: the target URL and expected group heading match.');
    } else {
      console.log('Navigation unverified.');
      if (navigationError) {
        console.log('The navigation did not complete cleanly.');
      }
      if (resultingConversationId !== EXPECTED_CONVERSATION_ID) {
        console.log('The resulting URL does not identify the expected conversation.');
      }
      if (!groupHeading.found) {
        console.log(
          `The URL may match, but the expected group heading "${EXPECTED_GROUP_NAME}" was not found.`
        );
      } else if (!groupHeading.visible) {
        console.log(
          `The expected group heading "${EXPECTED_GROUP_NAME}" was found but is not visible.`
        );
      }
    }
  } finally {
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external Brave browser was not launched or intentionally closed.');
    }
  }
}

main().catch(error => {
  console.error(`Navigation test failed: ${error.message}`);
  process.exitCode = 1;
});