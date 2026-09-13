import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import type { OwnPublicKeysResponse, UploadKeysRequest, UploadKeysResponse } from '../../api/keys';
import { accountScopeKey } from '../serverScope';
import { readStoredValueForMigration } from '../secureStorage';
import type { openAccountVault } from './accountVaultSession';
import type { AccountVault, VaultLifetime } from './accountVault';
import { bytesToHex, fromBase64, toBase64 } from './util';
import { deserializePrekeyStore, serializePrekeyStore, generateAdditionalOPKs, generatePrekeyBundle, ensureLocalLastResortPrekey } from './sessionManager';
import { readSignalPrekeys, writeSignalPrekeys } from './signalVault';
import { OPK_BATCH_SIZE, OPK_LOW_THRESHOLD, SIGNED_PREKEY_ROTATION_MS, type LocalPrekeyStore } from './types';

const PUBLICATION_NAMESPACE = 'signal.publications';
const PENDING_ID = 'pending';
interface PendingPublication { requestId: string; serializedRequest: string }
export type PrekeyEnrollmentErrorCode = 'IDENTITY_CHANGED' | 'INVALID_KEYS' | 'RECOVERY_REQUIRED' | 'DEVICE_NOT_ENROLLED' | 'UNOWNED_LEGACY_KEYS' | 'PUBLICATION_NOT_ACKNOWLEDGED';
export class PrekeyEnrollmentError extends Error {
  constructor(readonly code: PrekeyEnrollmentErrorCode, message: string) { super(message); this.name = 'PrekeyEnrollmentError'; }
}
const invalid = (message: string): never => { throw new PrekeyEnrollmentError('INVALID_KEYS', message); };
function keyId(id: number) { if (!Number.isSafeInteger(id) || id < 0) invalid('Invalid prekey ID.'); }
function publicBytes(value: string, size = 32) {
  try {
    const bytes = fromBase64(value);
    if (bytes.length !== size || toBase64(bytes) !== value) invalid('Published key material has an invalid encoding.');
    return bytes;
  } catch { return invalid('Published key material has an invalid encoding.'); }
}
function pair(key: { id: number; publicKey: Uint8Array; privateKey: Uint8Array }) {
  keyId(key.id);
  if (key.publicKey?.length !== 32 || key.privateKey?.length !== 32
    || toBase64(x25519.getPublicKey(key.privateKey)) !== toBase64(key.publicKey)) invalid('A private prekey does not match its public key. Restore a valid encrypted backup.');
}
export function assertLocalPrekeys(store: LocalPrekeyStore) {
  pair(store.signedPrekey);
  const signedIds = new Set([store.signedPrekey.id]);
  for (const key of store.signedPrekeyArchive ?? []) {
    pair(key);
    if (signedIds.has(key.id)) invalid('Duplicate archived signed-prekey ID.');
    signedIds.add(key.id);
  }
  for (const key of [store.signedPrekey, ...(store.signedPrekeyArchive ?? [])]) {
    if (!Number.isSafeInteger(key.createdAt) || key.createdAt < 0) invalid('Invalid signed-prekey creation time.');
  }
  const ids = new Set<number>();
  for (const key of [...store.oneTimePrekeys, ...(store.lastResortPrekey ? [store.lastResortPrekey] : [])]) {
    pair(key);
    if (ids.has(key.id)) invalid('Duplicate one-time prekey ID.');
    ids.add(key.id);
  }
  keyId(store.nextOPKId);
  if ([...ids].some(id => id >= store.nextOPKId)) invalid('The prekey sequence would reuse an existing key ID.');
}
export function assertPublishedPrekeys(published: OwnPublicKeysResponse, identity: Uint8Array) {
  if (typeof published.identity_key !== 'string' || !/^[0-9a-f]{64}$/i.test(published.identity_key)
    || published.identity_key.toLowerCase() !== bytesToHex(ed25519.getPublicKey(identity))) {
    throw new PrekeyEnrollmentError('IDENTITY_CHANGED', 'The server account has a different enrolled identity. Unlock its current identity.');
  }
  if (published.signed_prekey !== null && (typeof published.signed_prekey !== 'object' || !published.signed_prekey)) invalid('The server returned an invalid signed prekey.');
  if (published.last_resort_prekey !== null && (typeof published.last_resort_prekey !== 'object' || !published.last_resort_prekey)) invalid('The server returned an invalid last-resort prekey.');
  if (published.signed_prekey) {
    keyId(published.signed_prekey.id);
    if (!ed25519.verify(publicBytes(published.signed_prekey.signature, 64), publicBytes(published.signed_prekey.public_key), ed25519.getPublicKey(identity))) {
      invalid('The published signed prekey is not signed by this account’s identity.');
    }
  }
  if (!Array.isArray(published.one_time_prekeys)) invalid('The server returned an invalid prekey inventory.');
  const ids = new Set<number>();
  for (const key of [...published.one_time_prekeys, ...(published.last_resort_prekey ? [published.last_resort_prekey] : [])]) {
    keyId(key.id); publicBytes(key.public_key);
    if (ids.has(key.id)) invalid('The server returned duplicate one-time prekeys.');
    ids.add(key.id);
  }
}
/** The server signature and every still-published key must match local private material. */
export function assertPrekeyOwnership(store: LocalPrekeyStore, published: OwnPublicKeysResponse, identity: Uint8Array) {
  assertLocalPrekeys(store); assertPublishedPrekeys(published, identity);
  if (!published.signed_prekey || published.signed_prekey.id !== store.signedPrekey.id
    || published.signed_prekey.public_key !== toBase64(store.signedPrekey.publicKey)) {
    throw new PrekeyEnrollmentError('RECOVERY_REQUIRED', 'The private keys for the account’s published bundle are missing. Restore its encrypted key backup before replacing any keys.');
  }
  const local = new Map(store.oneTimePrekeys.map(key => [key.id, key]));
  for (const key of published.one_time_prekeys) {
    const privateKey = local.get(key.id);
    if (!privateKey || toBase64(privateKey.publicKey) !== key.public_key) throw new PrekeyEnrollmentError('RECOVERY_REQUIRED', 'A published one-time key is missing from this device. Restore the account’s encrypted key backup.');
  }
  if (published.last_resort_prekey && (!store.lastResortPrekey
    || published.last_resort_prekey.id !== store.lastResortPrekey.id
    || published.last_resort_prekey.public_key !== toBase64(store.lastResortPrekey.publicKey))) {
    throw new PrekeyEnrollmentError('RECOVERY_REQUIRED', 'The private last-resort key is missing from this device. Restore the account’s encrypted key backup.');
  }
}

