type Waiter<T> = (value: T) => void;

type AccountTaskControl = {
  addInProgress: boolean;
  pauseRequested: boolean;
  paused: boolean;
  pauseWaiters: Array<Waiter<boolean>>;
  resumeWaiters: Array<Waiter<void>>;
};

const controls = new Map<string, AccountTaskControl>();

function getControl(accountId: string): AccountTaskControl {
  const id = String(accountId || '').trim();
  if (!id) {
    return {
      addInProgress: false,
      pauseRequested: false,
      paused: false,
      pauseWaiters: [],
      resumeWaiters: [],
    };
  }

  const existing = controls.get(id);
  if (existing) return existing;

  const created: AccountTaskControl = {
    addInProgress: false,
    pauseRequested: false,
    paused: false,
    pauseWaiters: [],
    resumeWaiters: [],
  };
  controls.set(id, created);
  return created;
}

export function markAddStart(accountId: string): void {
  const id = String(accountId || '').trim();
  if (!id) return;
  const c = getControl(id);
  c.addInProgress = true;
}

export function markAddEnd(accountId: string): void {
  const id = String(accountId || '').trim();
  if (!id) return;
  const c = getControl(id);
  c.addInProgress = false;
  c.pauseRequested = false;
  c.paused = false;

  for (const resolve of c.pauseWaiters) resolve(false);
  c.pauseWaiters = [];
  for (const resolve of c.resumeWaiters) resolve();
  c.resumeWaiters = [];
}

export function isAddInProgress(accountId: string): boolean {
  const id = String(accountId || '').trim();
  if (!id) return false;
  const c = controls.get(id);
  return Boolean(c?.addInProgress);
}

export function isPauseRequested(accountId: string): boolean {
  const id = String(accountId || '').trim();
  if (!id) return false;
  const c = controls.get(id);
  return Boolean(c?.pauseRequested);
}

export function requestPauseForAdd(accountId: string): Promise<boolean> {
  const id = String(accountId || '').trim();
  if (!id) return Promise.resolve(false);

  const c = getControl(id);
  if (!c.addInProgress) return Promise.resolve(false);

  c.pauseRequested = true;
  if (c.paused) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    c.pauseWaiters.push(resolve);
  });
}

export function requestPauseForAddWithTimeout(accountId: string, timeoutMs: number): Promise<boolean> {
  const id = String(accountId || '').trim();
  if (!id) return Promise.resolve(false);

  const c = getControl(id);
  if (!c.addInProgress) return Promise.resolve(false);

  const ms = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
  if (ms <= 0) return requestPauseForAdd(id);

  c.pauseRequested = true;
  if (c.paused) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const waiter: Waiter<boolean> = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    c.pauseWaiters.push(waiter);

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      c.pauseWaiters = c.pauseWaiters.filter((w) => w !== waiter);
      if (c.addInProgress && !c.paused && c.pauseWaiters.length === 0) {
        c.pauseRequested = false;
      }
      resolve(false);
    }, ms);
  });
}

export function notifyPausedAtSafePoint(accountId: string): void {
  const id = String(accountId || '').trim();
  if (!id) return;
  const c = controls.get(id);
  if (!c || !c.addInProgress || !c.pauseRequested || c.paused) return;

  c.paused = true;
  for (const resolve of c.pauseWaiters) resolve(true);
  c.pauseWaiters = [];
}

export function resumeAdd(accountId: string): boolean {
  const id = String(accountId || '').trim();
  if (!id) return false;
  const c = controls.get(id);
  if (!c) return false;

  const wasRequested = c.pauseRequested || c.paused;
  c.pauseRequested = false;
  c.paused = false;

  for (const resolve of c.resumeWaiters) resolve();
  c.resumeWaiters = [];

  return wasRequested;
}

export function waitUntilResumed(accountId: string): Promise<void> {
  const id = String(accountId || '').trim();
  if (!id) return Promise.resolve();
  const c = controls.get(id);
  if (!c || !c.pauseRequested) return Promise.resolve();

  return new Promise<void>((resolve) => {
    c.resumeWaiters.push(resolve);
  });
}
