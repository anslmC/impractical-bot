import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import { chromium, type Browser, type ConnectOverCDPOptions, type Locator, type Page } from 'playwright';
import { validateConfiguration, type Configuration } from '../config/configuration.js';

export interface BrowserProcessHandle {
  readonly pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  unref(): void;
}

export interface BrowserLaunchFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

export interface BrowserLaunchOptions {
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  connectionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  loginTimeoutMs?: number;
  pinPromptTimeoutMs?: number;
  readinessTimeoutMs?: number;
  fileSystem?: BrowserLaunchFileSystem;
  spawnProcess?: (
    executablePath: string,
    args: string[],
    options: SpawnOptions,
  ) => BrowserProcessHandle;
  connectOverCDP?: (
    endpoint: string,
    options: ConnectOverCDPOptions,
  ) => Promise<Browser>;
  findProfileProcesses?: (executablePath: string, profilePath: string) => Promise<number[]>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserCloseOptions {
  platform?: NodeJS.Platform;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  findProfileProcesses?: (executablePath: string, profilePath: string) => Promise<number[]>;
  requestProcessClose?: (processIds: number[]) => Promise<void>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserNavigationOptions {
  platform?: NodeJS.Platform;
  connectionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  findProfileProcesses?: (executablePath: string, profilePath: string) => Promise<number[]>;
  connectOverCDP?: (
    endpoint: string,
    options: ConnectOverCDPOptions,
  ) => Promise<Browser>;
}

export interface BrowserLaunchSession {
  endpoint: string;
  browserVersion: string;
  disconnected: Promise<void>;
  prepare(): Promise<void>;
  disconnect(): Promise<void>;
}

interface ChildState {
  exited: boolean;
  failure?: Error;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const defaultFileSystem: BrowserLaunchFileSystem = { mkdir };

function findProfileProcesses(executablePath: string, profilePath: string): Promise<number[]> {
  const script = `
$ErrorActionPreference = 'Stop'
$profile = $env:IMPBOT_PROFILE_PATH.TrimEnd([char]92)
$needle = '--user-data-dir=' + $profile
$comparison = [System.StringComparison]::OrdinalIgnoreCase
$matchingProcessIds = @(Get-CimInstance Win32_Process -Filter "Name='$env:IMPBOT_BROWSER_NAME'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  $index = $commandLine.IndexOf($needle, $comparison)
  if ($index -lt 0 -or -not [System.String]::Equals($_.ExecutablePath, $env:IMPBOT_BROWSER_PATH, $comparison)) {
    return $false
  }
  $end = $index + $needle.Length
  $end -eq $commandLine.Length -or [char]::IsWhiteSpace($commandLine[$end]) -or $commandLine[$end] -eq '"' -or $commandLine[$end] -eq [char]92
} | ForEach-Object { [int]$_.ProcessId })
if ($matchingProcessIds.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $matchingProcessIds -Compress }
`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          IMPBOT_BROWSER_NAME: win32.basename(executablePath),
          IMPBOT_BROWSER_PATH: executablePath,
          IMPBOT_PROFILE_PATH: profilePath,
        },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Unable to check whether the configured browser profile is already in use.', {
            cause: error,
          }));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
          const processIds = Array.isArray(parsed) ? parsed : [parsed];
          if (!processIds.every(processId => Number.isInteger(processId) && processId > 0)) {
            throw new Error('Browser profile process query returned invalid process IDs.');
          }
          resolve(processIds as number[]);
        } catch (error) {
          reject(new Error('Unable to parse the browser profile process query result.', { cause: error }));
        }
      },
    );
  });
}

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.once('connect', () => finish(new Error(`CDP port ${port} is already in use; refusing to attach.`)));
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        finish();
      } else {
        finish(new Error(`Unable to verify that CDP port ${port} is available.`, { cause: error }));
      }
    });
    socket.setTimeout(1_000);
    socket.once('timeout', () => finish(new Error(`Timed out checking whether CDP port ${port} is available.`)));
  });
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requestWindowsProcessClose(processIds: number[]): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$processIds = $env:IMPBOT_PROCESS_IDS.Split(',') | ForEach-Object { [int]$_ }
$requested = $false
foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    if (-not $process.CloseMainWindow()) {
      throw "Process $processId did not accept a graceful close request."
    }
    $requested = $true
  }
}
if (-not $requested) { throw 'No dedicated browser window accepted a graceful close request.' }
`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, IMPBOT_PROCESS_IDS: processIds.join(',') },
      },
      error => error
        ? reject(new Error('Unable to request graceful browser shutdown.', { cause: error }))
        : resolve(),
    );
  });
}

export async function closeConfiguredBrowser(
  configuration: Configuration,
  options: BrowserCloseOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser closing is not supported on '${platform}'.`);
  }

  const validatedConfiguration = validateConfiguration(configuration);
  const getProfileProcesses = options.findProfileProcesses ?? findProfileProcesses;
  const processIds = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (processIds.length === 0) {
    return;
  }

  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (shutdownTimeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error('Browser shutdown and polling timeouts must be positive.');
  }

  await (options.requestProcessClose ?? requestWindowsProcessClose)(processIds);

  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const deadline = now() + shutdownTimeoutMs;
  while (now() <= deadline) {
    const remainingProcesses = await getProfileProcesses(
      validatedConfiguration.executablePath,
      validatedConfiguration.profilePath,
    );
    if (remainingProcesses.length === 0) {
      return;
    }
    const remainingTime = deadline - now();
    if (remainingTime <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remainingTime));
  }

  throw new Error('Timed out waiting for the dedicated browser to shut down gracefully.');
}

