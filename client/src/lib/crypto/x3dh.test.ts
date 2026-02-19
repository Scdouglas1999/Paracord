import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  generateX25519KeyPair,
  ed25519PrivateToX25519,
  ed25519PublicToX25519,
  x3dhInitiate,
  x3dhRespond,
} from './x3dh';
import type { PrekeyBundle } from './types';

describe('crypto/x3dh', () => {
  describe('generateX25519KeyPair', () => {
    it('generates a 32-byte public and private key', () => {
      const kp = generateX25519KeyPair();
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    });

    it('generates different keypairs each time', () => {
      const kp1 = generateX25519KeyPair();
      const kp2 = generateX25519KeyPair();
      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    });

    it('public key matches x25519.getPublicKey(privateKey)', () => {
      const kp = generateX25519KeyPair();
      const derivedPub = x25519.getPublicKey(kp.privateKey);
      expect(kp.publicKey).toEqual(derivedPub);
    });
  });

  describe('ed25519 ↔ x25519 conversion', () => {
    it('converts ed25519 private key to x25519 private key (32 bytes)', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const xPriv = ed25519PrivateToX25519(edPriv);
      expect(xPriv.length).toBe(32);
    });

    it('converts ed25519 public key to x25519 public key (32 bytes)', () => {
      const edPriv = ed25519.utils.randomSecretKey();
      const edPub = ed25519.getPublicKey(edPriv);
      const xPub = ed25519PublicToX25519(edPub);
      expect(xPub.length).toBe(32);
    });

    it('DH agreement works between converted keys', () => {
      // Alice: Ed25519 → X25519
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);
      const aliceXPriv = ed25519PrivateToX25519(aliceEdPriv);
      const aliceXPub = ed25519PublicToX25519(aliceEdPub);

      // Bob: Ed25519 → X25519
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPub = ed25519.getPublicKey(bobEdPriv);
      const bobXPriv = ed25519PrivateToX25519(bobEdPriv);
      const bobXPub = ed25519PublicToX25519(bobEdPub);

      // DH should produce the same shared secret
      const ss1 = x25519.getSharedSecret(aliceXPriv, bobXPub);
      const ss2 = x25519.getSharedSecret(bobXPriv, aliceXPub);
      expect(ss1).toEqual(ss2);
    });
  });

  /**
   * Helper to create a realistic prekey bundle for "Bob".
   */
  function createBobBundle(bobEdPriv: Uint8Array): {
    bundle: PrekeyBundle;
    spkPriv: Uint8Array;
    opkPriv: Uint8Array;
  } {
    const bobEdPub = ed25519.getPublicKey(bobEdPriv);

    // Signed prekey (X25519)
    const spk = generateX25519KeyPair();
    // Sign the SPK public key with Ed25519 identity key
    const spkSig = ed25519.sign(spk.publicKey, bobEdPriv);

    // One-time prekey (X25519)
    const opk = generateX25519KeyPair();

    const bundle: PrekeyBundle = {
      identityKey: bobEdPub,
      signedPrekey: {
        id: 1,
        publicKey: spk.publicKey,
        signature: spkSig,
      },
      oneTimePrekey: {
        id: 100,
        publicKey: opk.publicKey,
      },
    };

    return { bundle, spkPriv: spk.privateKey, opkPriv: opk.privateKey };
  }

  describe('x3dhInitiate + x3dhRespond produce same shared secret', () => {
    it('with one-time prekey', () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const { bundle, spkPriv, opkPriv } = createBobBundle(bobEdPriv);

      // Alice initiates
      const aliceResult = x3dhInitiate(aliceEdPriv, bundle);
      expect(aliceResult.sharedSecret.length).toBe(32);
      expect(aliceResult.ephemeralPublic.length).toBe(32);
      expect(aliceResult.usedOPKId).toBe(100);

      // Bob responds
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        spkPriv,
        opkPriv,
        aliceEdPub,
        aliceResult.ephemeralPublic,
      );

      // Both sides must derive the same shared secret
      expect(aliceResult.sharedSecret).toEqual(bobSecret);
    });

    it('without one-time prekey', () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPub = ed25519.getPublicKey(bobEdPriv);

      const spk = generateX25519KeyPair();
      const spkSig = ed25519.sign(spk.publicKey, bobEdPriv);

      const bundle: PrekeyBundle = {
        identityKey: bobEdPub,
        signedPrekey: {
          id: 1,
          publicKey: spk.publicKey,
          signature: spkSig,
        },
        // No oneTimePrekey
      };

      const aliceResult = x3dhInitiate(aliceEdPriv, bundle);
      expect(aliceResult.usedOPKId).toBeUndefined();

      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        spk.privateKey,
        null,
        aliceEdPub,
        aliceResult.ephemeralPublic,
      );

      expect(aliceResult.sharedSecret).toEqual(bobSecret);
    });

    it('rejects bundle with invalid SPK signature', () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPub = ed25519.getPublicKey(bobEdPriv);

      const spk = generateX25519KeyPair();
      // Sign with wrong key (Alice signs, but says it's from Bob)
      const badSig = ed25519.sign(spk.publicKey, aliceEdPriv);

      const bundle: PrekeyBundle = {
        identityKey: bobEdPub,
        signedPrekey: {
          id: 1,
          publicKey: spk.publicKey,
          signature: badSig,
        },
      };

      expect(() => x3dhInitiate(aliceEdPriv, bundle)).toThrow(
        'Signed prekey signature verification failed',
      );
    });

    it('different initiators produce different shared secrets', () => {
      const alice1 = ed25519.utils.randomSecretKey();
      const alice2 = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const { bundle } = createBobBundle(bobEdPriv);

      const r1 = x3dhInitiate(alice1, bundle);
      const r2 = x3dhInitiate(alice2, bundle);

      expect(r1.sharedSecret).not.toEqual(r2.sharedSecret);
    });
  });
});
