const { chromium } = require('playwright');
const {
  loadConfiguration: loadApplicationConfiguration,
  resolveConfigurationPaths,
  saveConfiguration,
} = require('../../dist/src/config/configuration.js');
const { generateAliases } = require('../components/alias-engine');
const { readMessengerMessages } = require('../../dist/src/messages/backread.js');
const { createContextStore } = require('../components/context-store');

const NOTIFICATION_DIALOG_NAME = 'Push notifications request';
const PIN_DIALOG_HEADING = 'Enter your PIN to restore your chats';
const REJECTION_MESSAGE = 'Incorrect PIN. Try again.';
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
const PIN_INPUT_SELECTOR =
  'input[aria-label="PIN"], input[autocomplete="one-time-code"], input[maxlength="6"]';
const CONFIRMATION_DIALOG_SELECTOR =
  '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]';
const SKIP_RESTORATION_BUTTON_SELECTOR =
  '[aria-label="Don\'t restore messages"][role="button"]';
const WAIT_TIMEOUT = 20000;
const LOGIN_WAIT_TIMEOUT = 1800000;
const PIN_PROMPT_TIMEOUT = 8000;
const NOTIFICATION_DISMISS_TIMEOUT = 10000;
const CONNECTION_TIMEOUT = 10000;

function loadExperimentConfiguration() {
  const configurationFilePath = resolveConfigurationPaths().filePath;
  const result = loadApplicationConfiguration(configurationFilePath);
  if (result.status === 'missing') {
    throw new Error('Configuration file was not found.');
  }
  if (result.status === 'malformed') {
    throw new Error(`Configuration is malformed: ${result.message}`);
  }
  if (result.status === 'unsupported-version') {
    throw new Error(`Configuration schema version ${result.version} is not supported.`);
  }
  if (result.status === 'pin-required') {
    throw new Error('Configuration requires PIN reconfiguration before it can be used.');
  }

  const configuration = result.configuration;
  if (!Number.isInteger(configuration.cdpPort) ||
      configuration.cdpPort < 1 || configuration.cdpPort > 65535) {
    throw new Error('The configured CDP port is missing or invalid.');
  }
  if (!configuration.messageDestination) {
    throw new Error('Configuration is missing its Messenger destination.');
  }

  const destinationUrl = new URL(configuration.messageDestination);
  const isFacebookDestination = destinationUrl.hostname === 'facebook.com' ||
    destinationUrl.hostname.endsWith('.facebook.com');
  const expectedConversationId = getConversationId(destinationUrl);
  if (!isFacebookDestination || !expectedConversationId) {
    throw new Error('The configured message destination does not identify a Messenger conversation.');
  }

  return {
    configuration,
    configurationFilePath,
    destinationUrl,
    expectedConversationId,
  };
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

function isValidPuppetName(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

async function retrievePuppetName(page) {
  const profileButton = page.getByRole('button', { name: 'Your profile', exact: true });
  if (await profileButton.count() !== 1 || !await profileButton.isVisible() ||
      !await profileButton.isEnabled()) {
    throw new Error('The visible Your profile button was not uniquely available.');
  }

  try {
    await profileButton.click();
    const profileDialog = page.getByRole('dialog', { name: 'Your profile', exact: true });
    await profileDialog.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const profileLink = profileDialog.locator('a[href="/me/"]');
    if (await profileLink.count() !== 1 || !await profileLink.isVisible() ||
        await profileLink.getAttribute('href') !== '/me/') {
      throw new Error('The /me/ link was not uniquely available in the profile dialog.');
    }

    const puppetName = (await profileLink.innerText()).trim();
    if (!isValidPuppetName(puppetName)) {
      throw new Error('The profile dialog did not contain a valid displayed account name.');
    }
    return puppetName;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

function describePersistedPuppetName(value) {
  if (value === undefined) {
    return 'not set';
  }
  return isValidPuppetName(value) ? JSON.stringify(value) : 'invalid or unavailable';
}

async function updatePuppetName(page, configuration, configurationFilePath) {
  let puppetName;
  try {
    puppetName = await retrievePuppetName(page);
  } catch (error) {
    return {
      status: 'retrieval-failed',
      error: error instanceof Error ? error.message : 'Unknown retrieval error.',
      persistedName: configuration.puppetName,
    };
  }

  try {
    const savedConfiguration = saveConfiguration(
      { ...configuration, puppetName },
      configurationFilePath,
    );
    configuration.puppetName = savedConfiguration.puppetName;
    return { status: 'saved', puppetName, persistedName: savedConfiguration.puppetName };
  } catch (error) {
    let persistedName = configuration.puppetName;
    let persistedNameVerified = true;
    try {
      const result = loadApplicationConfiguration(configurationFilePath);
      if (result.status !== 'valid') {
        throw new Error('Saved configuration could not be loaded.');
      }
      persistedName = result.configuration.puppetName;
    } catch {
      persistedNameVerified = false;
    }
    return {
      status: 'save-failed',
      puppetName,
      persistedName,
      persistedNameVerified,
      error: error instanceof Error ? error.message : 'Unknown configuration save error.',
    };
  }
}

function reportPuppetNameResult(result) {
  if (result.status === 'saved') {
    console.log(
      `Puppet account name retrieved: ${JSON.stringify(result.puppetName)}; ` +
      'config field puppetName updated and saved.'
    );
    return;
  }
  if (result.status === 'retrieval-failed') {
    console.log(
      `Puppet account name retrieval failed: ${result.error}. ` +
      `Config unchanged; persisted puppetName: ${describePersistedPuppetName(result.persistedName)}.`
    );
    return;
  }
  console.log(`Puppet account name retrieved: ${JSON.stringify(result.puppetName)}.`);
  console.log(
    `Config save failed: ${result.error}. Persisted puppetName: ` +
    `${result.persistedNameVerified
      ? describePersistedPuppetName(result.persistedName)
      : 'could not be verified'}.`
  );
}

async function areLoginIndicatorsVisible(indicators) {
  return (await Promise.all(indicators.map(indicator => indicator.isVisible()))).every(Boolean);
}

async function waitForSuccessLogin(pages) {
  const indicatorsByPage = pages.map(candidate => [
    candidate.getByRole('heading', { name: 'Create a post', exact: true }),
    candidate.locator('[role="region"][aria-label="Create a post"]'),
    candidate.getByRole('button', { name: 'Messenger', exact: true }),
  ].map(indicator => indicator.filter({ visible: true }).first()));
  const deadline = Date.now() + LOGIN_WAIT_TIMEOUT;
  const inspectionErrors = new Map();

  while (true) {
    let inspectedPageCount = 0;
    for (let index = 0; index < indicatorsByPage.length; index += 1) {
      try {
        const indicators = indicatorsByPage[index];
        if (await areLoginIndicatorsVisible(indicators) &&
            await areLoginIndicatorsVisible(indicators)) {
          return;
        }
        inspectionErrors.delete(pages[index]);
        inspectedPageCount += 1;
      } catch (error) {
        inspectionErrors.set(pages[index], error);
      }
    }

    if (inspectedPageCount === 0) {
      const details = [...inspectionErrors.values()]
        .map(error => error instanceof Error ? error.message : String(error))
        .join('; ');
      throw new Error(
        `Login detection could not confirm authentication across Facebook tabs: ${details}`,
      );
    }

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      throw new Error(
        'Login detection timed out before all three visible Facebook indicators appeared.'
      );
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingTime)));
  }
}

function getFacebookPages(browser) {
  return browser.contexts()
    .flatMap(context => context.pages())
    .filter(page => !page.isClosed() && getFacebookUrl(page));
}

function selectFacebookPage(facebookPages, expectedConversationId) {
  const candidates = facebookPages.map(page => ({ page, url: getFacebookUrl(page) }));

  if (candidates.length === 0) {
    throw new Error(
      'No existing Facebook tab was found in Brave. Open Facebook in Brave and try again.'
    );
  }

  const exactTargetPages = expectedConversationId
    ? candidates.filter(candidate => getConversationId(candidate.url) === expectedConversationId)
    : [];
  if (exactTargetPages.length === 1) {
    return exactTargetPages[0].page;
  }
  if (exactTargetPages.length > 1) {
    throw new Error(
      `Found ${exactTargetPages.length} tabs already on the target conversation; ` +
      'cannot choose one reliably.'
    );
  }

  const messengerPages = candidates.filter(candidate =>
    /^\/messages(?:\/|$)/.test(candidate.url.pathname)
  );
  if (messengerPages.length === 1) {
    return messengerPages[0].page;
  }
  if (messengerPages.length > 1) {
    throw new Error(
      `Found ${messengerPages.length} Messenger tabs and none is on the target ` +
      'conversation; cannot choose one reliably.'
    );
  }

  if (candidates.length === 1) {
    return candidates[0].page;
  }

  throw new Error('Multiple Facebook tabs were found and none is a unique Messenger tab.');
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

async function waitForPinOutcome(page, pinDialog, timeoutMs) {
  const waitFor = (locator, state, outcome) => locator.waitFor({ state, timeout: timeoutMs })
    .then(() => outcome)
    .catch(() => null);

  return Promise.race([
    waitFor(pinDialog, 'hidden', 'dismissed'),
    waitFor(page.getByText(REJECTION_MESSAGE, { exact: true }), 'visible', 'rejected'),
    waitFor(page.locator(CONFIRMATION_DIALOG_SELECTOR), 'visible', 'skip-confirmation'),
  ]);
}

async function handlePinRestoration(page, pinDialog, configuration) {
  if (!configuration.skipPinRestoration) {
    if (!configuration.pin) {
      throw new Error('Messenger PIN restoration is enabled, but no PIN is configured.');
    }

    const pinInputs = pinDialog.locator(PIN_INPUT_SELECTOR).filter({ visible: true });
    if (await pinInputs.count() !== 1 || !await pinInputs.first().isEnabled()) {
      throw new Error('Could not identify one enabled PIN input in the restoration dialog.');
    }

    console.log('Challenge 1: entering the configured PIN to restore chats.');
    const pinInput = pinInputs.first();
    await pinInput.fill(configuration.pin, { timeout: 5000 });
    let outcome = await waitForPinOutcome(page, pinDialog, 2000);
    if (outcome === 'rejected' ||
        await page.getByText(REJECTION_MESSAGE, { exact: true }).isVisible()) {
      throw new Error(`The configured Messenger PIN was rejected: "${REJECTION_MESSAGE}"`);
    }
    if (outcome === 'skip-confirmation') {
      throw new Error('A skip-restoration confirmation appeared while submitting the configured PIN.');
    }
    if (outcome !== 'dismissed' && await pinDialog.isVisible()) {
      await pinInput.press('Enter', { timeout: 5000 });
      outcome = await waitForPinOutcome(page, pinDialog, PIN_PROMPT_TIMEOUT + WAIT_TIMEOUT);
    }
    if (outcome === 'rejected' ||
        await page.getByText(REJECTION_MESSAGE, { exact: true }).isVisible()) {
      throw new Error(`The configured Messenger PIN was rejected: "${REJECTION_MESSAGE}"`);
    }
    if (outcome !== 'dismissed' || await pinDialog.isVisible()) {
      throw new Error('The Messenger PIN restoration dialog did not disappear.');
    }
  } else {
    console.log('Challenge 1: PIN restoration is disabled; skipping restoration.');
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

  console.log(`Challenge 1: confirmation dialog disappeared: ${confirmationDisappeared ? 'yes' : 'no'}.`);
  console.log(`Challenge 1: PIN dialog remains visible: ${pinDialogRemainsVisible ? 'yes' : 'no'}.`);
  if (!confirmationDisappeared || pinDialogRemainsVisible) {
    throw new Error('PIN-restoration skip did not complete successfully.');
  }
  }

  if ((await findVisiblePinDialogs(page)).length > 0) {
    throw new Error('A Messenger PIN restoration dialog remains visible.');
  }
}

async function waitForTargetConversation(page, expectedConversationId) {
  try {
    await page.waitForFunction(
      expectedId => {
        const url = new URL(window.location.href);
        const currentId = url.pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1];
        return expectedId ? currentId === expectedId : Boolean(currentId);
      },
      expectedConversationId,
      { timeout: WAIT_TIMEOUT },
    );
  } catch {
    throw new Error(expectedConversationId
      ? `The page did not settle on conversation ${expectedConversationId}.`
      : 'The page did not settle on a Messenger conversation.');
  }
}

async function verifyTargetConversation(page, expectedConversationId, pinWasSkipped) {
  const visibleComposers = page.locator(
    '[role="textbox"][contenteditable="true"]:visible'
  );
  const composerCount = await visibleComposers.count();
  if (composerCount === 0 || !await visibleComposers.first().isEnabled()) {
    throw new Error('The conversation composer is not ready.');
  }
  const remainingPinDialogs = await findVisiblePinDialogs(page);
  if (remainingPinDialogs.length > 0) {
    throw new Error('A PIN restoration dialog is still visible; skip is incomplete.');
  }
  if (await page.locator(CONFIRMATION_DIALOG_SELECTOR).isVisible() ||
      await page.locator(SKIP_RESTORATION_BUTTON_SELECTOR).filter({ visible: true }).count() > 0) {
    throw new Error('A skip-restoration state is visible; restoration did not complete.');
  }
  if (await page.getByText(REJECTION_MESSAGE, { exact: true }).isVisible()) {
    throw new Error(`The PIN was rejected: "${REJECTION_MESSAGE}"`);
  }
  if (await page.getByRole('alertdialog', {
    name: NOTIFICATION_DIALOG_NAME,
    exact: true,
  }).isVisible()) {
    throw new Error('The push-notification dialog remains visible; startup is incomplete.');
  }

  const currentUrl = getFacebookUrl(page);
  const currentConversationId = currentUrl && getConversationId(currentUrl);
  if (page.isClosed() || !currentConversationId ||
      expectedConversationId && currentConversationId !== expectedConversationId) {
    throw new Error('The final URL is not the configured Facebook conversation.');
  }

  console.log(`Final conversation ID verified (${currentConversationId}).`);
  console.log(`Conversation composer is ready (${composerCount} visible).`);
  console.log(pinWasSkipped
    ? 'SUCCESS: PIN restoration was skipped and the target conversation is ready.'
    : 'SUCCESS: the target conversation is ready.');
}

async function main() {
  const {
    configuration,
    configurationFilePath,
    destinationUrl,
    expectedConversationId,
  } = loadExperimentConfiguration();
  const cdpEndpoint = `http://127.0.0.1:${configuration.cdpPort}`;
  let browser;
  let loginReady = false;
  let pinRestorationRequested = false;
  let pinRestorationSkipped = false;
  let targetConversationReady = false;
  try {
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint, {
        isLocal: true,
        noDefaults: true,
        timeout: CONNECTION_TIMEOUT,
      });
    } catch {
      throw new Error(
        `Could not connect to the configured browser at ${cdpEndpoint}. Ensure it is ` +
        'running with remote debugging enabled on this address and port.'
      );
    }
    if (!browser.isConnected()) {
      throw new Error('Playwright connected to CDP but reports the browser disconnected.');
    }

    let facebookPages = getFacebookPages(browser);
    if (facebookPages.length === 0) {
      const contexts = browser.contexts();
      const existingPages = contexts.flatMap(context => context.pages());
      const blankPage = existingPages.find(candidate => {
        if (candidate.isClosed()) {
          return false;
        }
        const url = candidate.url();
        return url === 'about:blank' || /^(?:chrome|brave|edge):\/\/newtab\/?$/i.test(url);
      });
      const context = contexts[0];
      if (!blankPage && !context) {
        throw new Error('No browser context is available for the Facebook startup page.');
      }
      if (!configuration.startupUrl) {
        throw new Error('Configuration is missing its startup URL.');
      }
      const startupPage = blankPage ?? await context.newPage();
      await startupPage.goto(configuration.startupUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      facebookPages = getFacebookPages(browser);
    }

    const page = selectFacebookPage(facebookPages, expectedConversationId);
    console.log(`Step 1: selected existing Facebook tab (${page.url()}).`);
    const currentUrl = getFacebookUrl(page);
    const alreadyAtDestination = Boolean(destinationUrl && currentUrl &&
      currentUrl.origin === destinationUrl.origin &&
      getConversationId(currentUrl) === expectedConversationId);
    if (alreadyAtDestination) {
      loginReady = true;
      console.log('Configured conversation is already selected; skipping login wait and navigation.');
    } else {
      console.log('Step 2: waiting for visible login indicators on a Facebook tab.');
      await waitForSuccessLogin(facebookPages);
      loginReady = true;
      console.log('Login detection succeeded.');
    }

    if (destinationUrl && !alreadyAtDestination) {
      console.log(`Step 3: navigating to ${destinationUrl.href}.`);
      await page.goto(configuration.messageDestination, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } else {
      console.log(destinationUrl
        ? 'Step 3: destination already selected; keeping the existing page.'
        : 'Step 3: no message destination is configured; keeping the existing page.');
    }

    console.log('Step 4: verifying the target conversation.');
    await waitForTargetConversation(page, expectedConversationId);
    const visibleComposers = page.locator(
      '[role="textbox"][contenteditable="true"]:visible'
    );
    try {
      await visibleComposers.first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    } catch {
      throw new Error('A visible conversation composer did not become available.');
    }

    await dismissNotificationDialog(page);

    const pinHeading = page.getByRole('heading', {
      name: PIN_DIALOG_HEADING,
      exact: true,
    });
    try {
      await pinHeading.waitFor({ state: 'visible', timeout: PIN_PROMPT_TIMEOUT });
    } catch {
      console.log('Step 3: no PIN restoration prompt appeared; verifying the conversation state.');
    }

    const pinDialogs = await findVisiblePinDialogs(page);
    pinRestorationRequested = pinDialogs.length > 0 || await pinHeading.isVisible();
    if (pinDialogs.length > 1) {
      throw new Error(`Expected at most one visible PIN dialog, found ${pinDialogs.length}.`);
    }
    if (pinDialogs.length === 1) {
      console.log('Step 3: expected PIN restoration prompt found.');
      await handlePinRestoration(page, pinDialogs[0], configuration);
      pinRestorationSkipped = configuration.skipPinRestoration;
    } else if (await pinHeading.isVisible()) {
      throw new Error('The PIN heading is visible, but not inside one identifiable modal dialog.');
    }

    console.log('Step 5: waiting for the conversation to finish loading.');
    await verifyTargetConversation(page, expectedConversationId, pinRestorationSkipped);
    targetConversationReady = true;
    const puppetNameResult = await updatePuppetName(
      page,
      configuration,
      configurationFilePath,
    );
    reportPuppetNameResult(puppetNameResult);
    if (!isValidPuppetName(configuration.puppetName)) {
      throw new Error('A valid configured puppetName is required to initialize the alias engine.');
    }

    const aliasData = generateAliases(configuration.puppetName);
    console.log(
      `Alias engine initialized for puppet name ${JSON.stringify(configuration.puppetName)} ` +
      `(${aliasData.valids.length} aliases).`
    );

    const backread = await readMessengerMessages(page);
    for (const diagnostic of backread.diagnostics) {
      console.log(diagnostic);
    }
    const contextStore = createContextStore();
    contextStore.add(backread.messages.map(message => ({
      messageId: message.id,
      message: message.message,
    })));
    console.log(
      `Historical context seeded: ${contextStore.getState().size} messages from ` +
      `production Backread (${backread.messages.length} collected).`
    );
    console.log('Engine ready.');
  } finally {
    console.log(`Login ready: ${loginReady ? 'yes' : 'no'}.`);
    console.log(`PIN restoration requested: ${pinRestorationRequested ? 'yes' : 'no'}.`);
    console.log(`Target conversation ready: ${targetConversationReady ? 'yes' : 'no'}.`);
    if (browser) {
      await browser.close();
      console.log('Playwright disconnected; the external Brave browser was not launched or closed.');
    }
  }
}

main().catch(error => {
  console.error(`Playwright engine-cranking experiment failed: ${error.message}`);
  process.exitCode = 1;
});