function isFacebookUrl(url: URL): boolean {
  return url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com');
}

function conversationId(url: URL): string | null {
  return url.pathname.match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1] ?? null;
}

const LOGIN_INDICATORS = [
  (page: Page) => page.getByRole('heading', { name: 'Create a post', exact: true }),
  (page: Page) => page.locator('[role="region"][aria-label="Create a post"]'),
  (page: Page) => page.getByRole('button', { name: 'Messenger', exact: true }),
];
const NOTIFICATION_DIALOG_NAME = 'Push notifications request';
const PIN_DIALOG_HEADING = 'Enter your PIN to restore your chats';
const PIN_INPUT_SELECTOR =
  'input[aria-label="PIN"], input[autocomplete="one-time-code"], input[maxlength="6"]';
const PIN_REJECTION_MESSAGE = 'Incorrect PIN. Try again.';
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
const PIN_CONFIRMATION_SELECTOR =
  '[role="dialog"][aria-modal="true"][aria-label="Continue without restoring?"]';
const SKIP_RESTORATION_SELECTOR = '[aria-label="Don\'t restore messages"][role="button"]';
const DEFAULT_LOGIN_TIMEOUT_MS = 1_800_000;
const DEFAULT_PIN_PROMPT_TIMEOUT_MS = 8_000;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;

async function areLoginIndicatorsVisible(indicators: Locator[]): Promise<boolean> {
  return (await Promise.all(indicators.map(indicator => indicator.isVisible()))).every(Boolean);
}

async function waitForSuccessLogin(pages: Page[], timeoutMs: number): Promise<void> {
  const indicatorsByPage = pages.map(page => LOGIN_INDICATORS.map(createIndicator =>
    createIndicator(page).filter({ visible: true }).first()));
  const deadline = Date.now() + timeoutMs;
  const inspectionErrors = new Map<Page, unknown>();

  while (true) {
    let inspectedPageCount = 0;
    for (let index = 0; index < indicatorsByPage.length; index += 1) {
      try {
        const indicators = indicatorsByPage[index];
        if (await areLoginIndicatorsVisible(indicators) && await areLoginIndicatorsVisible(indicators)) {
          return;
        }
        inspectionErrors.delete(pages[index]);
        inspectedPageCount += 1;
      } catch (error) {
        inspectionErrors.set(pages[index], error);
      }
    }

    if (inspectedPageCount === 0) {
      const errors = [...inspectionErrors.values()];
      const details = errors.map(item => item instanceof Error ? item.message : String(item)).join('; ');
      throw new Error(`Login detection could not confirm authentication across Facebook tabs: ${details}`, {
        cause: new AggregateError(errors, 'Facebook login detection failed on every candidate tab.'),
      });
    }

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      const details = [...inspectionErrors.values()]
        .map(item => item instanceof Error ? item.message : String(item)).join('; ');
      const suffix = details ? ` Some Facebook tabs could not be inspected: ${details}` : '';
      throw new Error(
        `Login detection timed out before all three visible Facebook indicators appeared.${suffix}`,
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remainingTime)));
  }
}

