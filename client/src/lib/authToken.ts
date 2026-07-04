import { resolveApiBaseUrl } from './config/apiBaseUrl';
import { secureDelete, secureGet, secureSet } from './secureStorage';
import { isTauri } from './tauriEnv';

let accessToken: string | null = null;
let refreshTokenCache: string | null = null;
let refreshTokenHydrationPromise: Promise<void> | null = null;

const LEGACY_REFRESH_TOKEN_KEY = 'paracord:refresh-token';
const SECURE_REFRESH_TOKEN_KEY = 'paracord:auth:refresh-token';
const WRAPPED_REFRESH_TOKEN_KEY = 'paracord:auth:refresh-token';
const WRAP_KEY_DB = 'paracord-auth';
const WRAP_KEY_STORE = 'wrap-keys';
const WRAP_KEY_ID = 'refresh-v1';
const CSRF_COOKIE_NAME = 'paracord_csrf';

function normalizeToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function isSameOriginWebApi(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  const base = resolveApiBaseUrl();
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    return true;
  }
  try {
    return new URL(base).origin === window.location.origin;
  } catch {
    return true;
  }
}

function webPersistsRefreshTokenAtRest(): boolean {
  return !isSameOriginWebApi();
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function canUseWebCryptoWrap(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof indexedDB !== 'undefined'
  );
}

function openWrapKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WRAP_KEY_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(WRAP_KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('indexedDB get failed'));
  });
}

function idbPut(db: IDBDatabase, storeName: string, key: string, value: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB put failed'));
    tx.objectStore(storeName).put(value, key);
  });
}

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const db = await openWrapKeyDb();
  const existing = await idbGet<CryptoKey>(db, WRAP_KEY_STORE, WRAP_KEY_ID);
  if (existing) {
    return existing;
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await idbPut(db, WRAP_KEY_STORE, WRAP_KEY_ID, key);
  return key;
}

function readWrappedRefreshTokenPayload(): string | null {
  try {
    return localStorage.getItem(WRAPPED_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function clearWrappedRefreshToken(): void {
  try {
    localStorage.removeItem(WRAPPED_REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

async function decryptWrappedRefreshToken(payload: string): Promise<string | null> {
  if (!canUseWebCryptoWrap()) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as { iv?: string; ct?: string };
    if (typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') {
      return null;
    }
    const key = await getOrCreateWrapKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parsed.iv) },
      key,
      base64ToBytes(parsed.ct),
    );
    return normalizeToken(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

async function persistWrappedRefreshToken(token: string): Promise<void> {
  if (!canUseWebCryptoWrap()) {
    return;
  }
  try {
    const key = await getOrCreateWrapKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(token),
    );
    localStorage.setItem(
      WRAPPED_REFRESH_TOKEN_KEY,
      JSON.stringify({
        iv: bytesToBase64(iv),
        ct: bytesToBase64(new Uint8Array(ciphertext)),
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

async function hydrateWebRefreshTokenStorage(): Promise<void> {
  const legacyToken = readLegacyRefreshToken();
  if (webPersistsRefreshTokenAtRest()) {
    const wrappedPayload = readWrappedRefreshTokenPayload();
    if (wrappedPayload) {
      const wrappedToken = await decryptWrappedRefreshToken(wrappedPayload);
      if (wrappedToken) {
        refreshTokenCache = wrappedToken;
      }
    }
  }

  if (legacyToken) {
    refreshTokenCache = legacyToken;
    clearLegacyRefreshToken();
    if (webPersistsRefreshTokenAtRest()) {
      await persistWrappedRefreshToken(legacyToken);
    } else {
      clearWrappedRefreshToken();
    }
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
    await hydrateWebRefreshTokenStorage();
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

  clearLegacyRefreshToken();
  if (webPersistsRefreshTokenAtRest()) {
    if (normalized) {
      void persistWrappedRefreshToken(normalized);
    } else {
      clearWrappedRefreshToken();
    }
    return;
  }

  clearWrappedRefreshToken();
}

export function clearLegacyPersistedAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('auth-storage');
}
