/**
 * Resolve the API base URL.
 *
 * Priority:
 *   1. `?api_base=<url>` query parameter (tab-scoped, explicit confirmation)
 *   2. `VITE_API_URL` env variable
 *   3. Stored server URL from the connect screen (versioned key `server-url`, migrated from `paracord:server-url`)
 *   4. Relative `/api/v1` (works with the Vite dev proxy and production alike)
 */
import {
  getVersionedStorageItem,
  peekVersionedStorageItem,
  removeVersionedStorageItem,
  setVersionedStorageItem,
} from '../versionedStorage';
import { useServerListStore } from '../../stores/serverListStore';

export const SERVER_URL_KEY = 'server-url';

function normalizeServerBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (
      pathname === '/api' ||
      pathname === '/api/v1' ||
      pathname === '/health' ||
      pathname === '/api/v1/health'
    ) {
      pathname = '';
    }
    return `${parsed.protocol}//${parsed.host}${pathname}`.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * Normalise a raw connect-screen input into a canonical server base URL.
 *
 * - Trims surrounding whitespace.
 * - Adds a protocol when none is present: `http://` for loopback hosts
 *   (localhost / 127.0.0.1 / [::1]), `https://` for everything else.
 * - When the bare host (no explicit port) matches the current browser origin,
 *   returns that origin verbatim so a self-hosted UI connects back to itself.
 * - Strips trailing slashes.
 *
 * This is the single source of truth for connect-input normalisation; the
 * ServerConnectPage imports it rather than re-implementing the logic.
 */
export function normalizeConnectInput(raw: string): string {
  let serverUrl = raw.trim();
  if (!serverUrl) return serverUrl;
  if (!/^https?:\/\//i.test(serverUrl)) {
    const hostAndPort = serverUrl.split('/')[0];
    const hostPart = hostAndPort.split(':')[0];
    const hasExplicitPort = /:\d+$/.test(hostAndPort);
    if (
      typeof window !== 'undefined' &&
      hostPart.toLowerCase() === window.location.hostname.toLowerCase() &&
      !hasExplicitPort
    ) {
      return window.location.origin.replace(/\/+$/, '');
    }

    const isLocalhost =
      hostPart === 'localhost' || hostPart === '127.0.0.1' || hostPart === '[::1]';
    serverUrl = (isLocalhost ? 'http://' : 'https://') + serverUrl;
  }
  return serverUrl.replace(/\/+$/, '');
}

export function getStoredServerUrl(): string | null {
  try {
    const value = getVersionedStorageItem(SERVER_URL_KEY, ['server-url']);
    return value ? normalizeServerBaseUrl(value) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the current browser origin as a server URL when running from a
 * deployed Paracord server. Skips local dev to avoid pinning Vite origins.
 */
export function getCurrentOriginServerUrl(): string | null {
  if (typeof window === 'undefined') return null;
  if (import.meta.env.DEV) return null;
  if (!/^https?:$/.test(window.location.protocol)) return null;
  if (!window.location.host) return null;
  return `${window.location.protocol}//${window.location.host}`;
}

export function setStoredServerUrl(url: string): void {
  setVersionedStorageItem(SERVER_URL_KEY, normalizeServerBaseUrl(url));
}

export function clearStoredServerUrl(): void {
  removeVersionedStorageItem(SERVER_URL_KEY, ['server-url']);
}

const RUNTIME_SESSION_KEY = 'paracord:api-base-url-session';
const RUNTIME_LEGACY_KEY = 'paracord:api-base-url';

/**
 * The legacy persisted override is removed once per page, not per lookup.
 * `resolveApiBaseUrl` runs for every avatar, emoji and attachment URL a render
 * builds; two storage writes each time were most of what it cost.
 */
let runtimeLegacyCleared = false;

function clearRuntimeLegacyOverride(alsoSession: boolean): void {
  if (runtimeLegacyCleared) return;
  runtimeLegacyCleared = true;
  try {
    window.localStorage.removeItem(RUNTIME_LEGACY_KEY);
    if (alsoSession) window.sessionStorage.removeItem(RUNTIME_SESSION_KEY);
  } catch {
    // Ignore storage failures and fall back to non-override resolution.
  }
}

function getRuntimeApiBaseUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const allowRuntimeOverride = import.meta.env.DEV || import.meta.env.VITE_ENABLE_API_BASE_OVERRIDE === 'true';
  if (!allowRuntimeOverride) {
    // Remove legacy persisted override in production-safe builds.
    clearRuntimeLegacyOverride(true);
    return null;
  }

  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('api_base');
    if (fromQuery && /^https?:\/\//i.test(fromQuery)) {
      const existing = window.sessionStorage.getItem(RUNTIME_SESSION_KEY);
      if (existing === fromQuery) {
        return fromQuery;
      }

      const confirmed = window.confirm(
        `Temporarily override API base URL for this tab?\n\n${fromQuery}`
      );
      if (!confirmed) {
        return null;
      }
      window.sessionStorage.setItem(RUNTIME_SESSION_KEY, fromQuery);
      return fromQuery;
    }
    const fromSession = window.sessionStorage.getItem(RUNTIME_SESSION_KEY);
    if (fromSession && /^https?:\/\//i.test(fromSession)) {
      return fromSession;
    }
    clearRuntimeLegacyOverride(false);
  } catch {
    // Ignore malformed URL edge cases and fall back to env/default.
  }
  return null;
}

