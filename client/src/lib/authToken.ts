import { secureDelete, secureGet, secureSet } from './secureStorage';
import { isTauri } from './tauriEnv';

let accessToken: string | null = null;
let refreshTokenCache: string | null = null;
let refreshTokenRevision = 0;
let refreshTokenHydrationPromise: Promise<void> | null = null;

const LEGACY_REFRESH_TOKEN_KEY = 'paracord:refresh-token';
const SECURE_REFRESH_TOKEN_KEY = 'paracord:auth:refresh-token';
// Older web builds wrapped the refresh token in localStorage under an AES-GCM
// key kept in IndexedDB. Because the key is fully usable for decrypt by any
// same-origin script, that wrapping provided no confidentiality against XSS
// (the key and ciphertext are both same-origin readable). We no longer persist
// the refresh token in web storage at all — these identifiers exist only so we
// can purge any value/key material left behind by those older builds.
const WRAPPED_REFRESH_TOKEN_KEY = 'paracord:auth:refresh-token';
const WRAP_KEY_DB = 'paracord-auth';
const CSRF_COOKIE_NAME = 'paracord_csrf';
// The refresh cookie is HttpOnly, so a cold page load cannot see whether this
// browser holds a session — it used to find out by asking, which answered 401
// for every first-time visitor, once per page view, in the browser console and
// in the server log. This readable marker records only that a session once
// existed here; it carries no credential and is cleared by signing out or by a
// refusal from the refresh endpoint itself.
const SESSION_HINT_KEY = 'paracord:auth:session-seen';

function normalizeToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function readLegacyRefreshToken(): string | null {
  try {
    return normalizeToken(localStorage.getItem(LEGACY_REFRESH_TOKEN_KEY));
  } catch {
    return null;
  }
}

function clearLegacyRefreshToken(): void {
  try {
    localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function writeLegacyRefreshToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(LEGACY_REFRESH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function clearWrappedRefreshToken(): void {
  try {
    localStorage.removeItem(WRAPPED_REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

// Delete the IndexedDB database that older builds used to hold the at-rest
// wrap key, so a previously-persisted key can no longer be used to recover any
// leaked ciphertext.
function deleteWrapKeyStore(): void {
  try {
    if (typeof indexedDB !== 'undefined') {
      indexedDB.deleteDatabase(WRAP_KEY_DB);
    }
  } catch {
    // Ignore storage failures.
  }
}

async function hydrateWebRefreshTokenStorage(): Promise<void> {
  // Web builds keep the refresh token in memory only — a page reload forces
  // re-authentication (cross-origin) or a silent refresh via the HttpOnly
  // cookie (same-origin). Purge any refresh token wrapped at rest by older
  // builds, including the IndexedDB wrap key, since that storage was
  // XSS-recoverable and offered no real protection.
  clearWrappedRefreshToken();
  deleteWrapKeyStore();

  const legacyToken = readLegacyRefreshToken();
  if (legacyToken) {
    refreshTokenCache = legacyToken;
    clearLegacyRefreshToken();
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getCsrfToken(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name !== CSRF_COOKIE_NAME) {
      continue;
    }
    const value = rest.join('=').trim();
    if (!value) {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function setAccessToken(token: string | null): void {
  accessToken = normalizeToken(token);
  // Only ever set here. A transient clear (a failed refresh mid-session, a
  // teardown before a retry) must not cost the next cold load its session, so
  // the marker is dropped by sign-out and by an unauthorized refresh alone.
  if (accessToken) noteSessionEstablished();
}

/** Record that this origin has held a session, for the next cold load. */
export function noteSessionEstablished(): void {
  try {
    localStorage.setItem(SESSION_HINT_KEY, '1');
  } catch {
    // A browser refusing storage simply keeps the old ask-and-see behaviour.
  }
}

export function clearSessionHint(): void {
  try {
    localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/** Whether a session has ever been established on this origin. */
export function hasSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    // Unreadable storage must not lock anyone out: ask the server instead.
    return true;
  }
}

export async function hydrateRefreshTokenStorage(): Promise<void> {
  if (!isTauri()) {
    await hydrateWebRefreshTokenStorage();
    return;
  }

  if (refreshTokenHydrationPromise) {
    return refreshTokenHydrationPromise;
  }

  const revision = refreshTokenRevision;
  const hydration = (async () => {
    const secureToken = normalizeToken(
      await secureGet(SECURE_REFRESH_TOKEN_KEY).catch(() => null),
    );
    if (revision !== refreshTokenRevision) return;
    if (secureToken) {
      refreshTokenCache = secureToken;
      writeLegacyRefreshToken(null);
      return;
    }

    const legacyToken = readLegacyRefreshToken();
    refreshTokenCache = legacyToken;
    if (legacyToken) {
      await secureSet(SECURE_REFRESH_TOKEN_KEY, legacyToken).catch(() => undefined);
      writeLegacyRefreshToken(null);
    }
  })().finally(() => {
    if (refreshTokenHydrationPromise === hydration) refreshTokenHydrationPromise = null;
  });
  refreshTokenHydrationPromise = hydration;
  return hydration;
}

export function getRefreshToken(): string | null {
  return refreshTokenCache;
}

export function setRefreshToken(token: string | null): void {
  refreshTokenRevision += 1;
  refreshTokenHydrationPromise = null;
  const normalized = normalizeToken(token);
  refreshTokenCache = normalized;

  if (isTauri()) {
    if (normalized) {
      void secureSet(SECURE_REFRESH_TOKEN_KEY, normalized);
    } else {
      void secureDelete(SECURE_REFRESH_TOKEN_KEY);
    }
    writeLegacyRefreshToken(null);
    return;
  }

  // Web builds never persist the refresh token at rest: it lives only in
  // memory (refreshTokenCache above). Same-origin deployments recover it after
  // reload via the HttpOnly refresh cookie; cross-origin deployments require
  // re-authentication. Clear any legacy/wrapped copies a prior build wrote.
  clearLegacyRefreshToken();
  clearWrappedRefreshToken();
  deleteWrapKeyStore();
}

export function clearLegacyPersistedAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('auth-storage');
}
