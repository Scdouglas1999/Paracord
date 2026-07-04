import { getApi } from '../api/activeClient';
import { resolveApiBaseUrl } from './config/apiBaseUrl';

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
let fetchPromise: Promise<string | null> | null = null;

function currentServerKey(): string {
  return resolveApiBaseUrl();
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
  if (!cache || cache.serverKey !== serverKey) {
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

async function fetchDownloadTicket(): Promise<string | null> {
  const resp = await getApi().post<{ ticket?: string }>('/download/ticket');
  const ticket = resp.data?.ticket?.trim();
  return ticket || null;
}

export async function ensureDownloadTicket(): Promise<string | null> {
  const serverKey = currentServerKey();
  if (cache && cache.serverKey === serverKey && cache.ticket) {
    scheduleProactiveRefresh();
    return cache.ticket;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const ticket = await fetchDownloadTicket();
      if (ticket) {
        storeTicket(serverKey, ticket);
      }
      return ticket;
    } catch {
      return null;
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

export function startDownloadTicketLifecycle(): void {
  void ensureDownloadTicket();
}

/** Test helper: inject a cached ticket without hitting the network. */
export function setDownloadTicketForTests(ticket: string): void {
  storeTicket(currentServerKey(), ticket);
}
