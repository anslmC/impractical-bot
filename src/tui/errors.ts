import {
  RuntimeAlreadyRunningError,
  RuntimeControlTimeoutError,
} from '../runtime-control.js';
import { sanitizeLogText } from './logs.js';

export type TuiErrorCategory =
  | 'pause'
  | 'resume'
  | 'stop'
  | 'destination'
  | 'temperament'
  | 'personality'
  | 'status'
  | 'dashboard'
  | 'runtime'
  | 'browser'
  | 'configuration';

type DetailKind =
  | 'timeout'
  | 'connection'
  | 'already-running'
  | 'unsupported'
  | 'configuration'
  | 'browser'
  | 'rollback'
  | 'destination-busy'
  | 'destination-stopping'
  | 'destination-unavailable'
  | 'destination-initialization'
  | 'unknown';

const CATEGORY_ACTIONS: Readonly<Record<TuiErrorCategory, string>> = {
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  destination: 'Destination change',
  temperament: 'Temperament change',
  personality: 'Personality change',
  status: 'Status request',
  dashboard: 'Dashboard',
  runtime: 'Command',
  browser: 'Browser interaction',
  configuration: 'Configuration update',
};

const CATEGORY_FALLBACKS: Readonly<Record<TuiErrorCategory, string>> = {
  pause: 'Pause failed. See the logs.',
  resume: 'Resume failed. See the logs.',
  stop: 'Stop failed. See the logs.',
  destination: 'Destination change failed. See the logs.',
  temperament: 'Temperament change failed. See the logs.',
  personality: 'Personality change failed. See the logs.',
  status: 'Engine status unavailable.',
  dashboard: 'Dashboard unavailable.',
  runtime: 'Command failed. See the logs.',
  browser: 'Browser interaction failed. See the logs.',
  configuration: 'Configuration update failed. See the logs.',
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyDetail(category: TuiErrorCategory, reason: string): DetailKind {
  if (category === 'destination') {
    if (/could not be restored|rollback/i.test(reason)) {
      return 'rollback';
    }
    if (/already in progress/i.test(reason)) {
      return 'destination-busy';
    }
    if (/engine is stopping|engine stopped/i.test(reason)) {
      return 'destination-stopping';
    }
    if (/could not be opened|or verified|unavailable|readiness/i.test(reason)) {
      return 'destination-unavailable';
    }
    if (/could not be initialized/i.test(reason)) {
      return 'destination-initialization';
    }
  }
  if (errorIsUnsupported(reason)) {
    return 'unsupported';
  }
  if (errorIsAlreadyRunning(reason)) {
    return 'already-running';
  }
  if (errorIsTimeout(reason)) {
    return 'timeout';
  }
  if (errorIsConnectionFailure(reason)) {
    return 'connection';
  }
  if (category !== 'configuration' && errorIsConfigurationFailure(reason)) {
    return 'configuration';
  }
  if (category !== 'browser' && category !== 'destination' && errorIsBrowserFailure(reason)) {
    return 'browser';
  }
  return 'unknown';
}

function errorIsUnsupported(reason: string): boolean {
  return /only supported on windows/i.test(reason);
}

function errorIsAlreadyRunning(reason: string): boolean {
  return /already running/i.test(reason);
}

function errorIsTimeout(reason: string): boolean {
  return /timed out|timeout|did not respond|exceeded the protocol limit/i.test(reason);
}

function errorIsConnectionFailure(reason: string): boolean {
  return /connection closed|endpoint|not owned|invalid .* response|protocol|econnrefused|epipe|runtime-control/i
    .test(reason);
}

function errorIsConfigurationFailure(reason: string): boolean {
  return /could not be saved|configuration|config file|malformed|schema|PIN |not initialized|LOCALAPPDATA/i
    .test(reason);
}

function errorIsBrowserFailure(reason: string): boolean {
  return /browser|playwright|chromium|page\b|navigate/i.test(reason);
}

function classifyError(category: TuiErrorCategory, error: unknown): DetailKind {
  if (error instanceof RuntimeControlTimeoutError) {
    return 'timeout';
  }
  if (error instanceof RuntimeAlreadyRunningError) {
    return 'already-running';
  }
  return classifyDetail(category, describeError(error));
}

export function formatTuiErrorMessage(category: TuiErrorCategory, detail: unknown): string {
  const reason = describeError(detail);
  const kind = detail instanceof Error
    ? classifyError(category, detail)
    : classifyDetail(category, reason);

  if (kind === 'unsupported') {
    return 'Dashboard controls require Windows.';
  }
  if (kind === 'already-running') {
    return 'Engine is already running.';
  }
  if (kind === 'timeout') {
    return `${CATEGORY_ACTIONS[category]} timed out. Try again.`;
  }
  if (kind === 'connection') {
    return category === 'destination'
      ? 'Destination change failed. Connection lost.'
      : `${CATEGORY_ACTIONS[category]} failed. Connection lost.`;
  }

  switch (category) {
    case 'destination':
      switch (kind) {
        case 'rollback':
          return 'Destination change failed. Rollback incomplete.';
        case 'destination-busy':
          return 'Destination change already in progress.';
        case 'destination-stopping':
          return 'Engine is stopping. Try again.';
        case 'destination-unavailable':
          return 'Destination unavailable. Previous destination restored.';
        case 'destination-initialization':
          return 'Destination loaded but not initialized.';
        default:
          return CATEGORY_FALLBACKS.destination;
      }
    case 'temperament':
    case 'personality':
      if (kind === 'configuration') {
        return CATEGORY_FALLBACKS.configuration;
      }
      if (kind === 'browser') {
        return CATEGORY_FALLBACKS.browser;
      }
      return CATEGORY_FALLBACKS[category];
    case 'configuration':
      return CATEGORY_FALLBACKS.configuration;
    case 'browser':
      return CATEGORY_FALLBACKS.browser;
    default:
      if (kind === 'configuration') {
        return CATEGORY_FALLBACKS.configuration;
      }
      if (kind === 'browser') {
        return CATEGORY_FALLBACKS.browser;
      }
      return CATEGORY_FALLBACKS[category];
  }
}

export function logTuiDiagnostic(
  category: TuiErrorCategory,
  detail: unknown,
  prefix?: string,
): void {
  const reason = sanitizeLogText(describeError(detail));
  const label = prefix ?? `${CATEGORY_ACTIONS[category]} failed`;
  console.error(`[dashboard] ${label}: ${reason}`);
}

export function reportTuiError(category: TuiErrorCategory, detail: unknown): string {
  logTuiDiagnostic(category, detail);
  return formatTuiErrorMessage(category, detail);
}

export function reportTuiStatusPollingFailure(detail: unknown): void {
  logTuiDiagnostic('status', detail, 'Status polling failed');
}

export function reportTuiDestinationFailure(
  status: 'rejected' | 'failed',
  reason: string,
  resumed: boolean | undefined,
): string {
  logTuiDiagnostic('destination', reason, `Destination change ${status}`);
  const state = resumed === true ? 'Engine resumed.' : 'Engine remains paused.';
  return `${formatTuiErrorMessage('destination', reason)} ${state}`;
}
