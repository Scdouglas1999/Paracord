/**
 * Regression tests for the DM E2EE trust boundary.
 *
 * These cover the two properties the ratchet path must never lose:
 *  1. A message's claimed identity key (`header.ik`) is a claim, not a fact —
 *     it may never establish or replace a session on its own.
 *  2. A failed decrypt is not a session-reset oracle: an established session
 *     survives garbage, so nobody can force a re-keying by posting junk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { PrekeyBundleResponse } from '../api/keys';
import { bytesToHex, toBase64 } from './crypto/util';
import { generatePrekeyBundle, savePrekeyStore } from './crypto/sessionManager';
import { DmE2eeError, decryptDmMessage, encryptDmMessageV2 } from './dmE2ee';
import { formatIdentityFingerprint, IdentityPinError, markIdentityVerified } from './keyVerification';

const mocks = vi.hoisted(() => {
  const profiles = new Map<string, Map<string, string>>();
  return {
    profiles,
    activeStore: new Map<string, string>(),
    bundles: new Map<string, PrekeyBundleResponse>(),
    getBundle: vi.fn(async (userId: string) => {
      const bundle = mocks.bundles.get(userId);
      if (!bundle) throw new Error(`no bundle for ${userId}`);
      return { data: bundle };
    }),
  };
});

// Every profile gets its own secure store: sessions are keyed by the sorted
// pair of identity keys, so a shared store would let the two sides of a
// conversation read each other's ratchet state.
vi.mock('./secureStorage', () => ({
  secureGet: vi.fn(async (key: string) => mocks.activeStore.get(key) ?? null),
  secureSet: vi.fn(async (key: string, value: string) => {
    mocks.activeStore.set(key, value);
  }),
  secureDelete: vi.fn(async (key: string) => {
    mocks.activeStore.delete(key);
  }),
}));

vi.mock('../api/keys', () => ({
  keysApi: {
    getBundle: (userId: string) => mocks.getBundle(userId),
  },
}));

interface TestUser {
  id: string;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

function makeUser(id: string): TestUser {
  const privateKey = ed25519.utils.randomSecretKey();
  return { id, privateKey, publicKeyHex: bytesToHex(ed25519.getPublicKey(privateKey)) };
}

function useProfile(userId: string): void {
  let store = mocks.profiles.get(userId);
  if (!store) {
    store = new Map<string, string>();
    mocks.profiles.set(userId, store);
  }
  mocks.activeStore = store;
}

/**
 * Publish a prekey bundle for `user` and persist the matching private material
 * into that user's profile store, exactly as the client does on READY.
 */
async function publishBundle(user: TestUser): Promise<void> {
  useProfile(user.id);
  const store = generatePrekeyBundle(user.privateKey);
  await savePrekeyStore(store);
  mocks.bundles.set(user.id, {
    identity_key: user.publicKeyHex,
    signed_prekey: {
      id: store.signedPrekey.id,
      public_key: toBase64(store.signedPrekey.publicKey),
      signature: toBase64(ed25519.sign(store.signedPrekey.publicKey, user.privateKey)),
    },
    one_time_prekey: {
      id: store.oneTimePrekeys[0].id,
      public_key: toBase64(store.oneTimePrekeys[0].publicKey),
    },
  });
}

const channelId = 'dm-channel-1';

