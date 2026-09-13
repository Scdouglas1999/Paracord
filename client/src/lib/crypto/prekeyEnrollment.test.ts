import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assertLocalPrekeys, assertPrekeyOwnership, assertPublishedPrekeys } from './prekeyEnrollment';
import { generatePrekeyBundle, serializePrekeyStore, deserializePrekeyStore, getSignedPrekeyPair, MissingPrivatePrekeyError } from './sessionManager';
import { bytesToHex, toBase64 } from './util';
import type { OwnPublicKeysResponse } from '../../api/keys';

function fixture() {
  const identity = new Uint8Array(32).fill(41);
  const store = generatePrekeyBundle(identity);
  const published: OwnPublicKeysResponse = {
    identity_key: bytesToHex(ed25519.getPublicKey(identity)),
    signed_prekey: { id: store.signedPrekey.id, public_key: toBase64(store.signedPrekey.publicKey), signature: toBase64(ed25519.sign(store.signedPrekey.publicKey, identity)) },
    one_time_prekeys: store.oneTimePrekeys.map(key => ({ id: key.id, public_key: toBase64(key.publicKey) })),
    last_resort_prekey: { id: store.lastResortPrekey!.id, public_key: toBase64(store.lastResortPrekey!.publicKey) },
  };
  return { identity, store, published };
}
describe('verified prekey ownership', () => {
  it('proves the published signature and each private counterpart', () => {
    const { identity, store, published } = fixture();
    expect(() => assertPrekeyOwnership(store, published, identity)).not.toThrow();
    published.identity_key = published.identity_key!.toUpperCase();
    expect(() => assertPrekeyOwnership(store, published, identity)).not.toThrow();
  });
  it('rejects another enrolled identity even when the prekeys match', () => {
    const { store, published } = fixture();
    expect(() => assertPrekeyOwnership(store, published, new Uint8Array(32).fill(42))).toThrow(/different enrolled identity/);
  });
  it('rejects a published signed key without the account signature', () => {
    const { identity, store, published } = fixture();
    published.signed_prekey!.signature = toBase64(ed25519.sign(store.signedPrekey.publicKey, new Uint8Array(32).fill(42)));
    expect(() => assertPrekeyOwnership(store, published, identity)).toThrow(/not signed by/);
  });
  it('rejects missing or substituted private material without inventing replacement keys', () => {
    const { identity, store, published } = fixture();
    const missing = structuredClone(store); missing.oneTimePrekeys.shift();
    expect(() => assertPrekeyOwnership(missing, published, identity)).toThrow(/one-time key is missing/);
    const substituted = structuredClone(store); substituted.signedPrekey.privateKey.fill(99);
    expect(() => assertPrekeyOwnership(substituted, published, identity)).toThrow(/does not match/);
  });
  it('rejects duplicate IDs, key reuse and malformed server inventory', () => {
    const { identity, store, published } = fixture();
    const duplicated = structuredClone(store); duplicated.oneTimePrekeys.push(duplicated.oneTimePrekeys[0]);
    expect(() => assertLocalPrekeys(duplicated)).toThrow(/Duplicate/);
    store.nextOPKId = store.oneTimePrekeys[0].id;
    expect(() => assertLocalPrekeys(store)).toThrow(/reuse/);
    expect(() => assertPublishedPrekeys({ ...published, signed_prekey: undefined } as never, identity)).toThrow(/invalid signed prekey/);
  });
  it('retains archived signed keys through serialization and selects only the requested key', () => {
    const { identity, store } = fixture();
    const old = store.signedPrekey;
    const current = generatePrekeyBundle(identity).signedPrekey; current.id = old.id + 500;
    store.signedPrekey = current; store.signedPrekeyArchive = [old];
    const loaded = deserializePrekeyStore(serializePrekeyStore(store));
    expect(getSignedPrekeyPair(loaded, old.id)).toEqual({ publicKey: old.publicKey, privateKey: old.privateKey });
    expect(getSignedPrekeyPair(loaded, current.id).publicKey).toEqual(current.publicKey);
    // A key this device never held is its own kind of failure: it is the state
    // of history after a recovery-phrase restore, not a sign of tampering.
    expect(() => getSignedPrekeyPair(loaded, current.id + 1)).toThrow(MissingPrivatePrekeyError);
    expect(() => getSignedPrekeyPair(loaded, NaN)).toThrow(/Invalid/);
  });
});