/** Nondestructive read: ownership is proved separately before any vault write. */
export async function readLegacyPrekeysForMigration(): Promise<LocalPrekeyStore | null> {
  const current = await readStoredValueForMigration('paracord:signal:prekeys');
  const raw = current ?? await readStoredValueForMigration('signal:prekeys');
  if (raw === null) return null;
  try {
    const store = deserializePrekeyStore(JSON.parse(raw));
    assertLocalPrekeys(store);
    return store;
  } catch { throw new PrekeyEnrollmentError('RECOVERY_REQUIRED', 'Legacy private keys could not be read. The original stored data has been preserved for recovery.'); }
}

interface EnrollmentOptions {
  vault: AccountVault;
  privateKey: Uint8Array;
  lifetime: VaultLifetime;
  getOwnKeys(): Promise<OwnPublicKeysResponse>;
  publish(serializedRequest: string): Promise<UploadKeysResponse>;
  readLegacy(): Promise<LocalPrekeyStore | null>;
  now?: () => number;
}

/** Private keys and their immutable pending upload commit together before HTTP. */
export class PrekeyEnrollment {
  private readonly now: () => number;
  constructor(private readonly options: EnrollmentOptions) { this.now = options.now ?? Date.now; }
  private assertCurrent() { this.options.lifetime.signal.throwIfAborted(); this.options.lifetime.assertCurrent(); }