async function findVisiblePinDialogs(page: Page): Promise<Locator[]> {
  const dialogs = page.locator(MODAL_DIALOG_SELECTOR);
  const pinDialogs: Locator[] = [];
  for (let index = 0; index < await dialogs.count(); index += 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible()) {
      continue;
    }
    const headingCount = await dialog.getByRole('heading', {
      name: PIN_DIALOG_HEADING,
      exact: true,
    }).filter({ visible: true }).count();
    if (headingCount === 1) {
      pinDialogs.push(dialog);
    }
  }
  return pinDialogs;
}

async function waitForPinOutcome(
  page: Page,
  pinDialog: Locator,
  timeoutMs: number,
): Promise<'dismissed' | 'rejected' | 'skip-confirmation' | null> {
  const waitFor = (
    locator: Locator,
    state: 'visible' | 'hidden',
    outcome: 'dismissed' | 'rejected' | 'skip-confirmation',
  ) => locator.waitFor({ state, timeout: timeoutMs }).then(() => outcome).catch(() => null);

  return Promise.race([
    waitFor(pinDialog, 'hidden', 'dismissed'),
    waitFor(page.getByText(PIN_REJECTION_MESSAGE, { exact: true }), 'visible', 'rejected'),
    waitFor(page.locator(PIN_CONFIRMATION_SELECTOR), 'visible', 'skip-confirmation'),
  ]);
}

async function closePinDialogForSkip(pinDialog: Locator): Promise<void> {
  const closeButtons = pinDialog.locator('[aria-label="Close"][role="button"]');
  const closeCount = await closeButtons.count();
  let closeButton: Locator | undefined;
  for (let index = 0; index < closeCount; index += 1) {
    const candidate = closeButtons.nth(index);
    if (await candidate.isVisible() && await candidate.isEnabled()) {
      closeButton = candidate;
      break;
    }
  }
  if (!closeButton) {
    throw new Error('Could not identify one enabled Close control for the PIN restoration dialog.');
  }
  await closeButton.evaluate(element => (element as HTMLElement).click(), undefined, { timeout: 5_000 });
}

async function handlePinRestoration(
  page: Page,
  pinDialog: Locator,
  configuration: Configuration,
  pinPromptTimeoutMs: number,
): Promise<void> {
  if (configuration.skipPinRestoration) {
    console.log('Challenge 1: PIN restoration is disabled; skipping restoration.');
    await closePinDialogForSkip(pinDialog);
    const confirmation = page.locator(PIN_CONFIRMATION_SELECTOR);
    await confirmation.waitFor({ state: 'visible', timeout: pinPromptTimeoutMs });
    if (!await confirmation.isVisible()) {
      throw new Error('The PIN skip confirmation dialog is not visible.');
    }

    const skipButtons = confirmation.locator(SKIP_RESTORATION_SELECTOR);
    const skipCount = await skipButtons.count();
    let skipButton: Locator | undefined;
    for (let index = 0; index < skipCount; index += 1) {
      const candidate = skipButtons.nth(index);
      if (await candidate.isVisible() && await candidate.isEnabled()) {
        skipButton = candidate;
        break;
      }
    }
    if (!skipButton) {
      throw new Error('Could not identify one enabled skip-restoration control in the confirmation dialog.');
    }
    await skipButton.evaluate(element => (element as HTMLElement).click(), undefined, { timeout: 5_000 });

    let confirmationDisappeared = false;
    try {
      await confirmation.waitFor({ state: 'hidden', timeout: pinPromptTimeoutMs });
      confirmationDisappeared = !await confirmation.isVisible();
    } catch {
      // Report unsuccessful dismissal below.
    }
    if (!confirmationDisappeared) {
      throw new Error('The PIN skip confirmation dialog did not disappear.');
    }
  } else {
    if (!configuration.pin) {
      throw new Error('Messenger PIN restoration is enabled, but no PIN is configured.');
    }
    const pinInputs = pinDialog.locator(PIN_INPUT_SELECTOR).filter({ visible: true });
    if (await pinInputs.count() !== 1 || !await pinInputs.first().isEnabled()) {
      throw new Error('Could not identify one enabled PIN input in the restoration dialog.');
    }

    const pinInput = pinInputs.first();
  console.log('Challenge 1: entering the configured PIN to restore chats.');
    await pinInput.fill(configuration.pin, { timeout: 5_000 });
    let outcome = await waitForPinOutcome(page, pinDialog, 2_000);
    if (outcome === 'rejected' || await page.getByText(PIN_REJECTION_MESSAGE, { exact: true }).isVisible()) {
      throw new Error(`The configured Messenger PIN was rejected: "${PIN_REJECTION_MESSAGE}"`);
    }
    if (outcome === 'skip-confirmation') {
      throw new Error('A skip-restoration confirmation appeared while submitting the configured PIN.');
    }
    if (outcome !== 'dismissed' && await pinDialog.isVisible()) {
      await pinInput.press('Enter', { timeout: 5_000 });
      outcome = await waitForPinOutcome(page, pinDialog, pinPromptTimeoutMs + DEFAULT_READINESS_TIMEOUT_MS);
    }
    if (outcome === 'rejected' || await page.getByText(PIN_REJECTION_MESSAGE, { exact: true }).isVisible()) {
      throw new Error(`The configured Messenger PIN was rejected: "${PIN_REJECTION_MESSAGE}"`);
    }
    if (outcome !== 'dismissed' || await pinDialog.isVisible()) {
      throw new Error('The Messenger PIN restoration dialog did not disappear.');
    }
  }

  if ((await findVisiblePinDialogs(page)).length > 0) {
    throw new Error('A Messenger PIN restoration dialog remains visible.');
  }
}

