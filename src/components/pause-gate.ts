export type PauseGateWaitResult = 'resumed' | 'cancelled';

export interface PauseGate {
  pause(): void;
  resume(): void;
  cancel(): void;
  isPaused(): boolean;
  isCancelled(): boolean;
  waitUntilResumed(): Promise<PauseGateWaitResult>;
}

export function createPauseGate(): PauseGate {
  let paused = false;
  let cancelled = false;
  let waiters: ((result: PauseGateWaitResult) => void)[] = [];

  const resolveWaiters = (result: PauseGateWaitResult): void => {
    const pendingWaiters = waiters;
    waiters = [];
    for (const resolve of pendingWaiters) {
      resolve(result);
    }
  };

  return {
    pause() {
      if (cancelled || paused) {
        return;
      }
      paused = true;
    },
    resume() {
      if (cancelled || !paused) {
        return;
      }
      paused = false;
      resolveWaiters('resumed');
    },
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      resolveWaiters('cancelled');
    },
    isPaused() {
      return paused;
    },
    isCancelled() {
      return cancelled;
    },
    waitUntilResumed() {
      if (cancelled) {
        return Promise.resolve('cancelled');
      }
      if (!paused) {
        return Promise.resolve('resumed');
      }
      return new Promise<PauseGateWaitResult>(resolve => waiters.push(resolve));
    },
  };
}
