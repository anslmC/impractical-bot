import type { Locator, Page } from 'playwright';
import {
  formatTerminalText,
  type TerminalStyle,
} from '../components/terminal-formatting.js';

export type GroupRosterStatus = 'complete' | 'partial' | 'unavailable' | 'not-group';

export interface GroupRosterMember {
  firstName: string;
  isPuppet: boolean;
}

export interface GroupRoster {
  status: GroupRosterStatus;
  members: readonly GroupRosterMember[];
  puppet: GroupRosterMember | null;
  duplicateFirstNames: readonly string[];
  reason?: string;
}

export type AutomatedActionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export interface GroupRosterExtractionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableReads?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  runAutomatedAction?: AutomatedActionRunner;
}

const CONVERSATION_INFORMATION = 'Conversation information';
const CHAT_MEMBERS = 'Chat members';
const PROFILE_DIALOG = 'Your profile';
const BACK = 'Back';
const ADD_PEOPLE = 'Add people';
const MESSAGE_ACTION_PREFIX = /^Message\s+/iu;
const CONVERSATION_COMPOSER_SELECTOR = '[role="textbox"][contenteditable="true"]:visible';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STABLE_READS = 2;
const CLICK_TIMEOUT_MS = 5_000;
const CLOSE_ATTEMPTS = 3;

