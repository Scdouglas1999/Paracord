import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  initializeInitiator,
  initializeResponder,
  ratchetEncrypt,
  ratchetDecrypt,
} from './doubleRatchet';
import { x3dhInitiate, x3dhRespond, generateX25519KeyPair } from './x3dh';
import type { PrekeyBundle, RatchetState } from './types';

/**
 * Helper: set up a full X3DH key exchange and return initialized sessions for
 * both Alice (initiator) and Bob (responder).
 */
function setupAliceBobSessions(): {
  aliceState: RatchetState;
  bobState: RatchetState;
} {
  const aliceEdPriv = ed25519.utils.randomSecretKey();
  const bobEdPriv = ed25519.utils.randomSecretKey();
  const bobEdPub = ed25519.getPublicKey(bobEdPriv);
  const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

  // Bob's prekey bundle
  const spk = generateX25519KeyPair();
  const spkSig = ed25519.sign(spk.publicKey, bobEdPriv);
  const opk = generateX25519KeyPair();

  const bundle: PrekeyBundle = {
    identityKey: bobEdPub,
    signedPrekey: { id: 1, publicKey: spk.publicKey, signature: spkSig },
    oneTimePrekey: { id: 100, publicKey: opk.publicKey },
  };

  // Alice: X3DH initiate
  const x3dhResult = x3dhInitiate(aliceEdPriv, bundle);

  // Bob: X3DH respond
  const bobSecret = x3dhRespond(
    bobEdPriv,
    spk.privateKey,
    opk.privateKey,
    aliceEdPub,
    x3dhResult.ephemeralPublic,
  );

  // Verify shared secret matches
  if (
    x3dhResult.sharedSecret.length !== bobSecret.length ||
    !x3dhResult.sharedSecret.every((b, i) => b === bobSecret[i])
  ) {
    throw new Error('X3DH shared secrets do not match in test setup');
  }

  // Initialize Double Ratchet states
  const aliceState = initializeInitiator(x3dhResult.sharedSecret, bundle.signedPrekey.publicKey);
  const bobState = initializeResponder(bobSecret, {
    publicKey: spk.publicKey,
    privateKey: spk.privateKey,
  });

  return { aliceState, bobState };
}

