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
 * base URL inside its request interceptor (so "Add Server" applies without a
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
  if (!serverKey) return null;

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
