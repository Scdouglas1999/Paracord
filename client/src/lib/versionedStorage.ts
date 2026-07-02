const STORAGE_NAMESPACE = 'paracord';
const STORAGE_VERSION = 'v2';

function versionedKey(base: string): string {
  return `${STORAGE_NAMESPACE}:${STORAGE_VERSION}:${base}`;
}

function legacyKey(base: string): string {
  return `${STORAGE_NAMESPACE}:${base}`;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function migrateLegacyValue(base: string, legacyBases: string[]): string | null {
  if (!canUseStorage()) return null;
  const target = versionedKey(base);

  for (const legacyBase of legacyBases) {
    const source = legacyKey(legacyBase);
    const value = window.localStorage.getItem(source);
    if (value == null) continue;
    window.localStorage.setItem(target, value);
    window.localStorage.removeItem(source);
    return value;
  }

  return null;
}

export function getVersionedStorageItem(
  base: string,
  legacyBases: string[] = [base],
): string | null {
  if (!canUseStorage()) return null;
  const target = versionedKey(base);
  const current = window.localStorage.getItem(target);
  if (current != null) return current;
  return migrateLegacyValue(base, legacyBases);
}

export function setVersionedStorageItem(base: string, value: string): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(versionedKey(base), value);
}

export function removeVersionedStorageItem(
  base: string,
  legacyBases: string[] = [base],
): void {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(versionedKey(base));
  for (const legacyBase of legacyBases) {
    window.localStorage.removeItem(legacyKey(legacyBase));
  }
}

export function getVersionedJson<T>(
  base: string,
  fallback: T,
  legacyBases: string[] = [base],
): T {
  const raw = getVersionedStorageItem(base, legacyBases);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setVersionedJson(base: string, value: unknown): void {
  try {
    setVersionedStorageItem(base, JSON.stringify(value));
  } catch {
    // Ignore storage errors for non-critical preferences.
  }
}

