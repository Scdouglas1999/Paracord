import { secureDelete, secureGet, secureSet } from './secureStorage';
import { isTauri } from './tauriEnv';

let accessToken: string | null = null;
let refreshTokenCache: string | null = null;
let refreshTokenHydrationPromise: Promise<void> | null = null;

const LEGACY_REFRESH_TOKEN_KEY = 'paracord:refresh-token';
const SECURE_REFRESH_TOKEN_KEY = 'paracord:auth:refresh-token';
const CSRF_COOKIE_NAME = 'paracord_csrf';

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
}

export async function hydrateRefreshTokenStorage(): Promise<void> {
  if (!isTauri()) {
    refreshTokenCache = readLegacyRefreshToken();
    return;
  }

  if (refreshTokenHydrationPromise) {
    return refreshTokenHydrationPromise;
  }

  refreshTokenHydrationPromise = (async () => {
    const secureToken = normalizeToken(
      await secureGet(SECURE_REFRESH_TOKEN_KEY).catch(() => null),
    );
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
    refreshTokenHydrationPromise = null;
  });

  return refreshTokenHydrationPromise;
}

export function getRefreshToken(): string | null {
  if (refreshTokenCache !== null) {
    return refreshTokenCache;
  }
  if (!isTauri()) {
    refreshTokenCache = readLegacyRefreshToken();
  }
  return refreshTokenCache;
}

export function setRefreshToken(token: string | null): void {
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

  writeLegacyRefreshToken(normalized);
}

export function clearLegacyPersistedAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('auth-storage');
}
