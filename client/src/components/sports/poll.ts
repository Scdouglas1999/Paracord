import { LIVE_POLL_MS, QUIET_POLL_MS } from './model';

export type SportsPollKind = 'page' | 'sidebar';

interface PollSlot {
  page: number;
  sidebar: number;
}

interface PollDeps {
  refresh: (guildId: string) => Promise<void>;
  enabled: (guildId: string) => boolean;
  games: (guildId: string) => { state: string }[];
}

const slots = new Map<string, PollSlot>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastFetch = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
let deps: PollDeps | null = null;
let listening = false;

export function configureSportsPolling(next: PollDeps) {
  deps = next;
}

export function resetSportsPolling() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  slots.clear();
  lastFetch.clear();
  inflight.clear();
  if (listening) {
    document.removeEventListener('visibilitychange', onVisibility);
    listening = false;
  }
}

function clearTimer(guildId: string) {
  const timer = timers.get(guildId);
  if (timer != null) clearTimeout(timer);
  timers.delete(guildId);
}

function intervalFor(guildId: string, slot: PollSlot): number {
  if (slot.page > 0) {
    const live = deps?.games(guildId).some((game) => game.state === 'in') ?? false;
    if (live) return LIVE_POLL_MS;
  }
  return QUIET_POLL_MS;
}

function shouldRun(guildId: string): boolean {
  const slot = slots.get(guildId);
  if (!slot || slot.page + slot.sidebar === 0) return false;
  if (document.hidden) return false;
  return deps?.enabled(guildId) === true;
}

function arm(guildId: string, delay: number) {
  clearTimer(guildId);
  if (!shouldRun(guildId)) return;
  timers.set(guildId, setTimeout(() => {
    void fetchOnce(guildId);
  }, delay));
}

async function fetchOnce(guildId: string): Promise<void> {
  if (!shouldRun(guildId) || !deps) return;
  const existing = inflight.get(guildId);
  if (existing) {
    await existing;
    return;
  }
  const task = (async () => {
    try {
      await deps?.refresh(guildId);
    } finally {
      lastFetch.set(guildId, Date.now());
      inflight.delete(guildId);
    }
  })();
  inflight.set(guildId, task);
  await task;
  const slot = slots.get(guildId);
  if (slot && shouldRun(guildId)) arm(guildId, intervalFor(guildId, slot));
}

function poke(guildId: string) {
  const slot = slots.get(guildId);
  if (!slot || !shouldRun(guildId)) {
    clearTimer(guildId);
    return;
  }
  const interval = intervalFor(guildId, slot);
  const elapsed = Date.now() - (lastFetch.get(guildId) ?? Number.NEGATIVE_INFINITY);
  if (elapsed >= interval) void fetchOnce(guildId);
  else arm(guildId, interval - elapsed);
}

function onVisibility() {
  if (document.hidden) {
    for (const guildId of timers.keys()) clearTimer(guildId);
    return;
  }
  for (const guildId of slots.keys()) void fetchOnce(guildId);
}

function ensureListener() {
  if (listening) return;
  document.addEventListener('visibilitychange', onVisibility);
  listening = true;
}

/** One schedule per server. Page and sidebar share it, so they cannot both fetch inside one interval. */
export function watchSportsBoard(guildId: string, kind: SportsPollKind): () => void {
  const slot = slots.get(guildId) ?? { page: 0, sidebar: 0 };
  slot[kind] += 1;
  slots.set(guildId, slot);
  ensureListener();
  poke(guildId);
  return () => {
    slot[kind] = Math.max(0, slot[kind] - 1);
    if (slot.page + slot.sidebar === 0) {
      slots.delete(guildId);
      clearTimer(guildId);
    } else {
      poke(guildId);
    }
    if (slots.size === 0 && listening) {
      document.removeEventListener('visibilitychange', onVisibility);
      listening = false;
    }
  };
}