/**
 * The last answer, and the stored value it was built from.
 *
 * The stored server URL is the only input that changes while a production
 * page runs (the connect screen writes it, another tab can too), so a lookup
 * reads that one key and reuses the answer while it is unchanged — no parse,
 * no normalisation, no write. The first lookup also migrates a value still
 * under the legacy key, which nothing writes any more. The runtime override
 * is a development affordance that reads the page URL; it is not cached, so
 * `?api_base=` keeps working as it did.
 */
let cachedStored: string | null = null;
let cachedBase: string | null = null;

function storedServerUrlRaw(): string | null {
  try {
    return peekVersionedStorageItem(SERVER_URL_KEY);
  } catch {
    return null;
  }
}

export function resolveApiBaseUrl(): string {
  // 1. Legacy query-param / localStorage override
  const runtime = getRuntimeApiBaseUrl();
  if (runtime) return runtime;

  // 2. Env variable
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;

  // 3. Stored server URL from connect screen.
  if (cachedBase !== null && storedServerUrlRaw() === cachedStored) return cachedBase;
  const serverUrl = getStoredServerUrl();
  // 4. Relative path (same origin / Vite dev proxy)
  const base = serverUrl ? `${serverUrl.replace(/\/+$/, '')}/api/v1` : '/api/v1';
  cachedStored = storedServerUrlRaw();
  cachedBase = base;
  return base;
}

/** @deprecated Use resolveApiBaseUrl() for dynamic resolution instead. */
export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Build an absolute URL for a v2 API endpoint.  The legacy apiClient uses
 * `/api/v1` as its baseURL which means paths like `/v2/...` get incorrectly
 * concatenated as `/api/v1/v2/...`.  This helper resolves the server origin
 * and returns a full absolute URL that axios will use as-is.
 */
export function resolveV2ApiUrl(path: string): string {
  const base = resolveApiBaseUrl();
  let origin: string;
  if (base.startsWith('http')) {
    try {
      origin = new URL(base).origin;
    } catch {
      origin = typeof window !== 'undefined' ? window.location.origin : '';
    }
  } else {
    origin = typeof window !== 'undefined' ? window.location.origin : '';
  }
  return `${origin}/api/v2${path}`;
}

/**
 * Build an absolute URL for server-root endpoints that intentionally do not
 * live under `/api/v1`, such as federation's well-known `/_paracord/...`
 * routes.
 */
export function resolveServerRootUrl(path: string): string {
  const base = resolveApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let origin: string;
  if (base.startsWith('http')) {
    try {
      origin = new URL(base).origin;
    } catch {
      origin = typeof window !== 'undefined' ? window.location.origin : '';
    }
  } else {
    origin = typeof window !== 'undefined' ? window.location.origin : '';
  }
  return `${origin}${normalizedPath}`;
}

/** Origin of an API base URL; a relative base means "same origin as the page". */
const originByBase = new Map<string, string | null>();

function originOfApiBase(base: string): string | null {
  if (base.startsWith('http')) {
    // A handful of servers at most, and asked for every resource URL.
    const known = originByBase.get(base);
    if (known !== undefined) return known;
    let origin: string | null;
    try {
      origin = new URL(base).origin;
    } catch {
      origin = null;
    }
    if (originByBase.size >= 32) originByBase.clear();
    originByBase.set(base, origin);
    return origin;
  }
  if (typeof window === 'undefined') return null;
  if (!/^https?:$/.test(window.location.protocol)) return null;
  return window.location.origin;
}

/**
 * The origin of the HOME server — the one the connect screen stored — or null
 * when it cannot be determined.
 *
 * This is NOT the server whose data is currently on screen; see
 * {@link resolveActiveServerOrigin}. The home server is the only origin the
 * process-global access token (`authToken`) was ever issued for.
 */
