import type { Browser, Frame, Page } from 'playwright';

export const BROWSER_SESSION_INTERRUPTED_MESSAGE = 'Browser session interrupted.';

export type BrowserSessionInterventionReason =
  | 'manual-mouse'
  | 'manual-keyboard'
  | 'manual-scroll'
  | 'manual-navigation'
  | 'manual-tab'
  | 'session-closed';

export interface BrowserSessionIntervention {
  reason: BrowserSessionInterventionReason;
}

export function describeBrowserSessionIntervention(
  reason: BrowserSessionInterventionReason,
): string {
  switch (reason) {
    case 'manual-mouse':
      return 'Manual mouse interaction detected.';
    case 'manual-keyboard':
      return 'Manual keyboard interaction detected.';
    case 'manual-scroll':
      return 'Manual scrolling detected.';
    case 'manual-navigation':
      return 'Manual navigation detected.';
    case 'manual-tab':
      return 'Manual tab switching detected.';
    case 'session-closed':
      return 'Browser session closed unexpectedly.';
  }
}

export function formatBrowserSessionIntervention(
  reason: BrowserSessionInterventionReason,
): string {
  return [
    `[ERROR] ${BROWSER_SESSION_INTERRUPTED_MESSAGE}`,
    `[REASON] ${describeBrowserSessionIntervention(reason)}`,
    '[ACTION] Automation stopped and browser session closed.',
  ].join('\n');
}

type PageSignal = 'mouse' | 'keyboard' | 'scroll' | 'hidden';

interface PageGuardHandle {
  enable(): void;
  disable(): void;
  dispose(): void;
  begin(): void;
  end(): void;
}

interface PageGuardWindow extends Window {
  __impracticalBotSessionGuard?: PageGuardHandle;
}

export interface PageGuardInstallOptions {
  bindingName: string;
  suppressionGraceMs?: number;
}

/**
 * Installs the in-page half of the Browser Session Guard. This function must stay
 * self-contained: Playwright serializes it for `addInitScript` and `evaluate`.
 */
export function installBrowserSessionGuardInPage(
  options: PageGuardInstallOptions,
): void {
  const guardWindow = window as unknown as PageGuardWindow & Record<string, unknown>;
  const existing = guardWindow.__impracticalBotSessionGuard;
  if (existing) {
    existing.enable();
    return;
  }

  const binding = guardWindow[options.bindingName];
  const report = (signal: PageSignal): void => {
    if (typeof binding !== 'function') {
      return;
    }
    try {
      (binding as (value: string) => void)(signal);
    } catch {
    }
  };

  const suppressionGraceMs = options.suppressionGraceMs ?? 150;
  let enabled = true;
  let suppressionDepth = 0;
  let suppressUntil = 0;
  const isSuppressed = (): boolean =>
    !enabled || suppressionDepth > 0 || Date.now() < suppressUntil;

  const listeners: Array<{
    type: string;
    handler: EventListener;
    capture: boolean;
  }> = [];
  const add = (type: string, handler: EventListener): void => {
    guardWindow.addEventListener(type, handler, true);
    listeners.push({ type, handler, capture: true });
  };
  const addPassive = (type: string, handler: EventListener): void => {
    guardWindow.addEventListener(type, handler, { capture: true, passive: true });
    listeners.push({ type, handler, capture: true });
  };
  const reportUnlessSuppressed = (signal: PageSignal): void => {
    if (!isSuppressed()) {
      report(signal);
    }
  };

  add('mousedown', () => reportUnlessSuppressed('mouse'));
  add('pointerdown', event => {
    if ((event as PointerEvent).pointerType !== 'mouse') {
      reportUnlessSuppressed('mouse');
    }
  });
  addPassive('wheel', () => reportUnlessSuppressed('scroll'));
  add('keydown', () => reportUnlessSuppressed('keyboard'));
  add('beforeinput', () => reportUnlessSuppressed('keyboard'));
  add('compositionstart', () => reportUnlessSuppressed('keyboard'));
  add('paste', () => reportUnlessSuppressed('keyboard'));
  add('dragstart', () => reportUnlessSuppressed('mouse'));
  add('drop', () => reportUnlessSuppressed('mouse'));
  add('selectstart', () => reportUnlessSuppressed('mouse'));
  add('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      reportUnlessSuppressed('hidden');
    }
  });

  const handle: PageGuardHandle = {
    enable(): void {
      enabled = true;
    },
    disable(): void {
      enabled = false;
    },
    dispose(): void {
      enabled = false;
      for (const { type, handler, capture } of listeners) {
        guardWindow.removeEventListener(type, handler, capture);
      }
      listeners.length = 0;
      delete guardWindow.__impracticalBotSessionGuard;
    },
    begin(): void {
      suppressionDepth += 1;
    },
    end(): void {
      suppressionDepth = Math.max(0, suppressionDepth - 1);
      suppressUntil = Date.now() + suppressionGraceMs;
    },
  };
  guardWindow.__impracticalBotSessionGuard = handle;
}

