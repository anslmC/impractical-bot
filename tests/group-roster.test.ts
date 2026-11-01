import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractGroupRoster,
  sanitizeGroupRoster,
  type GroupRoster,
  type GroupRosterExtractionOptions,
} from '../src/browser/group-roster.js';

interface FakeMember {
  fullName: string;
  nameButton?: boolean;
  addPeople?: boolean;
  duplicateMessageAction?: boolean;
}

interface FakePageOptions {
  panelOpen?: boolean;
  sectionExpanded?: boolean;
  dialogVisible?: boolean;
  infoAvailable?: boolean;
  layout?: 'wide' | 'narrow';
  backAvailable?: boolean;
  closeFails?: boolean;
  conversationVisible?: boolean;
  url?: string;
}

interface FakeButton {
  label: string;
  message: boolean;
}

type LocatorKind =
  | 'empty'
  | 'info'
  | 'expander'
  | 'back'
  | 'region'
  | 'dialog'
  | 'composer'
  | 'rows'
  | 'row'
  | 'row-buttons'
  | 'row-button';

class FakePage {
  readonly state: {
    panelOpen: boolean;
    sectionExpanded: boolean;
    dialogVisible: boolean;
    infoAvailable: boolean;
    layout: 'wide' | 'narrow';
    backAvailable: boolean;
    closeFails: boolean;
    conversationVisible: boolean | undefined;
    url: string;
    clicks: string[];
    escapePresses: number;
    focused: FakeLocator | null;
  };

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      if (key === 'Escape') {
        this.state.escapePresses += 1;
        this.state.dialogVisible = false;
      }
      if (key === 'Enter' && this.state.focused) {
        const focused = this.state.focused;
        this.state.focused = null;
        await focused.click();
      }
    },
  };

  constructor(
    readonly members: readonly FakeMember[],
    options: FakePageOptions = {},
  ) {
    const layout = options.layout ?? 'wide';
    this.state = {
      panelOpen: options.panelOpen ?? false,
      sectionExpanded: options.sectionExpanded ?? false,
      dialogVisible: options.dialogVisible ?? false,
      infoAvailable: options.infoAvailable ?? true,
      layout,
      backAvailable: options.backAvailable ?? layout === 'narrow',
      closeFails: options.closeFails ?? false,
      conversationVisible: options.conversationVisible,
      url: options.url ?? 'https://www.messenger.com/t/123456789',
      clicks: [],
      escapePresses: 0,
      focused: null,
    };
  }

  getByRole(role: string, options: { name?: string } = {}): FakeLocator {
    const name = options.name ?? '';
    if (role === 'button' && name === 'Conversation information') {
      return new FakeLocator(this, 'info');
    }
    if (role === 'button' && name === 'Chat members') {
      return new FakeLocator(this, 'expander');
    }
    if (role === 'button' && name === 'Back') {
      return new FakeLocator(this, 'back');
    }
    if (role === 'region' && name === 'Chat members') {
      return new FakeLocator(this, 'region');
    }
    if (role === 'dialog' && name === 'Your profile') {
      return new FakeLocator(this, 'dialog');
    }
    return new FakeLocator(this, 'empty');
  }

  locator(selector: string): FakeLocator {
    if (selector.includes('[role="textbox"]')) {
      return new FakeLocator(this, 'composer');
    }
    return new FakeLocator(this, 'empty');
  }

  url(): string {
    return this.state.url;
  }

  infoButtonVisible(): boolean {
    return this.state.infoAvailable &&
      (this.state.layout === 'wide' || !this.state.panelOpen);
  }

  backVisible(): boolean {
    return this.state.backAvailable && this.state.panelOpen;
  }

  isConversationVisible(): boolean {
    if (this.state.conversationVisible === false) {
      return false;
    }
    return this.state.layout === 'wide' || !this.state.panelOpen;
  }

  isRegionVisible(): boolean {
    return this.state.panelOpen && this.state.sectionExpanded;
  }

  buttonsOf(member: FakeMember): FakeButton[] {
    if (member.addPeople) {
      return [{ label: 'Add people', message: false }];
    }
    const buttons: FakeButton[] = [
      { label: `Message ${member.fullName}`, message: true },
    ];
    if (member.duplicateMessageAction) {
      buttons.push({ label: `Message ${member.fullName}`, message: true });
    }
    if (member.nameButton !== false) {
      buttons.push({ label: member.fullName, message: false });
    }
    return buttons;
  }
}

class FakeLocator {
  constructor(
    readonly page: FakePage,
    readonly kind: LocatorKind,
    readonly index = 0,
    readonly rowIndex = 0,
    readonly buttonIndex = 0,
  ) {}