export function resolveApiOrigin(): string | null {
  return originOfApiBase(resolveApiBaseUrl());
}

/**
 * The `/api/v1` base URL of the server the UI is currently focused on.
 *
 * `resolveApiBaseUrl()` answers a different question — "which server did the
 * connect screen store" — and under multi-server the two diverge the moment the
 * user switches spaces: `activeServerId` moves and the stored URL does not.
 * Anything that pairs a credential with a target (a download ticket appended to
 * a resource URL) has to follow the *active* server, otherwise a ticket minted
 * at one server is attached to a URL served by another.
 */
let activeUrlSeen: string | null = null;
let activeBaseSeen = '';

function resolveActiveServerBaseUrl(): string {
  const { servers, activeServerId } = useServerListStore.getState();
  const activeUrl = activeServerId
    ? servers.find((s) => s.id === activeServerId)?.url?.trim()
    : undefined;
  if (activeUrl) {
    // Every resource URL a render builds comes through here; the URL parse in
    // the normalisation is paid once per server switch, not once per avatar.
    if (activeUrl !== activeUrlSeen) {
      activeBaseSeen = `${normalizeServerBaseUrl(activeUrl)}/api/v1`;
      activeUrlSeen = activeUrl;
    }
    return activeBaseSeen;
  }
  // No active entry (bootstrap, or the LOCAL-only connection) — the home
  // server is the active one.
  return resolveApiBaseUrl();
}

/**
 * The origin of the active server, or null when it cannot be determined. Used
 * to decide who is allowed to receive a download ticket.
 */
export function resolveActiveServerOrigin(): string | null {
  return originOfApiBase(resolveActiveServerBaseUrl());
}

/**
 * Build an absolute resource URL suitable for `<img>` src and similar
 * browser-native fetches that cannot carry an Authorization header.
 *
 * Relative paths resolve against the ACTIVE server, and `?ticket=<download_ticket>`
 * is appended ONLY when the target origin is that same active server. Tickets
 * are minted and cached per active server (see `lib/downloadTicket`), so any
 * other target origin — including the home server the connect screen stored —
 * would receive a credential it did not issue.
 *
 * The download ticket is a multi-use bearer credential accepted on
 * attachment/emoji/sticker/avatar/federated-file endpoints, so "origin differs
 * from the page" is not a sufficient test: values such as `avatar_hash` may be
 * arbitrary absolute URLs chosen by another user, and on desktop the page
 * origin is `tauri://localhost`, which differs from *every* http(s) origin.
 * Attaching the ticket on that basis handed it to any host an attacker could
 * name.
 *
 * @param path - relative path, absolute path, or full URL
 * @param ticket - download ticket to append for same-active-server auth
 */
/**
 * True when a browser-native load of `url` can only be authenticated by a
 * download ticket — the target is the active server and the page is a different
 * origin, so no cookie travels and an `<img>`/`<video>` cannot set a header.
 *
 * The desktop shell is always this case: its page origin is `tauri://localhost`.
 * A self-hosted web UI served by the same server is never this case; it
 * authenticates with its own cookies.
 */
export function resourceNeedsDownloadTicket(url: string): boolean {
  if (!url.startsWith('http')) return false;
  try {
    const parsed = new URL(url);
    const apiOrigin = resolveActiveServerOrigin();
    const pageOrigin = typeof window !== 'undefined' ? window.location.origin : null;
    return apiOrigin !== null && parsed.origin === apiOrigin && parsed.origin !== pageOrigin;
  } catch {
    return false;
  }
}

export function resolveResourceUrl(path: string, ticket?: string | null): string {
  const base = resolveActiveServerBaseUrl();
  let url: string;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    url = path;
  } else if (path.startsWith('/')) {
    // Absolute path — prefix with the API base origin if available.
    if (base.startsWith('http')) {
      try {
        const parsed = new URL(base);
        url = `${parsed.origin}${path}`;
      } catch {
        url = path;
      }
    } else {
      url = path;
    }
  } else {
    url = `${base}/${path}`;
  }
  // Append the download ticket only for the server that minted it, and only
  // when the browser will not already authenticate the request with cookies.
  const authTicket = ticket ?? null;
  if (authTicket && url.startsWith('http')) {
    try {
      const parsed = new URL(url);
      const apiOrigin = resolveActiveServerOrigin();
      const pageOrigin = typeof window !== 'undefined' ? window.location.origin : null;
      if (apiOrigin && parsed.origin === apiOrigin && parsed.origin !== pageOrigin) {
        parsed.searchParams.set('ticket', authTicket);
        return parsed.toString();
      }
    } catch {
      // fall through
    }
  }
  return url;
}
