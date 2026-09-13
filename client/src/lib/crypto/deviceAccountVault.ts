import { captureScopedOperation } from '../operationContext';
import { accountScopeKey, type AccountScope } from '../serverScope';
import { AccountVault } from './accountVault';

const DATABASE = 'paracord-account-device-keys';
const STORE = 'keys';
function request<T>(value: IDBRequest<T>) { return new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('Encrypted device storage failed.'));
}); }
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onblocked = () => { blocked = true; reject(new Error('Close other Paracord windows to upgrade encrypted device keys.')); };
    opening.onerror = () => reject(opening.error ?? new Error('Encrypted device keys could not be opened.'));
    opening.onsuccess = () => { if (blocked) opening.result.close(); else resolve(opening.result); };
  });
}

/**
 * A nonextractable, device-bound key keeps drafts encrypted before identity setup.
 * It is not a portable recovery backup or protection from running same-origin
 * code. Never recreate a missing key over existing ciphertext.
 */
export async function openDeviceAccountVault(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  let vault: AccountVault | undefined;
  try {
    if (!globalThis.indexedDB || !navigator.locks || !crypto.subtle) throw new Error('Encrypted drafts require IndexedDB, Web Locks and Web Crypto.');
    vault = await navigator.locks.request(`paracord:device-key:${accountScopeKey(scope)}`, { mode: 'exclusive', signal: context.signal }, async () => {
      const db = await database();
      try {
        context.assertCurrent();
        let key = await request<CryptoKey | undefined>(db.transaction(STORE).objectStore(STORE).get(accountScopeKey(scope)));
        if (!key) {
          if (await AccountVault.hasDeviceRecords(scope)) throw new Error('This device’s encryption key is missing. Restore the complete device profile to recover its saved drafts.');
          key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          context.assertCurrent();
          const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
          const cancelled = () => { try { tx.abort(); } catch { /* Already committed. */ } };
          context.signal.addEventListener('abort', cancelled, { once: true });
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => context.signal.removeEventListener('abort', cancelled);
            tx.oncomplete = () => { cleanup(); resolve(); };
            // A cancelled write reports the cancellation, not a storage fault:
            // callers tell an account's own history change from a broken device
            // apart by the error they are handed.
            tx.onabort = () => { cleanup(); reject(context.signal.aborted ? context.signal.reason : (tx.error ?? new Error('Device key storage was cancelled.'))); };
            tx.onerror = () => {};
            try { tx.objectStore(STORE).put(key, accountScopeKey(scope)); }
            catch (error) { cancelled(); cleanup(); reject(error); }
          });
        }
        context.assertCurrent();
        return AccountVault.openDevice(scope, key, context);
      } finally { db.close(); }
    });
    const dispose = () => { vault?.close(); context.dispose(); };
    context.signal.addEventListener('abort', () => vault?.close(), { once: true });
    context.assertCurrent();
    return { vault, context, signal: context.signal, assertCurrent: context.assertCurrent, dispose };
  } catch (error) { vault?.close(); context.dispose(); throw error; }
}