  async count(): Promise<number> {
    switch (this.kind) {
      case 'info':
        return this.page.infoButtonVisible() ? 1 : 0;
      case 'expander':
        return this.page.state.infoAvailable && this.page.state.panelOpen ? 1 : 0;
      case 'back':
        return this.page.backVisible() ? 1 : 0;
      case 'region':
        return 1;
      case 'dialog':
        return this.page.state.dialogVisible ? 1 : 0;
      case 'composer':
        return this.page.isConversationVisible() ? 1 : 0;
      case 'rows':
        return this.page.isRegionVisible() ? this.page.members.length : 0;
      case 'row':
        return this.page.isRegionVisible() && this.rowIndex < this.page.members.length ? 1 : 0;
      case 'row-buttons': {
        const member = this.page.members[this.rowIndex];
        return this.page.isRegionVisible() && member ? this.page.buttonsOf(member).length : 0;
      }
      case 'row-button': {
        const member = this.page.members[this.rowIndex];
        return this.page.isRegionVisible() && member &&
          this.buttonIndex < this.page.buttonsOf(member).length ? 1 : 0;
      }
      default:
        return 0;
    }
  }

  nth(index: number): FakeLocator {
    if (this.kind === 'rows') {
      return new FakeLocator(this.page, 'row', index, index);
    }
    if (this.kind === 'row-buttons') {
      return new FakeLocator(this.page, 'row-button', index, this.rowIndex, index);
    }
    return new FakeLocator(this.page, this.kind, index, this.rowIndex, this.buttonIndex);
  }

  getByRole(role: string): FakeLocator {
    if (this.kind === 'region' && role === 'listitem') {
      return new FakeLocator(this.page, 'rows');
    }
    if (this.kind === 'row' && role === 'button') {
      return new FakeLocator(this.page, 'row-buttons', 0, this.rowIndex);
    }
    return new FakeLocator(this.page, 'empty');
  }

  async isVisible(): Promise<boolean> {
    switch (this.kind) {
      case 'info':
        return this.page.infoButtonVisible();
      case 'expander':
        return this.page.state.infoAvailable && this.page.state.panelOpen;
      case 'back':
        return this.page.backVisible();
      case 'composer':
        return this.page.isConversationVisible();
      case 'region':
      case 'rows':
      case 'row':
      case 'row-buttons':
      case 'row-button':
        return this.page.isRegionVisible();
      case 'dialog':
        return this.page.state.dialogVisible;
      default:
        return false;
    }
  }

  async isEnabled(): Promise<boolean> {
    return await this.isVisible();
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === 'aria-expanded' && this.kind === 'info') {
      return this.page.infoButtonVisible() ? String(this.page.state.panelOpen) : null;
    }
    if (name === 'aria-expanded' && this.kind === 'expander') {
      return String(this.page.state.sectionExpanded);
    }
    if (name === 'aria-label' && this.kind === 'row-button') {
      const member = this.page.members[this.rowIndex];
      if (!member) {
        return null;
      }
      return this.page.buttonsOf(member)[this.buttonIndex]?.label ?? null;
    }
    return null;
  }

  async innerText(): Promise<string> {
    switch (this.kind) {
      case 'info':
        return 'Conversation information';
      case 'expander':
        return 'Chat members';
      case 'row': {
        const member = this.page.members[this.rowIndex];
        if (!member) {
          return '';
        }
        return member.addPeople ? '' : member.fullName;
      }
      case 'row-button': {
        const member = this.page.members[this.rowIndex];
        return member ? this.page.buttonsOf(member)[this.buttonIndex]?.label ?? '' : '';
      }
      default:
        return '';
    }
  }

  first(): FakeLocator {
    return this;
  }

  async focus(): Promise<void> {
    this.page.state.focused = this;
  }

  async click(): Promise<void> {
    if (this.kind === 'info') {
      if (!this.page.infoButtonVisible()) {
        throw new Error('The conversation information control is unavailable.');
      }
      if (this.page.state.closeFails && this.page.state.panelOpen) {
        return;
      }
      this.page.state.clicks.push('info');
      this.page.state.panelOpen = !this.page.state.panelOpen;
      if (!this.page.state.panelOpen) {
        this.page.state.sectionExpanded = false;
      }
      return;
    }
    if (this.kind === 'back') {
      if (!this.page.backVisible()) {
        throw new Error('The Back control is unavailable.');
      }
      this.page.state.clicks.push('back');
      if (this.page.state.closeFails) {
        return;
      }
      this.page.state.panelOpen = false;
      this.page.state.sectionExpanded = false;
      return;
    }
    if (this.kind === 'expander') {
      if (!this.page.state.panelOpen) {
        throw new Error('The Chat members control is unavailable.');
      }
      this.page.state.clicks.push('expander');
      this.page.state.sectionExpanded = !this.page.state.sectionExpanded;
      return;
    }
    throw new Error(`Cannot click ${this.kind}.`);
  }

  async waitFor(options: { state?: string }): Promise<void> {
    if (options.state === 'visible' && !await this.isVisible()) {
      throw new Error('Locator did not become visible.');
    }
  }
}

