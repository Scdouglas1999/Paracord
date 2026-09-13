import type { AccountKeystore } from '../account';
import { readStoredValueForMigration, secureDelete } from '../secureStorage';
import { fromBase64, toBase64 } from './util';

export const IDENTITY_KEYSTORE_STORAGE_KEY = 'paracord:encrypted-identity:v1';
const LEGACY_KEY = 'paracord:account';
const LEGACY_MARKER = 'paracord:account:exists';

function validate(keystore: AccountKeystore): void {
  const bytes = (value: string, length: number) => {
    if (typeof value !== 'string') throw new Error('Invalid encrypted identity keystore.');
    const decoded = fromBase64(value);
    if (decoded.length !== length || toBase64(decoded) !== value) throw new Error('Invalid encrypted identity keystore.');
  };
  if (!keystore || keystore.version !== 1 || typeof keystore.publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(keystore.publicKey)
    || typeof keystore.username !== 'string' || (keystore.displayName !== undefined && typeof keystore.displayName !== 'string')) {
    throw new Error('Invalid encrypted identity keystore.');
  }
  const fields = new Set(['version', 'publicKey', 'encryptedPrivateKey', 'salt', 'iv', 'username', 'displayName']);
  if (Object.keys(keystore).some(field => !fields.has(field))) throw new Error('The encrypted identity contains unsupported fields.');
  bytes(keystore.encryptedPrivateKey, 48); bytes(keystore.salt, 32); bytes(keystore.iv, 12);
}

async function locked<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Encrypted identity storage requires Web Locks in a secure context.');
  return await navigator.locks.request('paracord:encrypted-identity', { mode: 'exclusive' }, operation);
}

async function read(): Promise<AccountKeystore | null> {
  const current = localStorage.getItem(IDENTITY_KEYSTORE_STORAGE_KEY);
  const raw = current ?? await readStoredValueForMigration(LEGACY_KEY);
  if (raw === null) {
    if (localStorage.getItem(LEGACY_MARKER)) {
      throw new Error('This device records an identity but its private keystore is missing. Restore the encrypted backup or recovery phrase.');
    }
    return null;
  }
  const keystore = JSON.parse(raw) as AccountKeystore;
  validate(keystore);
  // The private key is already password-encrypted. Persist that envelope
  // directly; the generic web secure store deliberately retains only memory.
  // Historical sources remain intact, and write failures reject the migration.
  if (current === null) localStorage.setItem(IDENTITY_KEYSTORE_STORAGE_KEY, JSON.stringify(keystore));
  return keystore;
}

export const readIdentityKeystore = () => locked(read);
export function writeIdentityKeystore(keystore: AccountKeystore, replace: boolean) {
  validate(keystore);
  return locked(async () => {
    if (!replace && await read()) throw new Error('This device already has an identity. Unlock it instead of creating a replacement.');
    localStorage.setItem(IDENTITY_KEYSTORE_STORAGE_KEY, JSON.stringify(keystore));
  });
}
export function updateIdentityKeystore(update: (keystore: AccountKeystore) => AccountKeystore) {
  return locked(async () => {
    const current = await read();
    if (!current) throw new Error('No account found in storage');
    const next = update(current); validate(next);
    localStorage.setItem(IDENTITY_KEYSTORE_STORAGE_KEY, JSON.stringify(next));
  });
}
export function deleteIdentityKeystore() {
  return locked(async () => {
    await secureDelete(LEGACY_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(IDENTITY_KEYSTORE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_MARKER);
  });
}