async function dismissNotificationDialog(page: Page): Promise<void> {
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

  try {
    await closeButton.click({ timeout: 5_000 });
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  } catch (error) {
    throw new Error('The push-notification dialog could not be dismissed.', { cause: error });
  }
  if (await dialog.isVisible()) {
    throw new Error('The push-notification dialog remains visible after clicking Close.');
  }
  console.log('Challenge 0: notification dialog dismissed.');
}

async function waitForConfiguredConversation(
  page: Page,
  expectedConversationId: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      expectedId => new URL(window.location.href).pathname
        .match(/^\/messages\/t\/(\d+)(?:\/|$)/)?.[1] === expectedId,
      expectedConversationId,
      { timeout: timeoutMs },
    );
  } catch {
    throw new Error(`The page did not settle on conversation ${expectedConversationId}.`);
  }
}

export async function prepareConfiguredBrowser(
  browser: Browser,
  configuration: Configuration,
  options: BrowserLaunchOptions = {},
): Promise<void> {
  const validatedConfiguration = validateConfiguration(configuration);
  if (!validatedConfiguration.messageDestination) {
    throw new Error('Configuration is missing its message destination. Run `impbot init` to update it.');
  }
  if (!browser.isConnected()) {
    throw new Error('The configured browser disconnected before startup preparation.');
  }
  const destinationUrl = new URL(validatedConfiguration.messageDestination);
  if (!isFacebookUrl(destinationUrl)) {
    throw new Error('Message destination must be on Facebook.');
  }
  const expectedConversationId = conversationId(destinationUrl);
  if (!expectedConversationId) {
    throw new Error('Message destination must identify a Messenger conversation.');
  }

  let facebookPages = getFacebookPages(browser);
  if (facebookPages.length === 0) {
    const contexts = browser.contexts();
    const existingPages = contexts.flatMap(context => context.pages());
    const blankPage = existingPages.find(page => {
      if (page.isClosed()) {
        return false;
      }
      const url = page.url();
      return url === 'about:blank' || /^(?:chrome|brave|edge):\/\/newtab\/?$/i.test(url);
    });
    const context = contexts[0];
    if (!blankPage && !context) {
      throw new Error('No browser context is available for the Facebook startup page.');
    }
    const startupPage = blankPage ?? await context!.newPage();
    if (!validatedConfiguration.startupUrl) {
      throw new Error('Configuration is missing its startup URL. Run `impbot init` to update it.');
    }
    await startupPage.goto(validatedConfiguration.startupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs ?? 30_000,
    });
    facebookPages = getFacebookPages(browser);
  }
  const page = selectFacebookPage(facebookPages, destinationUrl);
  const currentPageUrl = new URL(page.url());
  const alreadyAtConfiguredConversation = isFacebookUrl(currentPageUrl) &&
    currentPageUrl.origin === destinationUrl.origin &&
    conversationId(currentPageUrl) === expectedConversationId;
  if (!alreadyAtConfiguredConversation) {
    await waitForSuccessLogin(facebookPages, options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  }
  await page.goto(destinationUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: options.navigationTimeoutMs ?? 30_000,
  });
  await waitForConfiguredConversation(
    page,
    expectedConversationId,
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
  );
  console.log(`Configured conversation ${expectedConversationId} verified after navigation.`);

  const composers = page.locator('[role="textbox"][contenteditable="true"]:visible');
  try {
    await composers.first().waitFor({
      state: 'visible',
      timeout: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    });
  } catch {
    throw new Error('A visible conversation composer did not become available.');
  }

  await dismissNotificationDialog(page);

  const pinHeading = page.getByRole('heading', { name: PIN_DIALOG_HEADING, exact: true });
  try {
    await pinHeading.filter({ visible: true }).waitFor({
      state: 'visible',
      timeout: options.pinPromptTimeoutMs ?? DEFAULT_PIN_PROMPT_TIMEOUT_MS,
    });
  } catch {
    // No restoration prompt is a valid path; final readiness checks still apply.
  }
  const pinDialogs = await findVisiblePinDialogs(page);
  if (pinDialogs.length > 1) {
    throw new Error(`Expected at most one visible Messenger PIN dialog, found ${pinDialogs.length}.`);
  }
  if (pinDialogs.length === 1) {
    await handlePinRestoration(
      page,
      pinDialogs[0],
      validatedConfiguration,
      options.pinPromptTimeoutMs ?? DEFAULT_PIN_PROMPT_TIMEOUT_MS,
    );
  } else if (await pinHeading.filter({ visible: true }).count() > 0) {
    throw new Error('The PIN heading is visible but is not inside one identifiable modal dialog.');
  } else {
    console.log(`Challenge 1: no visible PIN restoration dialog headed "${PIN_DIALOG_HEADING}"; continuing.`);
  }

  const notificationVisible = await page.getByRole('alertdialog', {
    name: NOTIFICATION_DIALOG_NAME,
    exact: true,
  }).isVisible();
  const remainingPinDialogs = await findVisiblePinDialogs(page);
  const pinDialogVisible = remainingPinDialogs.length > 0;
  const confirmationVisible = await page.locator(PIN_CONFIRMATION_SELECTOR).isVisible();
  if (notificationVisible || pinDialogVisible || confirmationVisible) {
    throw new Error(
      'A blocker remains visible; startup is incomplete ' +
      `(notification dialog: ${notificationVisible ? 'yes' : 'no'}, ` +
      `PIN restoration dialog: ${pinDialogVisible ? 'yes' : 'no'}, ` +
      `PIN skip-confirmation dialog: ${confirmationVisible ? 'yes' : 'no'}).`,
    );
  }
  console.log('Final verification: notification and PIN restoration dialogs are no longer visible.');

  if (await composers.count() === 0 || !await composers.first().isEnabled()) {
    throw new Error('The conversation composer is not ready.');
  }
  if (page.isClosed() || conversationId(new URL(page.url())) !== expectedConversationId) {
    throw new Error('The final page is not the configured Messenger conversation.');
  }
  console.log(`Final verification: configured conversation ${expectedConversationId} is still selected.`);
}

