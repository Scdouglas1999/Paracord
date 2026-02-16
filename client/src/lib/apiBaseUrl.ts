/**
 * Resolve the API base URL.
 *
 * Priority:
 *   1. `?api_base=<url>` query parameter (tab-scoped, explicit confirmation)
 *   2. `VITE_API_URL` env variable
 *   3. Stored server URL from the connect screen (`paracord:server-url`)
 *   4. Relative `/api/v1` (works with the Vite dev proxy and production alike)
 */

export const SERVER_URL_KEY = 'paracord:server-url';

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

export function getStoredServerUrl(): string | null {
  try {
    const value = window.localStorage.getItem(SERVER_URL_KEY);
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
  window.localStorage.setItem(SERVER_URL_KEY, normalizeServerBaseUrl(url));
}

export function clearStoredServerUrl(): void {
  window.localStorage.removeItem(SERVER_URL_KEY);
}

function getRuntimeApiBaseUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const allowRuntimeOverride = import.meta.env.DEV || import.meta.env.VITE_ENABLE_API_BASE_OVERRIDE === 'true';
  const sessionKey = 'paracord:api-base-url-session';
  const legacyKey = 'paracord:api-base-url';
  if (!allowRuntimeOverride) {
    // Remove legacy persisted override in production-safe builds.
    try {
      window.localStorage.removeItem(legacyKey);
      window.sessionStorage.removeItem(sessionKey);
    } catch {
      // Ignore storage failures and fall back to non-override resolution.
    }
    return null;
  }

  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('api_base');
    if (fromQuery && /^https?:\/\//i.test(fromQuery)) {
      const existing = window.sessionStorage.getItem(sessionKey);
      if (existing === fromQuery) {
        return fromQuery;
      }

      const confirmed = window.confirm(
        `Temporarily override API base URL for this tab?\n\n${fromQuery}`
      );
      if (!confirmed) {
        return null;
      }
      window.sessionStorage.setItem(sessionKey, fromQuery);
      return fromQuery;
    }
    const fromSession = window.sessionStorage.getItem(sessionKey);
    if (fromSession && /^https?:\/\//i.test(fromSession)) {
      return fromSession;
    }
    window.localStorage.removeItem(legacyKey);
  } catch {
    // Ignore malformed URL edge cases and fall back to env/default.
  }
  return null;
}

export function resolveApiBaseUrl(): string {
  // 1. Legacy query-param / localStorage override
  const runtime = getRuntimeApiBaseUrl();
  if (runtime) return runtime;

  // 2. Env variable
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;

  // 3. Stored server URL from connect screen
  const serverUrl = getStoredServerUrl();
  if (serverUrl) {
    // Strip trailing slash and append /api/v1
    return `${serverUrl.replace(/\/+$/, '')}/api/v1`;
  }

  // 4. Relative path (same origin / Vite dev proxy)
  return '/api/v1';
}

export const API_BASE_URL = resolveApiBaseUrl();