describe('dmE2ee identity binding', () => {
  let alice: TestUser;
  let bob: TestUser;
  let mallory: TestUser;

  beforeEach(async () => {
    mocks.profiles.clear();
    mocks.bundles.clear();
    mocks.activeStore = new Map<string, string>();
    mocks.getBundle.mockClear();
    alice = makeUser('alice');
    bob = makeUser('bob');
    mallory = makeUser('mallory');
    await publishBundle(bob);
  });

  it('establishes a session and round-trips a message', async () => {
    useProfile(alice.id);
    const payload = await encryptDmMessageV2(
      channelId,
      'hello bob',
      alice.privateKey,
      bob.publicKeyHex,
      bob.id,
    );

    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, payload, bob.privateKey, alice.publicKeyHex),
    ).resolves.toBe('hello bob');
  });

  it('rejects a message whose header identity key is not the DM peer', async () => {
    // Mallory can insert messages into the channel (hostile server / delivery
    // path). Her X3DH initial message is well formed — it is simply not from
    // the peer Bob is talking to.
    useProfile(mallory.id);
    const forged = await encryptDmMessageV2(
      channelId,
      'i am alice, send me secrets',
      mallory.privateKey,
      bob.publicKeyHex,
      bob.id,
    );

    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, forged, bob.privateKey, alice.publicKeyHex),
    ).rejects.toMatchObject({ code: 'PEER_IDENTITY_MISMATCH' });
  });

  it('does not let a forged initial message replace an established session', async () => {
    useProfile(alice.id);
    const first = await encryptDmMessageV2(
      channelId,
      'first',
      alice.privateKey,
      bob.publicKeyHex,
      bob.id,
    );

    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, first, bob.privateKey, alice.publicKeyHex),
    ).resolves.toBe('first');

    // Mallory now tries to take over the conversation.
    useProfile(mallory.id);
    const hijack = await encryptDmMessageV2(
      channelId,
      'hijack',
      mallory.privateKey,
      bob.publicKeyHex,
      bob.id,
    );
    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, hijack, bob.privateKey, alice.publicKeyHex),
    ).rejects.toThrow(DmE2eeError);

    // Alice's session is untouched.
    useProfile(alice.id);
    const second = await encryptDmMessageV2(
      channelId,
      'second',
      alice.privateKey,
      bob.publicKeyHex,
      bob.id,
    );
    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, second, bob.privateKey, alice.publicKeyHex),
    ).resolves.toBe('second');
  });

  it('keeps an established session after a failed decrypt (no reset oracle)', async () => {
    useProfile(alice.id);
    const first = await encryptDmMessageV2(
      channelId,
      'first',
      alice.privateKey,
      bob.publicKeyHex,
      bob.id,
    );
    const second = await encryptDmMessageV2(
      channelId,
      'second',
      alice.privateKey,
      bob.publicKeyHex,
      bob.id,
    );

    useProfile(bob.id);
    await expect(
      decryptDmMessage(channelId, first, bob.privateKey, alice.publicKeyHex),
    ).resolves.toBe('first');

    // Replay the X3DH initial message with a mangled ciphertext. The identity
    // key is genuine, so only the *authenticity* of the payload rules it out —
    // which is precisely the case that used to delete the session.
    const corrupted = { ...first, ciphertext: toBase64(new Uint8Array(48).fill(7)) };
    await expect(
      decryptDmMessage(channelId, corrupted, bob.privateKey, alice.publicKeyHex),
    ).rejects.toThrow();

    await expect(
      decryptDmMessage(channelId, second, bob.privateKey, alice.publicKeyHex),
    ).resolves.toBe('second');
  });

  it('refuses to encrypt when the prekey bundle identity key is substituted', async () => {
    // A malicious server hands out its own identity key with a matching
    // self-signed prekey: the X3DH signature check passes, so only the
    // cross-check against the recipient key catches it.
    const substituted = generatePrekeyBundle(mallory.privateKey);
    mocks.bundles.set(bob.id, {
      identity_key: mallory.publicKeyHex,
      signed_prekey: {
        id: substituted.signedPrekey.id,
        public_key: toBase64(substituted.signedPrekey.publicKey),
        signature: toBase64(ed25519.sign(substituted.signedPrekey.publicKey, mallory.privateKey)),
      },
      one_time_prekey: null,
    });

    useProfile(alice.id);
    await expect(
      encryptDmMessageV2(channelId, 'secret', alice.privateKey, bob.publicKeyHex, bob.id),
    ).rejects.toMatchObject({ code: 'PEER_IDENTITY_MISMATCH' });
  });

  it('fails closed when the peer identity key rotates, and recovers on verification', async () => {
    useProfile(alice.id);
    await encryptDmMessageV2(channelId, 'hello', alice.privateKey, bob.publicKeyHex, bob.id);

    // The server now serves a different identity key for Bob everywhere.
    const rotatedBob = { ...bob, privateKey: mallory.privateKey, publicKeyHex: mallory.publicKeyHex };
    await publishBundle({ ...rotatedBob, id: bob.id });
    useProfile(alice.id);

    await expect(
      encryptDmMessageV2(
        channelId,
        'still secret',
        alice.privateKey,
        rotatedBob.publicKeyHex,
        bob.id,
      ),
    ).rejects.toBeInstanceOf(IdentityPinError);

    // Recovery: Alice verifies the new fingerprint out of band.
    await markIdentityVerified(bob.id, formatIdentityFingerprint(rotatedBob.publicKeyHex));
    await expect(
      encryptDmMessageV2(
        channelId,
        'still secret',
        alice.privateKey,
        rotatedBob.publicKeyHex,
        bob.id,
      ),
    ).resolves.toMatchObject({ version: 2 });
  });
});