  private async flushPending() {
    const pending = await this.options.vault.transact(tx => tx.get<PendingPublication>(PUBLICATION_NAMESPACE, PENDING_ID));
    if (!pending) return;
    this.assertCurrent();
    const response = await this.options.publish(pending.serializedRequest);
    this.assertCurrent();
    const request = JSON.parse(pending.serializedRequest) as UploadKeysRequest;
    if (response.request_id !== pending.requestId
      || response.signed_prekey_id !== (request.signed_prekey?.id ?? null)
      || response.last_resort_prekey_id !== (request.last_resort_prekey?.id ?? null)
      || !Number.isSafeInteger(response.one_time_prekeys_stored) || response.one_time_prekeys_stored < 0
      || !Number.isSafeInteger(response.one_time_prekeys_total) || response.one_time_prekeys_total < 0) {
      throw new PrekeyEnrollmentError('PUBLICATION_NOT_ACKNOWLEDGED', 'The server did not acknowledge this key publication. Its original request and private keys remain saved.');
    }
    await this.options.vault.transact(async tx => {
      const current = await tx.get<PendingPublication>(PUBLICATION_NAMESPACE, PENDING_ID);
      if (current?.serializedRequest !== pending.serializedRequest) throw new Error('The pending key publication changed.');
      tx.remove(PUBLICATION_NAMESPACE, PENDING_ID);
    });
  }

