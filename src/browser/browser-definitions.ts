import { win32 } from 'node:path';

export const BROWSER_IDS = ['brave', 'chrome', 'edge'] as const;
export type BrowserId = typeof BROWSER_IDS[number];

interface BrowserDefinition {
  displayName: string;
  executableName: string;
  installationSubpath: string;
}

export const BROWSER_DEFINITIONS: Record<BrowserId, BrowserDefinition> = {
  brave: {
    displayName: 'Brave Browser',
    executableName: 'brave.exe',
    installationSubpath: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  },
  chrome: {
    displayName: 'Google Chrome',
    executableName: 'chrome.exe',
    installationSubpath: 'Google\\Chrome\\Application\\chrome.exe',
  },
  edge: {
    displayName: 'Microsoft Edge',
    executableName: 'msedge.exe',
    installationSubpath: 'Microsoft\\Edge\\Application\\msedge.exe',
  },
};

export function isFullyQualifiedWindowsPath(value: string): boolean {
  return win32.isAbsolute(value) && win32.parse(value).root !== '\\';
}

export function browserForExecutableName(executableName: string): BrowserId | undefined {
  const normalized = executableName.toLowerCase();
  return BROWSER_IDS.find(
    browser => BROWSER_DEFINITIONS[browser].executableName === normalized,
  );
}