function getFacebookPages(browser: Browser): Page[] {
  return browser.contexts()
    .flatMap(context => context.pages())
    .filter(page => {
      if (page.isClosed()) {
        return false;
      }
      try {
        return isFacebookUrl(new URL(page.url()));
      } catch {
        return false;
      }
    });
}

function selectFacebookPage(facebookPages: Page[], destinationUrl: URL): Page {
  if (facebookPages.length === 0) {
    throw new Error('No existing Facebook tab was found in the configured browser.');
  }

  const destinationConversationId = conversationId(destinationUrl);
  if (destinationConversationId) {
    const matchingPages = facebookPages.filter(page => {
      try {
        return conversationId(new URL(page.url())) === destinationConversationId;
      } catch {
        return false;
      }
    });
    if (matchingPages.length === 1) {
      return matchingPages[0];
    }
    if (matchingPages.length > 1) {
      throw new Error('Multiple Facebook tabs already show the destination conversation.');
    }
  }

  const messengerPages = facebookPages.filter(page => {
    try {
      return /^\/messages(?:\/|$)/.test(new URL(page.url()).pathname);
    } catch {
      return false;
    }
  });
  if (messengerPages.length === 1) {
    return messengerPages[0];
  }
  if (messengerPages.length > 1) {
    throw new Error('Multiple Messenger tabs were found; cannot choose one reliably.');
  }
  if (facebookPages.length === 1) {
    return facebookPages[0];
  }

  throw new Error('Multiple Facebook tabs were found and none is a unique Messenger tab.');
}