interface WindowBounds {
  windowState?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface SessionGuardCdpSession {
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  on?(event: string, listener: (params: Record<string, unknown>) => void): void;
  off?(event: string, listener: (params: Record<string, unknown>) => void): void;
  detach?(): Promise<void>;
}

export interface BrowserSessionGuardOptions {
  page: Page;
  browser?: Browser;
  onIntervention: (intervention: BrowserSessionIntervention) => void;
  urlPollIntervalMs?: number;
  suppressionGraceMs?: number;
  now?: () => number;
  createWindowCdpSession?: () => Promise<SessionGuardCdpSession>;
  createBrowserCdpSession?: () => Promise<SessionGuardCdpSession>;
  setInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface BrowserSessionGuard {
  readonly interrupted: boolean;
  readonly intervention: BrowserSessionIntervention | null;
  isInterrupted(): boolean;
  runAutomated<T>(
    operation: () => Promise<T>,
    options?: { navigation?: boolean },
  ): Promise<T>;
  dispose(): Promise<void>;
}

const DEFAULT_URL_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SUPPRESSION_GRACE_MS = 150;
let bindingSequence = 0;

async function defaultWindowCdpSession(page: Page): Promise<SessionGuardCdpSession> {
  return await page.context().newCDPSession(page) as unknown as SessionGuardCdpSession;
}

async function defaultBrowserCdpSession(browser: Browser): Promise<SessionGuardCdpSession> {
  return await browser.newBrowserCDPSession() as unknown as SessionGuardCdpSession;
}

export async function createBrowserSessionGuard(
  options: BrowserSessionGuardOptions,
): Promise<BrowserSessionGuard> {
  const { page } = options;
  const now = options.now ?? Date.now;
  const suppressionGraceMs =
    options.suppressionGraceMs ?? DEFAULT_SUPPRESSION_GRACE_MS;
  const urlPollIntervalMs =
    options.urlPollIntervalMs ?? DEFAULT_URL_POLL_INTERVAL_MS;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  let browser: Browser | undefined = options.browser;
  if (browser === undefined) {
    try {
      browser = page.context().browser() ?? undefined;
    } catch {
      browser = undefined;
    }
  }

  let interrupted = false;
  let intervention: BrowserSessionIntervention | null = null;
  let disposed = false;
  let automationDepth = 0;
  let navigationDepth = 0;
  let automationGraceUntil = 0;
  let urlPollTimer: ReturnType<typeof setInterval> | undefined;
  let urlBaseline: string | undefined;
  let pollInFlight = false;
  let windowCdpSession: SessionGuardCdpSession | undefined;
  let windowCdpPromise: Promise<SessionGuardCdpSession | undefined> | undefined;
  let browserCdpSession: SessionGuardCdpSession | undefined;
  let tabCreatedListener:
    ((params: Record<string, unknown>) => void) | undefined;
  let tabDestroyedListener:
    ((params: Record<string, unknown>) => void) | undefined;
  const knownPageTargets = new Set<string>();

  const isSuppressed = (): boolean =>
    automationDepth > 0 || now() < automationGraceUntil;

  const stopUrlPolling = (): void => {
    if (urlPollTimer !== undefined) {
      clearIntervalFn(urlPollTimer);
      urlPollTimer = undefined;
    }
  };

  const trigger = (reason: BrowserSessionInterventionReason): void => {
    if (disposed || interrupted) {
      return;
    }
    interrupted = true;
    intervention = { reason };
    stopUrlPolling();
    try {
      options.onIntervention(intervention);
    } catch {
    }
  };

  const getWindowSession = async (): Promise<SessionGuardCdpSession | undefined> => {
    if (windowCdpSession !== undefined) {
      return windowCdpSession;
    }
    windowCdpPromise ??= (async () => {
      try {
        const session = await (options.createWindowCdpSession
          ? options.createWindowCdpSession()
          : defaultWindowCdpSession(page));
        windowCdpSession = session;
        return session;
      } catch {
        return undefined;
      }
    })();
    return await windowCdpPromise;
  };

  const readWindowBounds = async (): Promise<WindowBounds | undefined> => {
    const session = await getWindowSession();
    if (!session) {
      return undefined;
    }
    try {
      const result = await session.send('Browser.getWindowForTarget');
      const bounds = result.bounds;
      if (typeof bounds !== 'object' || bounds === null) {
        return undefined;
      }
      return bounds as WindowBounds;
    } catch {
      return undefined;
    }
  };

  const pollUrl = async (): Promise<void> => {
    if (disposed || interrupted || pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      try {
        const currentUrl = page.url();
        if (urlBaseline === undefined) {
          urlBaseline = currentUrl;
        } else if (currentUrl !== urlBaseline) {
          urlBaseline = currentUrl;
          if (!isSuppressed()) {
            trigger('manual-navigation');
          }
        }
      } catch {
      }
    } finally {
      pollInFlight = false;
    }
  };

  const handleHidden = async (): Promise<void> => {
    if (disposed || interrupted || isSuppressed()) {
      return;
    }
    const bounds = await readWindowBounds();
    if (disposed || interrupted) {
      return;
    }
    if (bounds?.windowState === 'minimized') {
      return;
    }
    trigger('manual-tab');
  };

  const handlePageSignal = (signal: PageSignal): void => {
    if (disposed || interrupted || isSuppressed()) {
      return;
    }
    switch (signal) {
      case 'mouse':
        trigger('manual-mouse');
        break;
      case 'keyboard':
        trigger('manual-keyboard');
        break;
      case 'scroll':
        trigger('manual-scroll');
        break;
      case 'hidden':
        void handleHidden();
        break;
    }
  };

  const onFrameNavigated = (frame: Frame): void => {
    if (disposed || interrupted) {
      return;
    }
    let isMainFrame = false;
    try {
      isMainFrame = frame === page.mainFrame();
    } catch {
      isMainFrame = false;
    }
    if (!isMainFrame) {
      return;
    }
    try {
      urlBaseline = page.url();
    } catch {
    }
    if (navigationDepth > 0 || isSuppressed()) {
      return;
    }
    trigger('manual-navigation');
  };

  const onPageClose = (): void => {
    trigger('session-closed');
  };

  const onBrowserDisconnected = (): void => {
    trigger('session-closed');
  };

  const startTabMonitor = async (): Promise<void> => {
    if (browser === undefined) {
      return;
    }
    try {
      const createSession = options.createBrowserCdpSession
        ? options.createBrowserCdpSession
        : typeof browser.newBrowserCDPSession === 'function'
          ? () => defaultBrowserCdpSession(browser as Browser)
          : undefined;
      if (!createSession) {
        return;
      }
      const session = await createSession();
      browserCdpSession = session;
      if (typeof session.on !== 'function') {
        return;
      }

      const targets = await session.send('Target.getTargets');
      const targetInfos = Array.isArray(targets.targetInfos)
        ? targets.targetInfos
        : [];
      for (const target of targetInfos) {
        if (typeof target !== 'object' || target === null) {
          continue;
        }
        const info = target as { type?: unknown; targetId?: unknown };
        if (info.type === 'page' && typeof info.targetId === 'string') {
          knownPageTargets.add(info.targetId);
        }
      }

      tabCreatedListener = params => {
        const info = params.targetInfo;
        if (typeof info !== 'object' || info === null) {
          return;
        }
        const target = info as { type?: unknown; targetId?: unknown };
        if (target.type !== 'page' || typeof target.targetId !== 'string') {
          return;
        }
        if (knownPageTargets.has(target.targetId)) {
          return;
        }
        knownPageTargets.add(target.targetId);
        if (!isSuppressed()) {
          trigger('manual-tab');
        }
      };
      tabDestroyedListener = params => {
        const targetId = params.targetId;
        if (typeof targetId !== 'string' || !knownPageTargets.has(targetId)) {
          return;
        }
        knownPageTargets.delete(targetId);
        if (!isSuppressed()) {
          trigger('manual-tab');
        }
      };
      session.on('Target.targetCreated', tabCreatedListener);
      session.on('Target.targetDestroyed', tabDestroyedListener);
      await session.send('Target.setDiscoverTargets', { discover: true });
    } catch {
    }
  };

  const bindingName = `__impracticalBotSessionGuardReport${bindingSequence}`;
  bindingSequence += 1;
  await page.exposeBinding(bindingName, (_source, signal: unknown) => {
    if (typeof signal === 'string') {
      handlePageSignal(signal as PageSignal);
    }
  });
  const installOptions: PageGuardInstallOptions = {
    bindingName,
    suppressionGraceMs,
  };
  await page.addInitScript(installBrowserSessionGuardInPage, installOptions);
  await page.evaluate(installBrowserSessionGuardInPage, installOptions);

  page.on('framenavigated', onFrameNavigated);
  page.on('close', onPageClose);
  browser?.on('disconnected', onBrowserDisconnected);

  await startTabMonitor();

  if (!disposed && !interrupted) {
    await pollUrl();
    if (!disposed && !interrupted) {
      urlPollTimer = setIntervalFn(() => {
        void pollUrl();
      }, urlPollIntervalMs);
    }
  }

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopUrlPolling();
      try {
        page.off('framenavigated', onFrameNavigated);
        page.off('close', onPageClose);
      } catch {
      }
      try {
        browser?.off('disconnected', onBrowserDisconnected);
      } catch {
      }
      if (browserCdpSession !== undefined) {
        try {
          if (tabCreatedListener && typeof browserCdpSession.off === 'function') {
            browserCdpSession.off('Target.targetCreated', tabCreatedListener);
          }
          if (tabDestroyedListener && typeof browserCdpSession.off === 'function') {
            browserCdpSession.off('Target.targetDestroyed', tabDestroyedListener);
          }
          await browserCdpSession.detach?.();
        } catch {
        }
        browserCdpSession = undefined;
      }
      if (windowCdpSession !== undefined) {
        try {
          await windowCdpSession.detach?.();
        } catch {
        }
        windowCdpSession = undefined;
      }
      try {
        await page.evaluate(() => {
          const guardWindow = window as PageGuardWindow;
          guardWindow.__impracticalBotSessionGuard?.dispose();
        });
      } catch {
      }
    })();
    return disposePromise;
  };

  return {
    get interrupted() {
      return interrupted;
    },
    get intervention() {
      return intervention;
    },
    isInterrupted(): boolean {
      return interrupted;
    },
    async runAutomated<T>(
      operation: () => Promise<T>,
      runOptions: { navigation?: boolean } = {},
    ): Promise<T> {
      if (disposed || interrupted) {
        return await operation();
      }
      automationDepth += 1;
      if (runOptions.navigation === true) {
        navigationDepth += 1;
      }
      let pageSuppressionActive = false;
      try {
        try {
          await page.evaluate(() => {
            const guardWindow = window as PageGuardWindow;
            guardWindow.__impracticalBotSessionGuard?.begin();
          });
          pageSuppressionActive = true;
        } catch {
        }
        return await operation();
      } finally {
        automationDepth = Math.max(0, automationDepth - 1);
        if (runOptions.navigation === true) {
          navigationDepth = Math.max(0, navigationDepth - 1);
        }
        automationGraceUntil = now() + suppressionGraceMs;
        if (pageSuppressionActive) {
          try {
            await page.evaluate(() => {
              const guardWindow = window as PageGuardWindow;
              guardWindow.__impracticalBotSessionGuard?.end();
            });
          } catch {
          }
        }
      }
    },
    dispose,
  };
}