function extractionOptions(): GroupRosterExtractionOptions {
  let current = 0;
  return {
    timeoutMs: 20,
    pollIntervalMs: 5,
    stableReads: 2,
    now: () => current,
    delay: async (milliseconds) => {
      current += milliseconds;
    },
  };
}

test('extracts first names only, preserves duplicates, and ignores Add people', async () => {
  const page = new FakePage([
    { fullName: 'Alex Smith' },
    { fullName: 'Sam Lee' },
    { fullName: 'Sam Lee' },
    { fullName: '', addPeople: true },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'partial');
  assert.deepEqual(roster.members, [
    { firstName: 'Alex', isPuppet: true },
    { firstName: 'Sam', isPuppet: false },
    { firstName: 'Sam', isPuppet: false },
  ]);
  assert.deepEqual(roster.puppet, { firstName: 'Alex', isPuppet: true });
  assert.deepEqual(roster.duplicateFirstNames, ['Sam']);
  assert.equal(roster.reason, undefined);
  assert.equal(JSON.stringify(roster).includes('Smith'), false);
  assert.equal(JSON.stringify(roster).includes('Lee'), false);
  assert.deepEqual(page.state.clicks, ['info', 'expander', 'info']);
  assert.equal(page.state.panelOpen, false);
  assert.equal(page.state.sectionExpanded, false);
  assert.equal(page.isConversationVisible(), true);
});

test('closes an already open wide panel and dismisses the profile dialog', async () => {
  const page = new FakePage(
    [{ fullName: 'Alex Smith' }],
    { panelOpen: true, sectionExpanded: true, dialogVisible: true },
  );

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.deepEqual(page.state.clicks, ['info']);
  assert.equal(page.state.escapePresses, 1);
  assert.equal(page.state.panelOpen, false);
  assert.equal(page.state.sectionExpanded, false);
  assert.equal(page.isConversationVisible(), true);
});

test('closes a narrow information view with the Back control', async () => {
  const page = new FakePage(
    [{ fullName: 'Alex Smith' }],
    { layout: 'narrow', panelOpen: true, sectionExpanded: true },
  );

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.deepEqual(page.state.clicks, ['back']);
  assert.equal(page.state.panelOpen, false);
  assert.equal(page.state.sectionExpanded, false);
  assert.equal(page.isConversationVisible(), true);
});

test('prefers Back when both close controls are present', async () => {
  const page = new FakePage(
    [{ fullName: 'Alex Smith' }],
    {
      panelOpen: true,
      sectionExpanded: true,
      backAvailable: true,
    },
  );

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.deepEqual(page.state.clicks, ['back']);
  assert.equal(page.state.panelOpen, false);
  assert.equal(page.state.sectionExpanded, false);
});

test('leaves an already closed information view untouched', async () => {
  const page = new FakePage([], { infoAvailable: false });
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  let roster: GroupRoster;
  try {
    roster = await extractGroupRoster(
      page as never,
      'Alex Smith',
      extractionOptions(),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(roster.status, 'unavailable');
  assert.deepEqual(page.state.clicks, []);
  assert.equal(page.state.panelOpen, false);
  assert.deepEqual(warnings, []);
});

test('warns once and preserves the roster when the information view cannot be closed', async () => {
  const page = new FakePage(
    [{ fullName: 'Alex Smith' }],
    {
      layout: 'narrow',
      panelOpen: true,
      sectionExpanded: true,
      closeFails: true,
    },
  );
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  let roster: GroupRoster;
  try {
    roster = await extractGroupRoster(
      page as never,
      'Alex Smith',
      extractionOptions(),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(roster.status, 'partial');
  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.equal(page.state.panelOpen, true);
  assert.equal(page.isConversationVisible(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /could not be closed/u);
});

test('keeps valid members and reports malformed rows as partial', async () => {
  const page = new FakePage([
    { fullName: 'Alex Smith' },
    { fullName: 'Broken Row', nameButton: false },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'partial');
  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.match(roster.reason ?? '', /could not be validated/u);
});

test('reports an ambiguous puppet match without guessing', async () => {
  const page = new FakePage([
    { fullName: 'Alex Smith' },
    { fullName: 'Alex Smith' },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'partial');
  assert.equal(roster.puppet, null);
  assert.equal(roster.members.every((member) => !member.isPuppet), true);
  assert.deepEqual(roster.duplicateFirstNames, ['Alex']);
  assert.match(roster.reason ?? '', /could not be matched unambiguously/u);
});

test('reports unavailable when no member cards are rendered', async () => {
  const page = new FakePage([], { panelOpen: true, sectionExpanded: true });

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'unavailable');
  assert.deepEqual(roster.members, []);
  assert.equal(roster.puppet, null);
  assert.match(roster.reason ?? '', /no member cards/u);
});

test('returns unavailable when the conversation information control is unavailable', async () => {
  const page = new FakePage([], { infoAvailable: false });

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'unavailable');
  assert.deepEqual(roster.members, []);
  assert.match(roster.reason ?? '', /extraction failed/u);
});

test('returns unavailable when the page cannot provide the roster controls', async () => {
  const page = {
    getByRole: () => {
      throw new Error('private page details');
    },
  };

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'unavailable');
  assert.equal(JSON.stringify(roster).includes('private page details'), false);
});

test('treats duplicate Message actions as malformed rows', async () => {
  const page = new FakePage([
    { fullName: 'Alex Smith' },
    { fullName: 'Sam Lee', duplicateMessageAction: true },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Alex Smith',
    extractionOptions(),
  );

  assert.equal(roster.status, 'partial');
  assert.deepEqual(roster.members, [{ firstName: 'Alex', isPuppet: true }]);
  assert.match(roster.reason ?? '', /could not be validated/u);
});

test('keeps only the first token of a multi-word surname and matches the puppet by full name', async () => {
  const page = new FakePage([
    { fullName: 'Geoff Markus Del Rio' },
    { fullName: 'Geoff Smith' },
    { fullName: 'Yukinon Yukinoshita' },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Geoff Markus Del Rio',
    extractionOptions(),
  );

  assert.equal(roster.status, 'partial');
  assert.deepEqual(roster.members, [
    { firstName: 'Geoff', isPuppet: true },
    { firstName: 'Geoff', isPuppet: false },
    { firstName: 'Yukinon', isPuppet: false },
  ]);
  assert.deepEqual(roster.puppet, { firstName: 'Geoff', isPuppet: true });
  assert.deepEqual(roster.duplicateFirstNames, ['Geoff']);
  for (const surname of ['Markus', 'Del Rio', 'Smith', 'Yukinoshita']) {
    assert.equal(JSON.stringify(roster).includes(surname), false);
  }
});

test('never matches the puppet from a first name alone', async () => {
  const page = new FakePage([
    { fullName: 'Yukinon' },
    { fullName: 'Yukinon Yukinoshita' },
  ]);

  const roster = await extractGroupRoster(
    page as never,
    'Yukinon Yukinoshita',
    extractionOptions(),
  );

  assert.deepEqual(roster.members, [
    { firstName: 'Yukinon', isPuppet: false },
    { firstName: 'Yukinon', isPuppet: true },
  ]);
  assert.deepEqual(roster.puppet, { firstName: 'Yukinon', isPuppet: true });
});

test('sanitizes runtime rosters to first names and removes full-name metadata', () => {
  const roster = {
    status: 'partial',
    members: [
      {
        firstName: 'Anselmo Calderon',
        isPuppet: true,
        fullName: 'Anselmo Calderon',
      },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
    ],
    puppet: {
      firstName: 'Anselmo Calderon',
      isPuppet: true,
      displayName: 'Anselmo Calderon',
    },
    duplicateFirstNames: ['Geoff Markus Del Rio'],
    reason: 'Anselmo Calderon could not be verified',
  } as unknown as GroupRoster;

  const sanitized = sanitizeGroupRoster(roster);

  assert.deepEqual(sanitized.members, [
    { firstName: 'Anselmo', isPuppet: true },
    { firstName: 'Geoff', isPuppet: false },
    { firstName: 'Geoff', isPuppet: false },
  ]);
  assert.deepEqual(sanitized.puppet, { firstName: 'Anselmo', isPuppet: true });
  assert.deepEqual(sanitized.duplicateFirstNames, ['Geoff']);
  assert.equal(sanitized.reason, 'Anselmo could not be verified');
  for (const surname of ['Calderon', 'Markus', 'Del Rio', 'displayName', 'fullName']) {
    assert.equal(JSON.stringify(sanitized).includes(surname), false);
  }
});

test('extraction does not log full display names', async () => {
  const page = new FakePage([
    { fullName: 'Anselmo Calderon' },
    { fullName: 'Geoff Markus Del Rio' },
  ]);
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const output: string[] = [];
  const capture = (...args: unknown[]): void => {
    output.push(args.map(String).join(' '));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  console.info = capture;
  console.debug = capture;

  try {
    const roster = await extractGroupRoster(
      page as never,
      'Anselmo Calderon',
      extractionOptions(),
    );
    assert.equal(roster.status, 'partial');
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
    console.debug = original.debug;
  }

  for (const surname of ['Calderon', 'Markus', 'Del Rio']) {
    assert.equal(output.join('\n').includes(surname), false);
  }
});