describe('crypto/doubleRatchet', () => {
  describe('initializeInitiator', () => {
    it('creates a state with CKs set (can send immediately)', () => {
      const { aliceState } = setupAliceBobSessions();
      expect(aliceState.CKs).not.toBeNull();
      expect(aliceState.CKr).toBeNull();
      expect(aliceState.Ns).toBe(0);
      expect(aliceState.Nr).toBe(0);
      expect(aliceState.DHr).not.toBeNull();
      expect(aliceState.MKSKIPPED.size).toBe(0);
    });
  });

  describe('initializeResponder', () => {
    it('creates a state with CKs=null (must receive first)', () => {
      const { bobState } = setupAliceBobSessions();
      expect(bobState.CKs).toBeNull();
      expect(bobState.CKr).toBeNull();
      expect(bobState.DHr).toBeNull();
      expect(bobState.RK.length).toBe(32);
    });
  });

  describe('single message: Alice → Bob', () => {
    it('encrypts and decrypts correctly', async () => {
      const { aliceState, bobState } = setupAliceBobSessions();
      const plaintext = 'Hello Bob, this is Alice!';

      const encrypted = await ratchetEncrypt(aliceState, plaintext);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.nonce).toBeTruthy();
      expect(encrypted.header.n).toBe(0);
      expect(encrypted.header.pn).toBe(0);

      // Ciphertext should not contain the plaintext
      expect(encrypted.ciphertext).not.toContain(plaintext);

      const decrypted = await ratchetDecrypt(
        bobState,
        encrypted.header,
        encrypted.nonce,
        encrypted.ciphertext,
      );
      expect(decrypted.plaintext).toBe(plaintext);
    });
  });

  describe('multiple messages: Alice → Bob then Bob → Alice', () => {
    it('handles a 2-way conversation', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      // Alice → Bob: message 1
      const enc1 = await ratchetEncrypt(aliceState, 'Message 1 from Alice');
      aliceState = enc1.state;
      const dec1 = await ratchetDecrypt(bobState, enc1.header, enc1.nonce, enc1.ciphertext);
      bobState = dec1.state;
      expect(dec1.plaintext).toBe('Message 1 from Alice');

      // Bob → Alice: message 2
      const enc2 = await ratchetEncrypt(bobState, 'Reply from Bob');
      bobState = enc2.state;
      const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
      aliceState = dec2.state;
      expect(dec2.plaintext).toBe('Reply from Bob');

      // Alice → Bob: message 3
      const enc3 = await ratchetEncrypt(aliceState, 'Second message from Alice');
      aliceState = enc3.state;
      const dec3 = await ratchetDecrypt(bobState, enc3.header, enc3.nonce, enc3.ciphertext);
      bobState = dec3.state;
      expect(dec3.plaintext).toBe('Second message from Alice');
    });
  });

  describe('multiple consecutive messages from same sender', () => {
    it('handles 5 consecutive messages Alice → Bob', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      const messages = ['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5'];
      const encryptedAll: Awaited<ReturnType<typeof ratchetEncrypt>>[] = [];

      for (const msg of messages) {
        const enc = await ratchetEncrypt(aliceState, msg);
        aliceState = enc.state;
        encryptedAll.push(enc);
      }

      // Verify message counters increment
      expect(encryptedAll[0].header.n).toBe(0);
      expect(encryptedAll[1].header.n).toBe(1);
      expect(encryptedAll[4].header.n).toBe(4);

      // Decrypt all in order
      for (let i = 0; i < encryptedAll.length; i++) {
        const enc = encryptedAll[i];
        const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
        bobState = dec.state;
        expect(dec.plaintext).toBe(messages[i]);
      }
    });
  });

  describe('out-of-order message delivery', () => {
    it('handles receiving messages out of order (2 ahead, then backfill)', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      // Alice sends 3 messages
      const enc1 = await ratchetEncrypt(aliceState, 'first');
      aliceState = enc1.state;
      const enc2 = await ratchetEncrypt(aliceState, 'second');
      aliceState = enc2.state;
      const enc3 = await ratchetEncrypt(aliceState, 'third');
      aliceState = enc3.state;

      // Bob receives them out of order: 3, 1, 2
      const dec3 = await ratchetDecrypt(bobState, enc3.header, enc3.nonce, enc3.ciphertext);
      bobState = dec3.state;
      expect(dec3.plaintext).toBe('third');

      // Messages 1 and 2 should have been cached in MKSKIPPED
      expect(bobState.MKSKIPPED.size).toBe(2);

      const dec1 = await ratchetDecrypt(bobState, enc1.header, enc1.nonce, enc1.ciphertext);
      bobState = dec1.state;
      expect(dec1.plaintext).toBe('first');

      const dec2 = await ratchetDecrypt(bobState, enc2.header, enc2.nonce, enc2.ciphertext);
      bobState = dec2.state;
      expect(dec2.plaintext).toBe('second');

      // All skipped keys should be consumed now
      expect(bobState.MKSKIPPED.size).toBe(0);
    });
  });

  describe('forward secrecy', () => {
    it('different messages produce different ciphertexts (unique keys per message)', async () => {
      let { aliceState } = setupAliceBobSessions();
      const sameMessage = 'Hello World';

      const enc1 = await ratchetEncrypt(aliceState, sameMessage);
      aliceState = enc1.state;
      const enc2 = await ratchetEncrypt(aliceState, sameMessage);

      // Even with the same plaintext, ciphertext must differ (different keys + nonces)
      expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    });
  });

  describe('DH ratchet step', () => {
    it('advances DH keys on direction change', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      // Alice sends, Bob receives → Bob's DHr is set
      const enc1 = await ratchetEncrypt(aliceState, 'alice to bob');
      aliceState = enc1.state;
      const dec1 = await ratchetDecrypt(bobState, enc1.header, enc1.nonce, enc1.ciphertext);
      bobState = dec1.state;

      // Bob now sends back → triggers a DH ratchet
      const enc2 = await ratchetEncrypt(bobState, 'bob to alice');
      bobState = enc2.state;

      // The header DH key should be the key Bob had before sending
      // (because the header is set before updating)
      // But after Alice decrypts, her state will have done a DH ratchet
      const aliceDHsBefore = aliceState.DHs.publicKey;
      const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
      aliceState = dec2.state;

      // Alice should have a new sending keypair after DH ratchet
      expect(aliceState.DHs.publicKey).not.toEqual(aliceDHsBefore);
      expect(dec2.plaintext).toBe('bob to alice');
    });
  });

  describe('tampered ciphertext', () => {
    it('rejects tampered ciphertext (AES-GCM auth tag fails)', async () => {
      const { aliceState, bobState } = setupAliceBobSessions();

      const enc = await ratchetEncrypt(aliceState, 'secret message');

      // Tamper with ciphertext: flip a byte
      const tamperedCt = enc.ciphertext;
      // Decode, flip bit, re-encode
      const ctBytes = Uint8Array.from(atob(tamperedCt), (c) => c.charCodeAt(0));
      ctBytes[0] ^= 0xff;
      let tamperedB64 = '';
      for (let i = 0; i < ctBytes.length; i++) {
        tamperedB64 += String.fromCharCode(ctBytes[i]);
      }
      tamperedB64 = btoa(tamperedB64);

      await expect(
        ratchetDecrypt(bobState, enc.header, enc.nonce, tamperedB64),
      ).rejects.toThrow();
    });
  });

  describe('tampered header (AEAD associated data)', () => {
    it('rejects message when header is altered', async () => {
      const { aliceState, bobState } = setupAliceBobSessions();

      const enc = await ratchetEncrypt(aliceState, 'authenticated message');

      // Tamper with the header: change the message number
      const tamperedHeader = { ...enc.header, n: enc.header.n + 1 };

      await expect(
        ratchetDecrypt(bobState, tamperedHeader, enc.nonce, enc.ciphertext),
      ).rejects.toThrow();
    });
  });

  describe('long conversation stress test', () => {
    it('handles 20 round-trip message exchanges', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      for (let i = 0; i < 20; i++) {
        // Alice → Bob
        const msg = `Alice message ${i}`;
        const enc = await ratchetEncrypt(aliceState, msg);
        aliceState = enc.state;
        const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
        bobState = dec.state;
        expect(dec.plaintext).toBe(msg);

        // Bob → Alice
        const reply = `Bob reply ${i}`;
        const enc2 = await ratchetEncrypt(bobState, reply);
        bobState = enc2.state;
        const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
        aliceState = dec2.state;
        expect(dec2.plaintext).toBe(reply);
      }
    }, 30000);
  });

  describe('unicode and empty messages', () => {
    it('handles unicode content', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      const msg = '🔐 Hello 你好 مرحبا';
      const enc = await ratchetEncrypt(aliceState, msg);
      aliceState = enc.state;
      const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
      expect(dec.plaintext).toBe(msg);
    });

    it('handles empty string', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      const enc = await ratchetEncrypt(aliceState, '');
      aliceState = enc.state;
      const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
      expect(dec.plaintext).toBe('');
    });

    it('handles long message (10KB)', async () => {
      let { aliceState, bobState } = setupAliceBobSessions();

      const msg = 'x'.repeat(10240);
      const enc = await ratchetEncrypt(aliceState, msg);
      aliceState = enc.state;
      const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
      expect(dec.plaintext).toBe(msg);
    });
  });

  describe('cannot send without initialized sending chain', () => {
    it('responder cannot encrypt before receiving first message', async () => {
      const { bobState } = setupAliceBobSessions();
      // Bob's CKs is null — he hasn't received any message yet
      expect(bobState.CKs).toBeNull();
      await expect(ratchetEncrypt(bobState, 'should fail')).rejects.toThrow(
        'Sending chain not initialized',
      );
    });
  });
});
