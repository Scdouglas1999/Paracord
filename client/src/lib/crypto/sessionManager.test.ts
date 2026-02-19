import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock secureStorage before importing sessionManager
vi.mock('../secureStorage', () => {
  const store = new Map<string, string>();
  return {
    secureGet: vi.fn(async (key: string) => store.get(key) ?? null),
    secureSet: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    secureDelete: vi.fn(async (key: string) => { store.delete(key); }),
    __store: store,
  };
});

import {
  serializeState,
  deserializeState,
  loadSession,
  saveSession,
  deleteSession,
  loadPrekeyStore,
  savePrekeyStore,
  generatePrekeyBundle,
  generateAdditionalOPKs,
  consumeLocalOPK,
  getSignedPrekeyPair,
} from './sessionManager';
import type { RatchetState } from './types';
import { OPK_BATCH_SIZE } from './types';
import { generateX25519KeyPair } from './x3dh';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';

// Access the mock store for cleanup
const mockModule = await import('../secureStorage');
const mockStore = (mockModule as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => {
  mockStore.clear();
});

describe('crypto/sessionManager', () => {
  function makeTestRatchetState(): RatchetState {
    const kp = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    return {
      DHs: kp,
      DHr: kp2.publicKey,
      RK: crypto.getRandomValues(new Uint8Array(32)),
      CKs: crypto.getRandomValues(new Uint8Array(32)),
      CKr: crypto.getRandomValues(new Uint8Array(32)),
      Ns: 5,
      Nr: 3,
      PN: 2,
      MKSKIPPED: new Map([
        ['abc123:0', crypto.getRandomValues(new Uint8Array(32))],
        ['abc123:1', crypto.getRandomValues(new Uint8Array(32))],
      ]),
    };
  }

  describe('serializeState / deserializeState round-trip', () => {
    it('round-trips a full ratchet state', () => {
      const state = makeTestRatchetState();
      const serialized = serializeState(state);
      const deserialized = deserializeState(serialized);

      // Compare binary fields
      expect(deserialized.DHs.publicKey).toEqual(state.DHs.publicKey);
      expect(deserialized.DHs.privateKey).toEqual(state.DHs.privateKey);
      expect(deserialized.DHr).toEqual(state.DHr);
      expect(deserialized.RK).toEqual(state.RK);
      expect(deserialized.CKs).toEqual(state.CKs);
      expect(deserialized.CKr).toEqual(state.CKr);
      expect(deserialized.Ns).toBe(state.Ns);
      expect(deserialized.Nr).toBe(state.Nr);
      expect(deserialized.PN).toBe(state.PN);
      expect(deserialized.MKSKIPPED.size).toBe(state.MKSKIPPED.size);

      for (const [k, v] of state.MKSKIPPED) {
        expect(deserialized.MKSKIPPED.get(k)).toEqual(v);
      }
    });

    it('handles state with null DHr, CKs, CKr', () => {
      const kp = generateX25519KeyPair();
      const state: RatchetState = {
        DHs: kp,
        DHr: null,
        RK: crypto.getRandomValues(new Uint8Array(32)),
        CKs: null,
        CKr: null,
        Ns: 0,
        Nr: 0,
        PN: 0,
        MKSKIPPED: new Map(),
      };

      const deserialized = deserializeState(serializeState(state));
      expect(deserialized.DHr).toBeNull();
      expect(deserialized.CKs).toBeNull();
      expect(deserialized.CKr).toBeNull();
    });
  });

  describe('loadSession / saveSession / deleteSession', () => {
    it('returns null when no session exists', async () => {
      const session = await loadSession('aaa', 'bbb');
      expect(session).toBeNull();
    });

    it('saves and loads a session', async () => {
      const state = makeTestRatchetState();
      await saveSession('alice', 'bob', state);

      const loaded = await loadSession('alice', 'bob');
      expect(loaded).not.toBeNull();
      expect(loaded!.DHs.publicKey).toEqual(state.DHs.publicKey);
      expect(loaded!.Ns).toBe(state.Ns);
    });

    it('session key is symmetric (alice,bob == bob,alice)', async () => {
      const state = makeTestRatchetState();
      await saveSession('alice', 'bob', state);

      // Loading with reversed order should find the same session
      const loaded = await loadSession('bob', 'alice');
      expect(loaded).not.toBeNull();
      expect(loaded!.DHs.publicKey).toEqual(state.DHs.publicKey);
    });

    it('deletes a session', async () => {
      const state = makeTestRatchetState();
      await saveSession('alice', 'bob', state);
      await deleteSession('alice', 'bob');
      const loaded = await loadSession('alice', 'bob');
      expect(loaded).toBeNull();
    });
  });

  describe('generatePrekeyBundle', () => {
    it('generates a bundle with the correct structure', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);

      expect(store.signedPrekey.publicKey.length).toBe(32);
      expect(store.signedPrekey.privateKey.length).toBe(32);
      expect(store.signedPrekey.id).toBeGreaterThan(0);
      expect(store.signedPrekey.createdAt).toBeGreaterThan(0);
      expect(store.oneTimePrekeys.length).toBe(OPK_BATCH_SIZE);
      expect(store.nextOPKId).toBe(store.signedPrekey.id + OPK_BATCH_SIZE + 1);
    });

    it('generates unique OPK IDs', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);
      const ids = store.oneTimePrekeys.map((k) => k.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('each OPK is a valid x25519 keypair', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);
      for (const opk of store.oneTimePrekeys) {
        expect(opk.publicKey.length).toBe(32);
        expect(opk.privateKey.length).toBe(32);
        // Verify pub = x25519.getPublicKey(priv)
        const derived = x25519.getPublicKey(opk.privateKey);
        expect(opk.publicKey).toEqual(derived);
      }
    });
  });

  describe('generateAdditionalOPKs', () => {
    it('generates the requested number of additional OPKs', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);
      const originalCount = store.oneTimePrekeys.length;

      const { store: updated, newPublicKeys } = generateAdditionalOPKs(store, 10);
      expect(newPublicKeys.length).toBe(10);
      expect(updated.oneTimePrekeys.length).toBe(originalCount + 10);
      expect(updated.nextOPKId).toBe(store.nextOPKId + 10);
    });

    it('new OPK IDs are sequential and continue from nextOPKId', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);
      const startId = store.nextOPKId;

      const { newPublicKeys } = generateAdditionalOPKs(store, 5);
      for (let i = 0; i < 5; i++) {
        expect(newPublicKeys[i].id).toBe(startId + i);
      }
    });
  });

  describe('consumeLocalOPK', () => {
    it('returns the private key and removes the OPK', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);
      const targetOpk = store.oneTimePrekeys[0];

      const result = consumeLocalOPK(store, targetOpk.id);
      expect(result).not.toBeNull();
      expect(result!.privateKey).toEqual(targetOpk.privateKey);
      expect(result!.updatedStore.oneTimePrekeys.length).toBe(store.oneTimePrekeys.length - 1);

      // The consumed OPK should not be in the updated store
      const found = result!.updatedStore.oneTimePrekeys.find((k) => k.id === targetOpk.id);
      expect(found).toBeUndefined();
    });

    it('returns null for a non-existent OPK ID', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);

      const result = consumeLocalOPK(store, 999999);
      expect(result).toBeNull();
    });
  });

  describe('getSignedPrekeyPair', () => {
    it('returns the signed prekey as an X25519KeyPair', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);

      const pair = getSignedPrekeyPair(store);
      expect(pair.publicKey).toEqual(store.signedPrekey.publicKey);
      expect(pair.privateKey).toEqual(store.signedPrekey.privateKey);
    });
  });

  describe('loadPrekeyStore / savePrekeyStore round-trip', () => {
    it('returns null when no store saved', async () => {
      const loaded = await loadPrekeyStore();
      expect(loaded).toBeNull();
    });

    it('saves and loads a prekey store', async () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const store = generatePrekeyBundle(edPriv);

      await savePrekeyStore(store);
      const loaded = await loadPrekeyStore();

      expect(loaded).not.toBeNull();
      expect(loaded!.signedPrekey.publicKey).toEqual(store.signedPrekey.publicKey);
      expect(loaded!.signedPrekey.privateKey).toEqual(store.signedPrekey.privateKey);
      expect(loaded!.signedPrekey.id).toBe(store.signedPrekey.id);
      expect(loaded!.oneTimePrekeys.length).toBe(store.oneTimePrekeys.length);
      expect(loaded!.nextOPKId).toBe(store.nextOPKId);

      // Verify each OPK round-trips correctly
      for (let i = 0; i < store.oneTimePrekeys.length; i++) {
        expect(loaded!.oneTimePrekeys[i].id).toBe(store.oneTimePrekeys[i].id);
        expect(loaded!.oneTimePrekeys[i].publicKey).toEqual(store.oneTimePrekeys[i].publicKey);
        expect(loaded!.oneTimePrekeys[i].privateKey).toEqual(store.oneTimePrekeys[i].privateKey);
      }
    });
  });
});