interface RosterRowSnapshot {
  members: GroupRosterMember[];
  malformed: boolean;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function countOf(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function isEnabled(locator: Locator): Promise<boolean> {
  try {
    return await locator.isEnabled();
  } catch {
    return false;
  }
}

async function attributeOf(locator: Locator, name: string): Promise<string | null> {
  try {
    return await locator.getAttribute(name);
  } catch {
    return null;
  }
}

async function textOf(locator: Locator): Promise<string> {
  try {
    return (await locator.innerText()).trim();
  } catch {
    return '';
  }
}

async function accessibleNameOf(locator: Locator): Promise<string> {
  const label = (await attributeOf(locator, 'aria-label'))?.trim();
  if (label) {
    return label;
  }
  return textOf(locator);
}

function normalizeDisplayName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function firstToken(value: string): string {
  return normalizeDisplayName(value).split(' ')[0] ?? '';
}

function duplicateNames(members: readonly GroupRosterMember[]): string[] {
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.firstName, (counts.get(member.firstName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
}

function sanitizeReason(
  reason: string | undefined,
  sourceNames: readonly string[],
): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  const replacements = new Map<string, string>();
  for (const source of sourceNames) {
    const normalized = normalizeDisplayName(source);
    if (!normalized) {
      continue;
    }
    replacements.set(normalized, firstToken(normalized));
    for (const token of normalized.split(' ').slice(1)) {
      if (token) {
        replacements.set(token, '');
      }
    }
  }
  let sanitized = reason;
  for (const [from, to] of [...replacements.entries()]
    .sort((left, right) => right[0].length - left[0].length)) {
    sanitized = sanitized.split(from).join(to);
  }
  const trimmed = sanitized.replace(/\s+/gu, ' ').trim();
  return trimmed || undefined;
}

function rosterStatusStyle(status: string): TerminalStyle {
  if (status === 'COMPLETE') {
    return 'green';
  }
  if (status === 'PARTIAL') {
    return 'yellow';
  }
  return 'red';
}

export function formatGroupRosterOutcome(roster: GroupRoster): string {
  const label = formatTerminalText('[GROUP MEMBERS]', 'cyan');
  if (roster.status === 'complete' || roster.status === 'partial') {
    const status = roster.status.toUpperCase();
    return `${label} ${formatTerminalText('Extraction successful:', 'bold')} ` +
      `${formatTerminalText(String(roster.members.length), 'bold')} members ` +
      `${formatTerminalText(`(${status})`, rosterStatusStyle(status))}.`;
  }
  return `${label} ${formatTerminalText('Extraction failed:', 'bold')} ` +
    `${formatTerminalText('0', 'bold')} members ` +
    `${formatTerminalText('(UNAVAILABLE)', 'red')}.`;
}

export function createUnavailableGroupRoster(
  reason = 'group roster could not be extracted',
): GroupRoster {
  return {
    status: 'unavailable',
    members: [],
    puppet: null,
    duplicateFirstNames: [],
    reason,
  };
}

export function createNotGroupRoster(): GroupRoster {
  return {
    status: 'not-group',
    members: [],
    puppet: null,
    duplicateFirstNames: [],
  };
}

function buildRoster(snapshot: RosterRowSnapshot, puppetName: string): GroupRoster {
  const configuredPuppet = normalizeDisplayName(puppetName);
  if (snapshot.members.length === 0) {
    return createUnavailableGroupRoster('no member cards were available');
  }

  const puppetMatches = snapshot.members.filter(member => member.isPuppet).length;
  const members = puppetMatches === 1
    ? snapshot.members
    : snapshot.members.map(member => ({ ...member, isPuppet: false }));
  const puppet = puppetMatches === 1
    ? members.find(member => member.isPuppet) ?? null
    : null;
  const reason = configuredPuppet === ''
    ? 'the configured puppet name is unavailable'
    : puppet === null
      ? 'the configured puppet could not be matched unambiguously'
      : snapshot.malformed
        ? 'one or more member rows could not be validated'
        : undefined;

  return {
    status: 'partial',
    members,
    puppet,
    duplicateFirstNames: duplicateNames(members),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function sanitizeGroupRoster(roster: GroupRoster): GroupRoster {
  const members = roster.members
    .map(member => ({
      firstName: firstToken(member.firstName),
      isPuppet: member.isPuppet === true,
    }))
    .filter(member => member.firstName !== '');
  const puppetMatches = members.filter(member => member.isPuppet).length;
  const sanitizedMembers = puppetMatches === 1
    ? members
    : members.map(member => ({ firstName: member.firstName, isPuppet: false }));
  const puppet = puppetMatches === 1
    ? sanitizedMembers.find(member => member.isPuppet) ?? null
    : null;
  const reason = sanitizeReason(
    roster.reason,
    [
      ...roster.members.map(member => member.firstName),
      ...(roster.puppet ? [roster.puppet.firstName] : []),
    ],
  );

  return {
    status: roster.status,
    members: sanitizedMembers,
    puppet,
    duplicateFirstNames: duplicateNames(sanitizedMembers),
    ...(reason === undefined ? {} : { reason }),
  };
}

async function readRowsOnce(region: Locator, puppetName: string): Promise<RosterRowSnapshot> {
  const rows = region.getByRole('listitem');
  const rowCount = await countOf(rows);
  const configuredPuppet = normalizeDisplayName(puppetName);
  const members: GroupRosterMember[] = [];
  let malformed = false;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    const buttons = row.getByRole('button');
    const buttonCount = await countOf(buttons);
    const rowText = await textOf(row);
    const accessibleNames: string[] = [];
    let messageName: string | null = null;
    let messageActionCount = 0;
    let nameButtonMatched = false;

    for (let buttonIndex = 0; buttonIndex < buttonCount; buttonIndex += 1) {
      const button = buttons.nth(buttonIndex);
      const accessibleName = await accessibleNameOf(button);
      accessibleNames.push(accessibleName);
      if (MESSAGE_ACTION_PREFIX.test(accessibleName)) {
        messageActionCount += 1;
        messageName = accessibleName.replace(MESSAGE_ACTION_PREFIX, '').trim();
      }
    }

    if (messageActionCount === 0) {
      const isAddPeople = accessibleNames.some(
        (name) => normalizeDisplayName(name) === ADD_PEOPLE,
      ) || rowText.toLocaleLowerCase().includes(ADD_PEOPLE.toLocaleLowerCase());
      if (isAddPeople) {
        continue;
      }
      if (rowText !== '' || buttonCount > 0) {
        malformed = true;
      }
      continue;
    }

    if (messageActionCount !== 1 || !messageName) {
      malformed = true;
      continue;
    }

    const expectedName = normalizeDisplayName(messageName);
    nameButtonMatched = accessibleNames.some(
      (name) => !MESSAGE_ACTION_PREFIX.test(name) &&
        normalizeDisplayName(name) === expectedName,
    );

    if (!nameButtonMatched) {
      malformed = true;
      continue;
    }
    const firstName = firstToken(expectedName);
    if (!firstName) {
      malformed = true;
      continue;
    }
    members.push({
      firstName,
      isPuppet: configuredPuppet !== '' && expectedName === configuredPuppet,
    });
  }

  return { members, malformed };
}

async function waitForVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return isVisible(locator);
  }
}

async function waitForStableRows(
  region: Locator,
  puppetName: string,
  deadline: number,
  pollIntervalMs: number,
  stableReads: number,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<RosterRowSnapshot> {
  let previousSignature: string | null = null;
  let consecutiveReads = 0;

  while (true) {
    const snapshot = await readRowsOnce(region, puppetName);
    const signature = JSON.stringify(snapshot);
    if (signature === previousSignature) {
      consecutiveReads += 1;
    } else {
      previousSignature = signature;
      consecutiveReads = 1;
    }
    if (snapshot.members.length > 0 && consecutiveReads >= stableReads) {
      return snapshot;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return snapshot;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

async function dismissObstructingProfileDialog(
  page: Page,
  runAutomated: AutomatedActionRunner,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: PROFILE_DIALOG, exact: true });
  if (await countOf(dialog) === 1 && await isVisible(dialog)) {
    await runAutomated(() => page.keyboard.press('Escape')).catch(() => undefined);
  }
}

async function isPanelOpen(
  infoButton: Locator,
  expander: Locator,
  region: Locator,
): Promise<boolean> {
  if (await isVisible(region) || await isVisible(expander)) {
    return true;
  }
  return await attributeOf(infoButton, 'aria-expanded') === 'true';
}

async function isExpanded(expander: Locator, region: Locator): Promise<boolean> {
  if (await isVisible(region)) {
    return true;
  }
  return await attributeOf(expander, 'aria-expanded') === 'true';
}

function currentPageUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

async function isInformationOpen(
  backButton: Locator,
  infoButton: Locator,
  region: Locator,
): Promise<boolean> {
  if (await isVisible(backButton)) {
    return true;
  }
  if (await attributeOf(infoButton, 'aria-expanded') === 'true') {
    return true;
  }
  return await isVisible(region);
}

async function isAvailableControl(locator: Locator): Promise<boolean> {
  return await countOf(locator) === 1 &&
    await isVisible(locator) &&
    await isEnabled(locator);
}

async function chooseCloseControl(
  backButton: Locator,
  infoButton: Locator,
): Promise<Locator | null> {
  if (await isAvailableControl(backButton)) {
    return backButton;
  }
  if (await isAvailableControl(infoButton) &&
      await attributeOf(infoButton, 'aria-expanded') === 'true') {
    return infoButton;
  }
  return null;
}

async function activateControl(
  page: Page,
  control: Locator,
  useKeyboard: boolean,
  runAutomated: AutomatedActionRunner,
): Promise<void> {
  if (useKeyboard) {
    try {
      await runAutomated(async () => {
        await control.focus({ timeout: CLICK_TIMEOUT_MS });
        await page.keyboard.press('Enter');
      });
      return;
    } catch {
    }
  }
  await runAutomated(() => control.click({ timeout: CLICK_TIMEOUT_MS }));
}

async function waitForInformationClosed(
  backButton: Locator,
  infoButton: Locator,
  region: Locator,
  deadline: number,
  pollIntervalMs: number,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  while (true) {
    if (!await isInformationOpen(backButton, infoButton, region)) {
      return true;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

async function closeConversationInformation(
  page: Page,
  initialUrl: string | null,
  deadline: number,
  pollIntervalMs: number,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
  runAutomated: AutomatedActionRunner,
): Promise<boolean> {
  const backButton = page.getByRole('button', { name: BACK, exact: true });
  const infoButton = page.getByRole('button', {
    name: CONVERSATION_INFORMATION,
    exact: true,
  });
  const region = page.getByRole('region', { name: CHAT_MEMBERS, exact: true });
  const composer = page.locator(CONVERSATION_COMPOSER_SELECTOR);

  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
    if (!await isInformationOpen(backButton, infoButton, region)) {
      break;
    }
    const control = await chooseCloseControl(backButton, infoButton);
    if (control === null) {
      break;
    }
    try {
      await activateControl(page, control, attempt % 2 === 0, runAutomated);
    } catch {
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    const attemptDeadline = Math.min(
      deadline,
      now() + Math.max(
        pollIntervalMs,
        Math.floor(remaining / (CLOSE_ATTEMPTS - attempt)),
      ),
    );
    if (await waitForInformationClosed(
      backButton,
      infoButton,
      region,
      attemptDeadline,
      pollIntervalMs,
      now,
      delay,
    )) {
      break;
    }
  }

  if (await isInformationOpen(backButton, infoButton, region)) {
    return false;
  }
  if (!await isVisible(composer)) {
    return false;
  }
  const currentUrl = currentPageUrl(page);
  return initialUrl === null || currentUrl === initialUrl;
}

export async function extractGroupRoster(
  page: Page,
  puppetName: string,
  options: GroupRosterExtractionOptions = {},
): Promise<GroupRoster> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stableReads = Math.max(2, options.stableReads ?? DEFAULT_STABLE_READS);
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const runAutomated = options.runAutomatedAction ??
    (<T>(operation: () => Promise<T>): Promise<T> => operation());
  if (timeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error('Group roster extraction timeouts must be positive.');
  }

  const initialUrl = currentPageUrl(page);
  try {
    const infoButton = page.getByRole('button', {
      name: CONVERSATION_INFORMATION,
      exact: true,
    });
    const expander = page.getByRole('button', { name: CHAT_MEMBERS, exact: true });
    const region = page.getByRole('region', { name: CHAT_MEMBERS, exact: true });

    await dismissObstructingProfileDialog(page, runAutomated);

    if (!await isPanelOpen(infoButton, expander, region)) {
      if (await countOf(infoButton) !== 1 ||
          !await isVisible(infoButton) ||
          !await isEnabled(infoButton)) {
        throw new Error('The conversation information control was not uniquely available.');
      }
      await runAutomated(() => infoButton.click({ timeout: CLICK_TIMEOUT_MS }));
      if (!await waitForVisible(region, Math.min(timeoutMs, CLICK_TIMEOUT_MS))) {
        await waitForVisible(expander, Math.min(timeoutMs, CLICK_TIMEOUT_MS));
      }
    }

    if (!await isVisible(region)) {
      if (await isExpanded(expander, region)) {
        await waitForVisible(region, timeoutMs);
      } else {
        if (await countOf(expander) !== 1 ||
            !await isVisible(expander) ||
            !await isEnabled(expander)) {
          throw new Error('The Chat members control was not uniquely available.');
        }
        await runAutomated(() => expander.click({ timeout: CLICK_TIMEOUT_MS }));
        await waitForVisible(region, timeoutMs);
      }
    }

    if (!await isVisible(region)) {
      throw new Error('The Chat members region did not become visible.');
    }

    const snapshot = await waitForStableRows(
      region,
      puppetName,
      now() + timeoutMs,
      pollIntervalMs,
      stableReads,
      now,
      delay,
    );
    return buildRoster(snapshot, puppetName);
  } catch {
    return createUnavailableGroupRoster('group roster extraction failed');
  } finally {
    let closed = false;
    try {
      closed = await closeConversationInformation(
        page,
        initialUrl,
        now() + timeoutMs,
        pollIntervalMs,
        now,
        delay,
        runAutomated,
      );
    } catch {
      closed = false;
    }
    if (!closed) {
      console.warn(formatTerminalText(
        '[GROUP MEMBERS] Conversation information could not be closed; continuing startup.',
        'yellow',
      ));
    }
  }
}

export const readGroupRoster = extractGroupRoster;