export async function navigateConfiguredBrowserToMessageDestination(
  configuration: Configuration,
  destination: string,
  options: BrowserNavigationOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser navigation is not supported on '${platform}'.`);
  }

  const validatedConfiguration = validateConfiguration({
    ...configuration,
    messageDestination: destination,
  });
  if (validatedConfiguration.cdpPort === undefined) {
    throw new Error('Configuration is missing its CDP port. Run `impbot init` to update it.');
  }
  const destinationUrl = new URL(destination);
  if (!isFacebookUrl(destinationUrl)) {
    throw new Error('Message destination must be on Facebook.');
  }

  const getProfileProcesses = options.findProfileProcesses ?? findProfileProcesses;
  const processIds = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (processIds.length === 0) {
    throw new Error('The configured browser profile is not running; no browser was launched.');
  }

  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
  if (connectionTimeoutMs <= 0 || navigationTimeoutMs <= 0) {
    throw new Error('Browser connection and navigation timeouts must be positive.');
  }

  const connectOverCDP = options.connectOverCDP ?? ((endpoint, connectOptions) =>
    chromium.connectOverCDP(endpoint, connectOptions));
  const browser = await connectOverCDP(
    `http://127.0.0.1:${validatedConfiguration.cdpPort}`,
    { isLocal: true, noDefaults: true, timeout: connectionTimeoutMs },
  );

  try {
    if (!browser.isConnected()) {
      throw new Error('Playwright connected to CDP but reports the browser disconnected.');
    }

    const page = selectFacebookPage(getFacebookPages(browser), destinationUrl);
    const expectedConversationId = conversationId(destinationUrl);
    const currentUrl = new URL(page.url());
    if (expectedConversationId !== conversationId(currentUrl)) {
      await page.goto(destinationUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 5_000 });
    } catch {
      // Messenger may keep network activity open; verification below checks the settled page.
    }

    if (page.isClosed()) {
      throw new Error('The selected Facebook tab closed before navigation could be verified.');
    }

    let resultingUrl: URL;
    try {
      resultingUrl = new URL(page.url());
    } catch {
      throw new Error('The selected tab has an invalid URL after navigation.');
    }
    const resultingConversationId = conversationId(resultingUrl);
    const expectedPath = destinationUrl.pathname.replace(/\/$/, '') || '/';
    const resultingPath = resultingUrl.pathname.replace(/\/$/, '') || '/';
    const destinationReached = isFacebookUrl(resultingUrl) && (
      expectedConversationId
        ? resultingConversationId === expectedConversationId
        : resultingUrl.origin === destinationUrl.origin &&
          resultingPath === expectedPath &&
          (!destinationUrl.search || resultingUrl.search === destinationUrl.search)
    );
    const authenticationRedirect = /^\/(?:login(?:\.php)?|checkpoint)(?:\/|$)/.test(
      resultingUrl.pathname,
    );
    const pageContextVerified = expectedConversationId
      ? await page.getByRole('heading').filter({ visible: true }).count() > 0
      : await page.locator('body').isVisible();

    if (!destinationReached || authenticationRedirect || !pageContextVerified) {
      throw new Error('Navigation verification failed: the destination and rendered page context did not match.');
    }
  } finally {
    await browser.close();
  }
}

