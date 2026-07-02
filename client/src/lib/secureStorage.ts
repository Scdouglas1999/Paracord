import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriEnv';

const webMemoryStore = new Map<string, string>();
const ENCRYPTED_FALLBACK_PREFIX = 'pcenc:v1:';
let hasWarnedSecureStorageDegrade = false;
let workerBridgeRequestId = 0;
const workerBridgePending = new Map<
  number,
  { resolve: (value: string | null) => void; reject: (err: unknown) => void }
>();
let workerBridgeListenerInstalled = false;

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function isWorkerContext(): boolean {
  return typeof window === 'undefined' && typeof self !== 'undefined';
}

function installWorkerBridgeListener(): void {
  if (!isWorkerContext() || workerBridgeListenerInstalled) {
    return;
  }
  workerBridgeListenerInstalled = true;
  self.addEventListener('message', (event: MessageEvent) => {
    const payload = event.data as
      | {
          type?: string;
          id?: number;
          ok?: boolean;
          value?: string | null;
          error?: string;
        }
      | undefined;
    if (!payload || payload.type !== 'pc-secure-storage-response' || typeof payload.id !== 'number') {
      return;
    }
    const pending = workerBridgePending.get(payload.id);
    if (!pending) {
      return;
    }
    workerBridgePending.delete(payload.id);
    if (payload.ok) {
      pending.resolve(payload.value ?? null);
    } else {
      pending.reject(new Error(payload.error || 'secure storage bridge failed'));
    }
  });
}

function workerBridgeRequest(
  op: 'get' | 'set' | 'delete',
  key: string,
  value?: string,
): Promise<string | null> {
  installWorkerBridgeListener();
  const id = ++workerBridgeRequestId;
  return new Promise((resolve, reject) => {
    workerBridgePending.set(id, { resolve, reject });
    self.postMessage({
      type: 'pc-secure-storage-request',
      id,
      op,
      key,
      value,
    });
  });
}

function warnSecureStorageDegraded(): void {
  if (hasWarnedSecureStorageDegrade) {
    return;
  }
  hasWarnedSecureStorageDegrade = true;
  console.warn(
    'OS secure storage is unavailable; using encrypted local fallback storage for this profile.'
  );
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('paracord:secure-storage-degraded'));
  }
}

async function writeEncryptedFallback(key: string, value: string): Promise<void> {
  if (!hasLocalStorage()) {
    webMemoryStore.set(key, value);
    return;
  }
  const encrypted = await invoke<string>('secure_store_fallback_encrypt', {
    plaintext: value,
  });
  localStorage.setItem(key, `${ENCRYPTED_FALLBACK_PREFIX}${encrypted}`);
}

async function readFallbackValue(key: string): Promise<string | null> {
  if (!hasLocalStorage()) {
    return webMemoryStore.get(key) ?? null;
  }
  const stored = localStorage.getItem(key);
  if (stored === null) {
    return null;
  }
  if (!stored.startsWith(ENCRYPTED_FALLBACK_PREFIX)) {
    // Migrate any legacy plaintext fallback immediately.
    await writeEncryptedFallback(key, stored).catch(() => {
      webMemoryStore.set(key, stored);
      localStorage.removeItem(key);
    });
    return stored;
  }

  const payload = stored.slice(ENCRYPTED_FALLBACK_PREFIX.length);
  if (!payload) {
    return null;
  }
  return invoke<string>('secure_store_fallback_decrypt', { payload });
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isWorkerContext()) {
    await workerBridgeRequest('set', key, value);
    return;
  }
  if (!isTauri()) {
    webMemoryStore.set(key, value);
    if (hasLocalStorage()) {
      localStorage.removeItem(key);
    }
    return;
  }
  try {
    await invoke('secure_store_set', { key, value });
    if (hasLocalStorage()) {
      localStorage.removeItem(key);
    }
  } catch {
    warnSecureStorageDegraded();
    await writeEncryptedFallback(key, value).catch(() => {
      webMemoryStore.set(key, value);
      if (hasLocalStorage()) {
        localStorage.removeItem(key);
      }
    });
  }
}

export async function secureGet(key: string): Promise<string | null> {
  if (isWorkerContext()) {
    return workerBridgeRequest('get', key);
  }
  if (!isTauri()) {
    return webMemoryStore.get(key) ?? null;
  }
  try {
    const value = await invoke<string | null>('secure_store_get', { key });
    if (value !== null && value !== undefined) {
      return value;
    }
  } catch {
    warnSecureStorageDegraded();
  }
  const fallback = await readFallbackValue(key).catch(() => null);
  if (fallback !== null) {
    return fallback;
  }
  return webMemoryStore.get(key) ?? null;
}

export async function secureDelete(key: string): Promise<void> {
  if (isWorkerContext()) {
    await workerBridgeRequest('delete', key);
    return;
  }
  if (!isTauri()) {
    webMemoryStore.delete(key);
    if (hasLocalStorage()) {
      localStorage.removeItem(key);
    }
    return;
  }
  try {
    await invoke('secure_store_delete', { key });
  } catch {
    // Best-effort delete.
  }
  if (hasLocalStorage()) {
    localStorage.removeItem(key);
  }
}
