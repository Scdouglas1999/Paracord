import { accountScopeKey, type AccountScope } from '../serverScope';
import { toArrayBuffer } from './util';

const DATABASE = 'paracord-encrypted-accounts';
const STORE = 'records';
const VERSION = 1;
const MANIFEST_NAMESPACE = '__vault__';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type Address = [string, string, string, string];
interface EncryptedRecord {
  address: Address;
  revision: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

/** An unlocked account/session owns every operation, including queued work. */
export interface VaultLifetime {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface VaultTransaction {
  get<T>(namespace: string, id: string): Promise<T | null>;
  list<T>(namespace: string): Promise<Array<{ id: string; value: T }>>;
  put(namespace: string, id: string, value: unknown): void;
  remove(namespace: string, id: string): void;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('Encrypted storage request failed.'));
  });
}

function openDatabase(name = DATABASE): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const operation = indexedDB.open(name, VERSION);
    operation.onupgradeneeded = () => {
      operation.result.createObjectStore(STORE, { keyPath: 'address' });
    };
    operation.onerror = () => reject(operation.error ?? new Error('Encrypted storage could not be opened.'));
    operation.onblocked = () => { blocked = true; reject(new Error('Close other Paracord windows to upgrade encrypted storage.')); };
    operation.onsuccess = () => { if (blocked) operation.result.close(); else resolve(operation.result); };
  });
}

/**
 * Durable encrypted account records. No private key or plaintext is persisted.
 * A transaction holds a cross-tab/worker account lock through its read, crypto
 * and atomic commit. Ratchets and their exact outbound request can therefore be
 * saved together, before transmission. Storage failures reject; no memory-only
 * success, plaintext storage, eviction or implicit migration is permitted.
 */
export class AccountVault {
  private closed = false;
  private readonly controller = new AbortController();
  private constructor(
    readonly scope: AccountScope,
    private readonly database: IDBDatabase,
    private readonly key: CryptoKey,
    private readonly lifetime: VaultLifetime,
  ) {
    lifetime.signal.addEventListener('abort', this.close, { once: true });
    database.onversionchange = this.close;
  }

  static async open(scope: AccountScope, privateKey: Uint8Array, lifetime: VaultLifetime): Promise<AccountVault> {
    lifetime.assertCurrent();
    lifetime.signal.throwIfAborted();
    if (!globalThis.indexedDB || !globalThis.navigator?.locks || !globalThis.crypto?.subtle) {
      throw new Error('Durable encrypted storage requires IndexedDB, Web Locks and Web Crypto in a secure context.');
    }
    if (!scope.serverId || !scope.userId) throw new Error('Encrypted storage requires an explicit server and account.');
    if (privateKey.byteLength !== 32) throw new Error('Encrypted storage requires a 32-byte account identity key.');
    const owner = Object.freeze({ ...scope });
    const keyCopy = privateKey.slice();
    let database: IDBDatabase | undefined;
    let vault: AccountVault | undefined;
    try {
      const source = await crypto.subtle.importKey('raw', toArrayBuffer(keyCopy), 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256',
        salt: encoder.encode('paracord:account-vault:v1'),
        info: encoder.encode(accountScopeKey(owner)),
      }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      lifetime.assertCurrent(); lifetime.signal.throwIfAborted();
      database = await openDatabase();
      lifetime.assertCurrent(); lifetime.signal.throwIfAborted();
      vault = new AccountVault(owner, database, key, lifetime);
      await vault.authenticate();
      return vault;
    } catch (error) {
      vault?.close();
      database?.close();
      throw error;
    } finally { keyCopy.fill(0); }
  }