  /**
   * `replacePublishedBundle` is re-enrolment for a device that proved the
   * account's identity (a recovery-phrase restore) but holds none of the
   * private halves of the bundle the account published from another device.
   *
   * The identity key is the root of trust and prekeys are per device: a peer
   * only accepts a signed prekey that verifies under the identity key it has
   * pinned, so a device holding that key can already mint any bundle it likes.
   * Publishing a fresh one therefore adds no authority -- it only stops the
   * server handing peers key material this account can no longer open. It is
   * still destructive (another device signed in to the same account stops
   * receiving new conversations, and prior history stays unreadable here
   * without an imported backup), so it is never automatic: the caller passes
   * this only for an explicit user decision.
   */
  async ensure({ initializeWithUnownedLegacy = false, replacePublishedBundle = false } = {}): Promise<void> {
    await navigator.locks.request(`paracord:enrollment:${accountScopeKey(this.options.vault.scope)}`, {
      mode: 'exclusive', signal: this.options.lifetime.signal,
    }, async () => {
      this.assertCurrent();
      await this.flushPending();
      let prepared = false;
      while (!prepared) {
        this.assertCurrent();
        const fingerprint = (store: LocalPrekeyStore | null) => store ? JSON.stringify(serializePrekeyStore(store)) : null;
        const before = await this.options.vault.transact(async tx => fingerprint(await readSignalPrekeys(tx)));
        const published = await this.options.getOwnKeys();
        this.assertCurrent();
        assertPublishedPrekeys(published, this.options.privateKey);
        prepared = await this.options.vault.transact(async tx => {
          this.assertCurrent();
          let store = await readSignalPrekeys(tx);
          // Decryption can consume a local prekey while inventory HTTP is in
          // flight. Retry that observation instead of reporting a missing key.
          // The network wait never holds the account's vault lock.
          if (fingerprint(store) !== before) return false;
          let fresh = false;
          let replacing = false;
          if (!store) {
            const legacy = await this.options.readLegacy();
            this.assertCurrent();
            if (published.signed_prekey) {
              if (!legacy) {
                if (!replacePublishedBundle) {
                  throw new PrekeyEnrollmentError('DEVICE_NOT_ENROLLED', 'This account published encryption keys from another device, and this device holds none of them.');
                }
                store = generatePrekeyBundle(this.options.privateKey);
                fresh = true;
                replacing = true;
              } else {
                assertPrekeyOwnership(legacy, published, this.options.privateKey);
                store = legacy;
              }
            } else {
              if (published.one_time_prekeys.length || published.last_resort_prekey) invalid('The published prekey inventory has no signed prekey.');
              if (legacy && !initializeWithUnownedLegacy) throw new PrekeyEnrollmentError('UNOWNED_LEGACY_KEYS', 'Stored legacy keys have no verifiable owner on this server. Recover them or explicitly initialize new keys for this account.');
              store = generatePrekeyBundle(this.options.privateKey);
              fresh = true;
            }
          }
          if (!fresh) assertPrekeyOwnership(store, published, this.options.privateKey);
          store = ensureLocalLastResortPrekey(store);
          const body: UploadKeysRequest = {};
          const now = this.now();
          if (!fresh && now - store.signedPrekey.createdAt > SIGNED_PREKEY_ROTATION_MS) {
            const privateKey = x25519.utils.randomSecretKey();
            const id = Math.max(now, store.nextOPKId, store.signedPrekey.id + 1);
            keyId(id); keyId(id + 1);
            store = { ...store, signedPrekeyArchive: [...(store.signedPrekeyArchive ?? []), store.signedPrekey],
              signedPrekey: { id, privateKey, publicKey: x25519.getPublicKey(privateKey), createdAt: now }, nextOPKId: id + 1 };
          }
          if (fresh || store.signedPrekey.id !== published.signed_prekey?.id) {
            body.signed_prekey = { id: store.signedPrekey.id, public_key: toBase64(store.signedPrekey.publicKey), signature: toBase64(ed25519.sign(store.signedPrekey.publicKey, this.options.privateKey)) };
          }
          if (fresh) body.one_time_prekeys = store.oneTimePrekeys.map(key => ({ id: key.id, public_key: toBase64(key.publicKey) }));
          else if (published.one_time_prekeys.length < OPK_LOW_THRESHOLD) {
            const generated = generateAdditionalOPKs(store, OPK_BATCH_SIZE - published.one_time_prekeys.length);
            store = generated.store;
            body.one_time_prekeys = generated.newPublicKeys.map(key => ({ id: key.id, public_key: toBase64(key.publicKey) }));
          }
          if ((replacing || !published.last_resort_prekey) && store.lastResortPrekey) {
            body.last_resort_prekey = { id: store.lastResortPrekey.id, public_key: toBase64(store.lastResortPrekey.publicKey) };
          }
          // The server discards the account's whole published inventory for this
          // request, so the replacement must be complete in one publication:
          // a partial top-up would leave the account with no last-resort key.
          if (replacing) body.replace_existing = true;
          assertLocalPrekeys(store);
          writeSignalPrekeys(tx, store);
          if (body.signed_prekey || body.one_time_prekeys || body.last_resort_prekey) {
            body.request_id = crypto.randomUUID();
            body.expected_identity_key = bytesToHex(ed25519.getPublicKey(this.options.privateKey));
            tx.put(PUBLICATION_NAMESPACE, PENDING_ID, { requestId: body.request_id, serializedRequest: JSON.stringify(body) } satisfies PendingPublication);
          }
          return true;
        });
      }
      await this.flushPending();
      this.assertCurrent();
    });
  }
}

/** Production transport binding: capture the account once and require committed responses. */
export function createAccountPrekeyEnrollment(session: Awaited<ReturnType<typeof openAccountVault>>) {
  return new PrekeyEnrollment({
    vault: session.vault, privateKey: session.privateKey, lifetime: session,
    readLegacy: readLegacyPrekeysForMigration,
    async getOwnKeys() {
      const response = await session.context.request<OwnPublicKeysResponse>({ method: 'GET', url: '/users/@me/keys', timeout: 30_000 });
      if (response.status !== 200) throw new Error('The server did not return the account’s published key state.');
      return response.data;
    },
    async publish(serializedRequest) {
      const response = await session.context.request<UploadKeysResponse>({ method: 'PUT', url: '/users/@me/keys', data: serializedRequest, headers: { 'Content-Type': 'application/json' }, timeout: 30_000 });
      if (response.status !== 200) throw new PrekeyEnrollmentError('PUBLICATION_NOT_ACKNOWLEDGED', 'The server did not confirm that the key publication committed.');
      return response.data;
    },
  });
}