async function waitForEndpoint(
  port: number,
  childState: ChildState,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
  startupTimeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const endpointUrl = `http://127.0.0.1:${port}/json/version`;
  const deadline = now() + startupTimeoutMs;

  while (now() <= deadline) {
    if (childState.failure) {
      throw childState.failure;
    }
    if (childState.exited) {
      throw new Error('Browser process exited before its CDP endpoint became ready.');
    }

    try {
      const response = await fetch(endpointUrl, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) {
        throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
      }
      const result = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof result.webSocketDebuggerUrl !== 'string') {
        throw new Error('CDP endpoint did not return a browser WebSocket URL.');
      }
      const websocketUrl = new URL(result.webSocketDebuggerUrl);
      if (
        websocketUrl.protocol !== 'ws:' ||
        !['127.0.0.1', 'localhost'].includes(websocketUrl.hostname) ||
        websocketUrl.port !== String(port) ||
        !websocketUrl.pathname.startsWith('/devtools/browser/')
      ) {
        throw new Error('CDP endpoint returned a WebSocket URL outside the configured loopback endpoint.');
      }
      if (childState.exited) {
        throw new Error('Browser process exited before its CDP connection was accepted.');
      }
      return websocketUrl.href;
    } catch (error) {
      if (error instanceof Error && !('cause' in error) && /CDP endpoint/.test(error.message)) {
        throw error;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }

  if (childState.failure) {
    throw childState.failure;
  }
  if (childState.exited) {
    throw new Error('Browser process exited before its CDP endpoint became ready.');
  }
  throw new Error('Timed out waiting for the browser CDP endpoint.');
}

export async function launchConfiguredBrowser(
  configuration: Configuration,
  options: BrowserLaunchOptions = {},
): Promise<BrowserLaunchSession> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`Browser launching is not supported on '${platform}'.`);
  }

  const validatedConfiguration = validateConfiguration(configuration);
  if (validatedConfiguration.cdpPort === undefined || !validatedConfiguration.startupUrl) {
    throw new Error('Configuration is missing its CDP port or startup URL. Run `impbot init` to update it.');
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (startupTimeoutMs <= 0 || pollIntervalMs <= 0 || connectionTimeoutMs <= 0) {
    throw new Error('Browser startup, polling, and connection timeouts must be positive.');
  }

  const getProfileProcesses = options.findProfileProcesses ?? findProfileProcesses;
  const existingProcesses = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (existingProcesses.length > 0) {
    throw new Error(
      `Browser process(es) ${existingProcesses.join(', ')} already use the configured profile; refusing to launch another tab.`,
    );
  }
  await assertPortAvailable(validatedConfiguration.cdpPort);

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  await fileSystem.mkdir(validatedConfiguration.profilePath, { recursive: true });
  const spawnProcess = options.spawnProcess ?? ((executablePath, args, spawnOptions) =>
    spawn(executablePath, args, spawnOptions));
  const child = spawnProcess(
    validatedConfiguration.executablePath,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${validatedConfiguration.cdpPort}`,
      `--user-data-dir=${validatedConfiguration.profilePath}`,
    ],
    { detached: true, shell: false, windowsHide: false, stdio: 'ignore' },
  );
  const childState: ChildState = { exited: false };
  child.once('error', error => {
    childState.failure = error;
  });
  child.once('exit', () => {
    childState.exited = true;
  });
  child.unref();

  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const endpoint = await waitForEndpoint(
    validatedConfiguration.cdpPort,
    childState,
    now,
    delay,
    startupTimeoutMs,
    pollIntervalMs,
  );
  const ownerProcessIds = await getProfileProcesses(
    validatedConfiguration.executablePath,
    validatedConfiguration.profilePath,
  );
  if (child.pid === undefined || !ownerProcessIds.includes(child.pid) || childState.exited) {
    throw new Error('Unable to verify that the launched process owns the configured CDP endpoint; refusing to attach.');
  }

  const connectOverCDP = options.connectOverCDP ?? ((url, connectOptions) =>
    chromium.connectOverCDP(url, connectOptions));
  const browser = await connectOverCDP(endpoint, {
    isLocal: true,
    noDefaults: true,
    timeout: connectionTimeoutMs,
  });

  try {
    if (!browser.isConnected()) {
      throw new Error('Playwright completed the CDP connection but reports the browser disconnected.');
    }
    let notifyDisconnected!: () => void;
    const disconnected = new Promise<void>(resolve => {
      notifyDisconnected = resolve;
    });
    browser.once('disconnected', notifyDisconnected);
    const browserVersion = await browser.version();
    if (!browserVersion.trim() || !browser.isConnected() || childState.exited) {
      throw new Error('Playwright CDP connection verification failed.');
    }

    let disconnectPromise: Promise<void> | undefined;
    return {
      endpoint,
      browserVersion,
      disconnected,
      prepare() {
        if (!browser.isConnected()) {
          return Promise.reject(new Error('The configured browser disconnected before startup preparation.'));
        }
        return prepareConfiguredBrowser(browser, validatedConfiguration, options);
      },
      disconnect() {
        disconnectPromise ??= browser.isConnected() ? browser.close() : Promise.resolve();
        return disconnectPromise;
      },
    };
  } catch (error) {
    if (browser.isConnected()) {
      await browser.close().catch(() => undefined);
    }
    throw error;
  }
}