  /** Device-owned local data is independent of server Signal enrollment. */
  static async openDevice(scope: AccountScope, key: CryptoKey, lifetime: VaultLifetime): Promise<AccountVault> {
    lifetime.assertCurrent(); lifetime.signal.throwIfAborted();
    if (!scope.serverId || !scope.userId || key.type !== 'secret' || key.extractable
      || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256
      || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw new Error('Encrypted local storage requires an account-owned nonextractable key.');
    const database = await openDatabase('paracord-device-encrypted-accounts');
    const vault = new AccountVault(Object.freeze({ ...scope }), database, key, lifetime);
    try { await vault.authenticate(); lifetime.assertCurrent(); return vault; }
    catch (error) { vault.close(); throw error; }
  }

  static async hasDeviceRecords(scope: AccountScope): Promise<boolean> {
    const database = await openDatabase('paracord-device-encrypted-accounts');
    try {
      const prefix = [scope.serverId, scope.userId];
      return (await request<number>(database.transaction(STORE).objectStore(STORE).count(IDBKeyRange.bound(prefix, [...prefix, []], false, true)))) > 0;
    } finally { database.close(); }
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.database.close();
    this.lifetime.signal.removeEventListener('abort', this.close);
  };

  private assertCurrent(): void {
    // A vault closed *by* its lifetime reports why the lifetime ended. The
    // cancellation arrives as an abort listener that closes this vault, so
    // reporting "closed" first turned every account-history change into an
    // indistinguishable storage failure.
    this.lifetime.signal.throwIfAborted();
    if (this.closed) throw new Error('Encrypted account storage is closed. Unlock the account to continue.');
    this.lifetime.assertCurrent();
  }

  private address(namespace: string, id: string): Address {
    if (namespace === MANIFEST_NAMESPACE) throw new Error('The encrypted storage manifest is reserved.');
    if (!namespace || !id) throw new Error('Encrypted storage namespace and record ID are required.');
    return [this.scope.serverId, this.scope.userId, namespace, id];
  }

  private async decrypt<T>(record: EncryptedRecord, address: Address): Promise<T> {
    this.assertCurrent();
    const bytes = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: record.iv,
      additionalData: encoder.encode(JSON.stringify([VERSION, address, record.revision])),
    }, this.key, record.ciphertext));
    try {
      this.assertCurrent();
      return JSON.parse(decoder.decode(bytes)) as T;
    } finally { bytes.fill(0); }
  }

  private async encrypt(address: Address, json: string): Promise<EncryptedRecord> {
    this.assertCurrent();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const revision = crypto.randomUUID();
    const plaintext = encoder.encode(json);
    try {
      const ciphertext = await crypto.subtle.encrypt({
        name: 'AES-GCM', iv,
        additionalData: encoder.encode(JSON.stringify([VERSION, address, revision])),
      }, this.key, plaintext);
      this.assertCurrent();
      return { address, revision, iv: toArrayBuffer(iv), ciphertext };
    } finally { plaintext.fill(0); }
  }

  private async authenticate(): Promise<void> {
    await navigator.locks.request(`paracord:vault:${accountScopeKey(this.scope)}`, {
      mode: 'exclusive', signal: this.controller.signal,
    }, async () => {
      this.assertCurrent();
      const address: Address = [this.scope.serverId, this.scope.userId, MANIFEST_NAMESPACE, 'identity'];
      const record = await request<EncryptedRecord | undefined>(this.database.transaction(STORE).objectStore(STORE).get(address));
      if (record) {
        const manifest = await this.decrypt<{ version: number }>(record, address);
        if (manifest.version !== VERSION) throw new Error('Unsupported encrypted account storage version.');
      } else {
        const prefix = [this.scope.serverId, this.scope.userId];
        const range = IDBKeyRange.bound(prefix, [...prefix, []], false, true);
        const count = await request<number>(this.database.transaction(STORE).objectStore(STORE).count(range));
        if (count) throw new Error('Encrypted account storage is missing its identity manifest. Restore the complete encrypted store.');
        const manifest = await this.encrypt(address, JSON.stringify({ version: VERSION }));
        await this.commit([{ address, record: manifest }]);
      }
      this.assertCurrent();
    });
  }

  async transact<T>(run: (transaction: VaultTransaction) => Promise<T>): Promise<T> {
    this.assertCurrent();
    return navigator.locks.request(`paracord:vault:${accountScopeKey(this.scope)}`, {
      mode: 'exclusive', signal: this.controller.signal,
    }, async () => {
      this.assertCurrent();
      let accepting = true;
      const staged = new Map<string, { address: Address; json: string | null }>();
      const assertTransaction = () => {
        this.assertCurrent();
        if (!accepting) throw new Error('Encrypted storage transaction has already finished.');
      };
      const transaction: VaultTransaction = {
        get: async <V>(namespace: string, id: string): Promise<V | null> => {
          assertTransaction();
          const address = this.address(namespace, id);
          const pending = staged.get(JSON.stringify(address));
          if (pending) return pending.json === null ? null : JSON.parse(pending.json) as V;
          const record = await request<EncryptedRecord | undefined>(this.database.transaction(STORE).objectStore(STORE).get(address));
          assertTransaction();
          return record ? this.decrypt<V>(record, address) : null;
        },
        list: async <V>(namespace: string): Promise<Array<{ id: string; value: V }>> => {
          assertTransaction();
          this.address(namespace, 'validate');
          const prefix = [this.scope.serverId, this.scope.userId, namespace];
          const range = IDBKeyRange.bound(prefix, [...prefix, []], false, true);
          const records = await request<EncryptedRecord[]>(this.database.transaction(STORE).objectStore(STORE).getAll(range));
          const values = new Map<string, V>();
          for (const record of records) values.set(record.address[3], await this.decrypt<V>(record, record.address));
          for (const pending of staged.values()) if (pending.address[2] === namespace) {
            if (pending.json === null) values.delete(pending.address[3]);
            else values.set(pending.address[3], JSON.parse(pending.json) as V);
          }
          assertTransaction();
          return [...values].map(([id, value]) => ({ id, value }));
        },
        put: (namespace, id, value) => {
          assertTransaction();
          const address = this.address(namespace, id);
          const json = JSON.stringify(value);
          if (json === undefined) throw new Error('Encrypted storage values must serialize as JSON.');
          staged.set(JSON.stringify(address), { address, json });
        },
        remove: (namespace, id) => {
          assertTransaction();
          const address = this.address(namespace, id);
          staged.set(JSON.stringify(address), { address, json: null });
        },
      };
      try {
        const value = await run(transaction);
        assertTransaction();
        accepting = false;
        const writes: Array<{ address: Address; record: EncryptedRecord | null }> = [];
        for (const pending of staged.values()) {
          if (pending.json === null) { writes.push({ address: pending.address, record: null }); continue; }
          const record = await this.encrypt(pending.address, pending.json);
          writes.push({ address: pending.address, record });
        }
        this.assertCurrent();
        if (writes.length) await this.commit(writes);
        this.assertCurrent();
        return value;
      } finally { accepting = false; staged.clear(); }
    });
  }

  private commit(writes: Array<{ address: Address; record: EncryptedRecord | null }>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.assertCurrent();
      const tx = this.database.transaction(STORE, 'readwrite', { durability: 'strict' });
      const cancel = () => { try { tx.abort(); } catch { /* Already committed or aborted. */ } };
      this.controller.signal.addEventListener('abort', cancel, { once: true });
      const cleanup = () => this.controller.signal.removeEventListener('abort', cancel);
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = () => { cleanup(); reject(tx.error ?? new Error('Encrypted storage commit was canceled.')); };
      tx.onerror = () => { /* The default error handler aborts the entire transaction. */ };
      try {
        for (const write of writes) {
          if (write.record) tx.objectStore(STORE).put(write.record);
          else tx.objectStore(STORE).delete(write.address);
        }
      } catch (error) { cancel(); cleanup(); reject(error); }
    });
  }
}
