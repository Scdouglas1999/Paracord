import { getApi } from '../api/activeClient';
import { connectionManager } from './connectionManager';
import { resolveActiveServerOrigin, resolveApiBaseUrl } from './config/apiBaseUrl';

/** Must stay in sync with server `DOWNLOAD_TICKET_TTL` (240s). */
const DOWNLOAD_TICKET_TTL_MS = 240_000;
/** Refresh one minute before expiry so `<img>` loads never hit an expired ticket. */
const DOWNLOAD_TICKET_REFRESH_MS = DOWNLOAD_TICKET_TTL_MS - 60_000;

interface DownloadTicketCache {
  serverKey: string;
  ticket: string;
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

let cache: DownloadTicketCache | null = null;
let fetchPromise: { serverKey: string; promise: Promise<string | null> } | null = null;

/**
 * Everything that has an `<img src>` on screen whose URL carries a ticket.
 *
 * A ticket arrives asynchronously, but the URL builders that need it are plain
 * functions read during render. Without a notification the first paint wins
 * forever: whatever rendered before the mint landed keeps a ticket-less URL,
 * the server answers 401, and nothing ever asks again. Every avatar, custom
 * emoji and sticker in the app went through that path.
 */
const listeners = new Set<() => void>();

function notifyTicketChanged(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to ticket changes (React `useSyncExternalStore` shape).
 *
 * Subscribing is also the signal that something on screen NEEDS a ticket, so
 * it starts a mint when none is cached. That is the one reliable trigger:
 * `startDownloadTicketLifecycle` fires on login and on an active-server
 * change, and both can land while the active server and the client that would
 * mint for it still disagree.
 */
export function subscribeDownloadTicket(listener: () => void): () => void {
  listeners.add(listener);
  if (!getDownloadTicket()) {
    void ensureDownloadTicket();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Origin of an API base URL, treating a relative base as the page origin. */
function originOfApiBase(base: string): string | null {
  if (base.startsWith('http')) {
    try {
      return new URL(base).origin;
    } catch {
      return null;
    }
  }
  if (typeof window === 'undefined') return null;
  if (!/^https?:$/.test(window.location.protocol)) return null;
  return window.location.origin;
}

/**
 * Origin of the axios instance that `fetchDownloadTicket` would actually mint
 * through — i.e. what `getApi()` resolves to, decomposed so we can tell the two
 * cases apart.
 *
 * A per-server client is built with a fixed base URL paired to that server's
 * own token, so its `defaults.baseURL` is authoritative. With no per-server
 * client, `getApi()` falls back to the LOCAL singleton, which re-resolves its
 * base URL inside its request interceptor (so "Add server" applies without a
 * reload) — its `defaults.baseURL` is a stale snapshot, so ask the resolver.
 */
function mintingOrigin(): string | null {
  const activeClient = connectionManager.getActiveApiClient();
  if (!activeClient) {
    return originOfApiBase(resolveApiBaseUrl());
  }
  return originOfApiBase(activeClient.defaults.baseURL ?? '');
}

/**
 * The one server a ticket is minted at, cached under, and valid for — a single
 * value so those three can never drift apart.
 *
 * Returns null when the client that would mint the ticket is not the client for
 * the active server. That happens transiently while the active server's
 * connection is still coming up, and minting then would cache a credential
 * issued by server A under server B's key — exactly the confusion this key
 * exists to prevent — so we mint nothing until the two agree.
 */
function currentServerKey(): string | null {
  const active = resolveActiveServerOrigin();
  if (!active) return null;
  return mintingOrigin() === active ? active : null;
}

/**
 * Retry state for "the active server and the minting client do not agree yet".
 *
 * `currentServerKey()` is null for a window after sign-in and after an
 * "Add server", while the per-server connection is still coming up. Minting
 * then would cache server A's credential under server B's key, so we must not
 * — but returning null and stopping was worse: nothing re-ran, so an account
 * could sit with no ticket for its whole session and answer every image with a
 * 401. Retry until the two agree, then give up loudly rather than silently.
 */
const SERVER_KEY_RETRY_MS = 250;
const SERVER_KEY_RETRY_MAX_MS = 4000;
const SERVER_KEY_RETRY_DEADLINE_MS = 60_000;
let serverKeyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let serverKeyRetryDelay = SERVER_KEY_RETRY_MS;
let serverKeyRetryStartedAt: number | null = null;

function cancelServerKeyRetry(): void {
  if (serverKeyRetryTimer) clearTimeout(serverKeyRetryTimer);
  serverKeyRetryTimer = null;
  serverKeyRetryDelay = SERVER_KEY_RETRY_MS;
  serverKeyRetryStartedAt = null;
}

function scheduleServerKeyRetry(): void {
  if (serverKeyRetryTimer) return;
  const now = Date.now();
  if (serverKeyRetryStartedAt === null) serverKeyRetryStartedAt = now;
  if (now - serverKeyRetryStartedAt > SERVER_KEY_RETRY_DEADLINE_MS) {
    console.error(
      '[download-ticket] No active server has claimed this session after 60s; ' +
        'avatars, custom emoji and stickers cannot be authenticated for it.',
    );
    cancelServerKeyRetry();
    return;
  }
  const delay = serverKeyRetryDelay;
  serverKeyRetryDelay = Math.min(serverKeyRetryDelay * 2, SERVER_KEY_RETRY_MAX_MS);
  serverKeyRetryTimer = setTimeout(() => {
    serverKeyRetryTimer = null;
    void ensureDownloadTicket();
  }, delay);
}

function scheduleProactiveRefresh(): void {
  if (!cache) return;
  if (cache.refreshTimer) {
    clearTimeout(cache.refreshTimer);
  }
  cache.refreshTimer = setTimeout(() => {
    void ensureDownloadTicket();
  }, DOWNLOAD_TICKET_REFRESH_MS);
}

function storeTicket(serverKey: string, ticket: string): void {
  if (cache?.refreshTimer) {
    clearTimeout(cache.refreshTimer);
  }
  cache = {
    serverKey,
    ticket,
    refreshTimer: setTimeout(() => {
      void ensureDownloadTicket();
    }, DOWNLOAD_TICKET_REFRESH_MS),
  };
  cancelServerKeyRetry();
  notifyTicketChanged();
}

export function getDownloadTicket(): string | null {
  const serverKey = currentServerKey();
  if (!serverKey || !cache || cache.serverKey !== serverKey) {
    return null;
  }
  return cache.ticket;
}

export function clearDownloadTicketCache(): void {
  if (cache?.refreshTimer) {
    clearTimeout(cache.refreshTimer);
  }
  cache = null;
  fetchPromise = null;
  cancelServerKeyRetry();
  notifyTicketChanged();
}

/**
 * Mint a ticket. The path is deliberately relative so it resolves against the
 * active client's own base URL and travels with that client's own token —
 * callers must have confirmed via `currentServerKey()` that this is the active
 * server before getting here.
 */
async function fetchDownloadTicket(): Promise<string | null> {
  const resp = await getApi().post<{ ticket?: string }>('/download/ticket');
  const ticket = resp.data?.ticket?.trim();
  return ticket || null;
}

export async function ensureDownloadTicket(): Promise<string | null> {
  const serverKey = currentServerKey();
  if (!serverKey) {
    scheduleServerKeyRetry();
    return null;
  }
  cancelServerKeyRetry();

  if (cache && cache.serverKey === serverKey && cache.ticket) {
    scheduleProactiveRefresh();
    return cache.ticket;
  }

  // The in-flight guard is per server: reusing a fetch started for a different
  // server would hand back that server's ticket for this one.
  if (fetchPromise && fetchPromise.serverKey === serverKey) {
    return fetchPromise.promise;
  }

  const pending = {
    serverKey,
    promise: (async () => {
      try {
        const ticket = await fetchDownloadTicket();
        // The active server can change while the mint is in flight; a ticket
        // that arrives after the switch belongs to the server we left.
        if (ticket && currentServerKey() === serverKey) {
          storeTicket(serverKey, ticket);
          return ticket;
        }
        return null;
      } catch {
        // A mint that failed (server down, token mid-refresh) must be retried:
        // every ticketed image on screen is waiting on it.
        scheduleServerKeyRetry();
        return null;
      } finally {
        if (fetchPromise?.serverKey === serverKey) {
          fetchPromise = null;
        }
      }
    })(),
  };
  fetchPromise = pending;

  return pending.promise;
}

export function startDownloadTicketLifecycle(): void {
  void ensureDownloadTicket();
}

/** Test helper: inject a cached ticket without hitting the network. */
export function setDownloadTicketForTests(ticket: string): void {
  const serverKey = currentServerKey();
  if (!serverKey) return;
  storeTicket(serverKey, ticket);
}
