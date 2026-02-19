/**
 * Integration tests: Full Signal Protocol flow from X3DH through Double Ratchet,
 * simulating real user interactions end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  generateX25519KeyPair,
  x3dhInitiate,
  x3dhRespond,
} from './x3dh';
import {
  initializeInitiator,
  initializeResponder,
  ratchetEncrypt,
  ratchetDecrypt,
} from './doubleRatchet';
import {
  serializeState,
  deserializeState,
  generatePrekeyBundle,
  generateAdditionalOPKs,
  consumeLocalOPK,
  getSignedPrekeyPair,
} from './sessionManager';
import { toBase64, fromBase64 } from './util';
import type { PrekeyBundle, MessageHeader } from './types';

/**
 * Simulates the complete server-side prekey bundle creation and retrieval.
 * This is what happens when a user registers and uploads keys, and a peer
 * fetches them.
 */
function simulateServerPrekeyFlow(bobEdPriv: Uint8Array) {
  // Bob generates local prekey store (as the client would on READY)
  const bobStore = generatePrekeyBundle(bobEdPriv);
  const bobEdPub = ed25519.getPublicKey(bobEdPriv);

  // Bob uploads to server: signed prekey + signature + OPKs
  // The server stores these and the client fetches them as a PrekeyBundle
  const spkSig = ed25519.sign(bobStore.signedPrekey.publicKey, bobEdPriv);

  // Simulate server response when Alice fetches Bob's bundle
  const serverBundle: PrekeyBundle = {
    identityKey: bobEdPub,
    signedPrekey: {
      id: bobStore.signedPrekey.id,
      publicKey: bobStore.signedPrekey.publicKey,
      signature: spkSig,
    },
    oneTimePrekey: bobStore.oneTimePrekeys.length > 0
      ? {
          id: bobStore.oneTimePrekeys[0].id,
          publicKey: bobStore.oneTimePrekeys[0].publicKey,
        }
      : undefined,
  };

  return { bobStore, serverBundle, spkSig };
}

describe('Full Signal Protocol Integration', () => {
  describe('complete X3DH → Double Ratchet → conversation flow', () => {
    it('simulates a full conversation between two users', async () => {
      // === Setup: Both users have Ed25519 identity keys ===
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

      // === Step 1: Bob publishes his prekey bundle (server upload simulation) ===
      const { bobStore, serverBundle } = simulateServerPrekeyFlow(bobEdPriv);

      // === Step 2: Alice fetches Bob's bundle and initiates X3DH ===
      const x3dhResult = x3dhInitiate(aliceEdPriv, serverBundle);
      expect(x3dhResult.sharedSecret).toHaveLength(32);
      expect(x3dhResult.ephemeralPublic).toHaveLength(32);
      expect(x3dhResult.usedOPKId).toBe(serverBundle.oneTimePrekey!.id);

      // === Step 3: Alice initializes her Double Ratchet session ===
      let aliceState = initializeInitiator(
        x3dhResult.sharedSecret,
        serverBundle.signedPrekey.publicKey,
      );

      // === Step 4: Alice encrypts her first message ===
      const firstMsg = 'Hey Bob! This is encrypted with Signal protocol.';
      const enc1 = await ratchetEncrypt(aliceState, firstMsg);
      aliceState = enc1.state;

      // Simulate the message payload as it would be sent over the wire
      const wirePayload = {
        version: 2,
        nonce: enc1.nonce,
        ciphertext: enc1.ciphertext,
        header: JSON.stringify({
          ...enc1.header,
          ik: toBase64(aliceEdPub),
          ek: toBase64(x3dhResult.ephemeralPublic),
          opk_id: x3dhResult.usedOPKId,
        }),
      };

      // === Step 5: Bob receives the message and processes X3DH ===
      const parsedHeader: MessageHeader = JSON.parse(wirePayload.header);
      expect(parsedHeader.ik).toBeTruthy();
      expect(parsedHeader.ek).toBeTruthy();

      // Bob extracts Alice's identity key and ephemeral key
      const peerEdPub = fromBase64(parsedHeader.ik!);
      const ephemeralPub = fromBase64(parsedHeader.ek!);

      // Bob consumes the OPK
      const consumed = consumeLocalOPK(bobStore, parsedHeader.opk_id!);
      expect(consumed).not.toBeNull();

      // Bob completes X3DH
      const bobSecret = x3dhRespond(
        bobEdPriv,
        bobStore.signedPrekey.privateKey,
        consumed!.privateKey,
        peerEdPub,
        ephemeralPub,
      );

      // CRITICAL CHECK: Both sides derived the same shared secret
      expect(bobSecret).toEqual(x3dhResult.sharedSecret);

      // === Step 6: Bob initializes his Double Ratchet session ===
      let bobState = initializeResponder(bobSecret, getSignedPrekeyPair(bobStore));

      // === Step 7: Bob decrypts Alice's first message ===
      const ratchetHeader: MessageHeader = {
        dh: parsedHeader.dh,
        pn: parsedHeader.pn,
        n: parsedHeader.n,
      };
      const dec1 = await ratchetDecrypt(
        bobState,
        ratchetHeader,
        wirePayload.nonce,
        wirePayload.ciphertext,
      );
      bobState = dec1.state;
      expect(dec1.plaintext).toBe(firstMsg);

      // === Step 8: Bob replies (DH ratchet advances) ===
      const reply = 'Hello Alice! Encryption is working perfectly.';
      const enc2 = await ratchetEncrypt(bobState, reply);
      bobState = enc2.state;

      const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
      aliceState = dec2.state;
      expect(dec2.plaintext).toBe(reply);

      // === Step 9: Continue conversation (multiple exchanges) ===
      const conversation = [
        { sender: 'alice', text: 'How is the encryption performance?' },
        { sender: 'bob', text: 'Great, AES-GCM is fast!' },
        { sender: 'alice', text: 'And forward secrecy?' },
        { sender: 'bob', text: 'New DH keys on every direction change.' },
        { sender: 'alice', text: 'Perfect. 🔐' },
      ];

      for (const msg of conversation) {
        if (msg.sender === 'alice') {
          const enc = await ratchetEncrypt(aliceState, msg.text);
          aliceState = enc.state;
          const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
          bobState = dec.state;
          expect(dec.plaintext).toBe(msg.text);
        } else {
          const enc = await ratchetEncrypt(bobState, msg.text);
          bobState = enc.state;
          const dec = await ratchetDecrypt(aliceState, enc.header, enc.nonce, enc.ciphertext);
          aliceState = dec.state;
          expect(dec.plaintext).toBe(msg.text);
        }
      }
    });
  });

  describe('session serialization mid-conversation', () => {
    it('can serialize/deserialize state and continue conversation', async () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

      const { bobStore, serverBundle } = simulateServerPrekeyFlow(bobEdPriv);
      const x3dhResult = x3dhInitiate(aliceEdPriv, serverBundle);
      const consumed = consumeLocalOPK(bobStore, x3dhResult.usedOPKId!);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        bobStore.signedPrekey.privateKey,
        consumed!.privateKey,
        aliceEdPub,
        x3dhResult.ephemeralPublic,
      );

      let aliceState = initializeInitiator(x3dhResult.sharedSecret, serverBundle.signedPrekey.publicKey);
      let bobState = initializeResponder(bobSecret, getSignedPrekeyPair(bobStore));

      // Exchange a few messages
      const enc1 = await ratchetEncrypt(aliceState, 'msg before serialize');
      aliceState = enc1.state;
      const dec1 = await ratchetDecrypt(bobState, enc1.header, enc1.nonce, enc1.ciphertext);
      bobState = dec1.state;
      expect(dec1.plaintext).toBe('msg before serialize');

      // Serialize both states (simulates app restart / persist to secure storage)
      const aliceSerialized = JSON.stringify(serializeState(aliceState));
      const bobSerialized = JSON.stringify(serializeState(bobState));

      // Deserialize
      aliceState = deserializeState(JSON.parse(aliceSerialized));
      bobState = deserializeState(JSON.parse(bobSerialized));

      // Continue conversation after deserialization
      const enc2 = await ratchetEncrypt(bobState, 'msg after deserialize');
      bobState = enc2.state;
      const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
      aliceState = dec2.state;
      expect(dec2.plaintext).toBe('msg after deserialize');

      const enc3 = await ratchetEncrypt(aliceState, 'alice replies after deserialize');
      aliceState = enc3.state;
      const dec3 = await ratchetDecrypt(bobState, enc3.header, enc3.nonce, enc3.ciphertext);
      bobState = dec3.state;
      expect(dec3.plaintext).toBe('alice replies after deserialize');
    });
  });

  describe('X3DH without one-time prekey (OPKs exhausted)', () => {
    it('still establishes a working session', async () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPub = ed25519.getPublicKey(bobEdPriv);
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

      // Bob's bundle without OPK (simulates exhausted supply)
      const spk = generateX25519KeyPair();
      const spkSig = ed25519.sign(spk.publicKey, bobEdPriv);
      const bundle: PrekeyBundle = {
        identityKey: bobEdPub,
        signedPrekey: { id: 1, publicKey: spk.publicKey, signature: spkSig },
        // No oneTimePrekey
      };

      const x3dhResult = x3dhInitiate(aliceEdPriv, bundle);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        spk.privateKey,
        null,
        aliceEdPub,
        x3dhResult.ephemeralPublic,
      );

      expect(x3dhResult.sharedSecret).toEqual(bobSecret);

      let aliceState = initializeInitiator(x3dhResult.sharedSecret, spk.publicKey);
      let bobState = initializeResponder(bobSecret, spk);

      // Full message exchange works
      const enc = await ratchetEncrypt(aliceState, 'no OPK needed');
      aliceState = enc.state;
      const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
      bobState = dec.state;
      expect(dec.plaintext).toBe('no OPK needed');

      const enc2 = await ratchetEncrypt(bobState, 'bob replies');
      bobState = enc2.state;
      const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.nonce, enc2.ciphertext);
      aliceState = dec2.state;
      expect(dec2.plaintext).toBe('bob replies');
    });
  });

  describe('OPK replenishment flow', () => {
    it('generates additional OPKs and they work for new sessions', async () => {
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const bobStore = generatePrekeyBundle(bobEdPriv);

      // Consume all existing OPKs
      let updatedStore = bobStore;
      for (const opk of bobStore.oneTimePrekeys) {
        const result = consumeLocalOPK(updatedStore, opk.id);
        expect(result).not.toBeNull();
        updatedStore = result!.updatedStore;
      }
      expect(updatedStore.oneTimePrekeys.length).toBe(0);

      // Replenish
      const { store: replenished, newPublicKeys } = generateAdditionalOPKs(updatedStore, 10);
      expect(replenished.oneTimePrekeys.length).toBe(10);
      expect(newPublicKeys.length).toBe(10);

      // Verify the new OPKs work for X3DH
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);
      const bobEdPub = ed25519.getPublicKey(bobEdPriv);
      const spkSig = ed25519.sign(replenished.signedPrekey.publicKey, bobEdPriv);

      const bundle: PrekeyBundle = {
        identityKey: bobEdPub,
        signedPrekey: {
          id: replenished.signedPrekey.id,
          publicKey: replenished.signedPrekey.publicKey,
          signature: spkSig,
        },
        oneTimePrekey: {
          id: newPublicKeys[0].id,
          publicKey: newPublicKeys[0].publicKey,
        },
      };

      const x3dhResult = x3dhInitiate(aliceEdPriv, bundle);
      const consumed = consumeLocalOPK(replenished, newPublicKeys[0].id);
      expect(consumed).not.toBeNull();

      const bobSecret = x3dhRespond(
        bobEdPriv,
        replenished.signedPrekey.privateKey,
        consumed!.privateKey,
        aliceEdPub,
        x3dhResult.ephemeralPublic,
      );

      expect(x3dhResult.sharedSecret).toEqual(bobSecret);
    });
  });

  describe('two independent sessions (Alice↔Bob and Alice↔Carol)', () => {
    it('messages from different sessions do not interfere', async () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const carolEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

      // Set up Alice↔Bob session
      const { bobStore: bobS, serverBundle: bobBundle } = simulateServerPrekeyFlow(bobEdPriv);
      const abResult = x3dhInitiate(aliceEdPriv, bobBundle);
      const bobConsumed = consumeLocalOPK(bobS, abResult.usedOPKId!);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        bobS.signedPrekey.privateKey,
        bobConsumed!.privateKey,
        aliceEdPub,
        abResult.ephemeralPublic,
      );
      let aliceBobState = initializeInitiator(abResult.sharedSecret, bobBundle.signedPrekey.publicKey);
      let bobState = initializeResponder(bobSecret, getSignedPrekeyPair(bobS));

      // Set up Alice↔Carol session
      const { bobStore: carolS, serverBundle: carolBundle } = simulateServerPrekeyFlow(carolEdPriv);
      const acResult = x3dhInitiate(aliceEdPriv, carolBundle);
      const carolConsumed = consumeLocalOPK(carolS, acResult.usedOPKId!);
      const carolSecret = x3dhRespond(
        carolEdPriv,
        carolS.signedPrekey.privateKey,
        carolConsumed!.privateKey,
        aliceEdPub,
        acResult.ephemeralPublic,
      );
      let aliceCarolState = initializeInitiator(acResult.sharedSecret, carolBundle.signedPrekey.publicKey);
      let carolState = initializeResponder(carolSecret, getSignedPrekeyPair(carolS));

      // Alice sends to Bob
      const encBob = await ratchetEncrypt(aliceBobState, 'hi bob');
      aliceBobState = encBob.state;
      const decBob = await ratchetDecrypt(bobState, encBob.header, encBob.nonce, encBob.ciphertext);
      bobState = decBob.state;
      expect(decBob.plaintext).toBe('hi bob');

      // Alice sends to Carol
      const encCarol = await ratchetEncrypt(aliceCarolState, 'hi carol');
      aliceCarolState = encCarol.state;
      const decCarol = await ratchetDecrypt(carolState, encCarol.header, encCarol.nonce, encCarol.ciphertext);
      carolState = decCarol.state;
      expect(decCarol.plaintext).toBe('hi carol');

      // Carol cannot decrypt Bob's message
      await expect(
        ratchetDecrypt(carolState, encBob.header, encBob.nonce, encBob.ciphertext),
      ).rejects.toThrow();

      // Bob cannot decrypt Carol's message
      await expect(
        ratchetDecrypt(bobState, encCarol.header, encCarol.nonce, encCarol.ciphertext),
      ).rejects.toThrow();
    });
  });

  describe('simulated wire format (base64 serialization)', () => {
    it('all wire data is valid base64 and round-trips correctly', async () => {
      const aliceEdPriv = ed25519.utils.randomSecretKey();
      const bobEdPriv = ed25519.utils.randomSecretKey();
      const aliceEdPub = ed25519.getPublicKey(aliceEdPriv);

      const { bobStore, serverBundle } = simulateServerPrekeyFlow(bobEdPriv);
      const x3dhResult = x3dhInitiate(aliceEdPriv, serverBundle);
      const consumed = consumeLocalOPK(bobStore, x3dhResult.usedOPKId!);
      const bobSecret = x3dhRespond(
        bobEdPriv,
        bobStore.signedPrekey.privateKey,
        consumed!.privateKey,
        aliceEdPub,
        x3dhResult.ephemeralPublic,
      );

      let aliceState = initializeInitiator(x3dhResult.sharedSecret, serverBundle.signedPrekey.publicKey);
      let bobState = initializeResponder(bobSecret, getSignedPrekeyPair(bobStore));

      const enc = await ratchetEncrypt(aliceState, 'wire format test');
      aliceState = enc.state;

      // Verify all wire data is base64
      const b64regex = /^[A-Za-z0-9+/=]+$/;
      expect(enc.nonce).toMatch(b64regex);
      expect(enc.ciphertext).toMatch(b64regex);
      expect(enc.header.dh).toMatch(b64regex);

      // Verify header is valid JSON when stringified
      const headerJson = JSON.stringify(enc.header);
      expect(() => JSON.parse(headerJson)).not.toThrow();

      // Verify the header DH is a valid 32-byte key
      const dhBytes = fromBase64(enc.header.dh);
      expect(dhBytes.length).toBe(32);

      // Bob can decrypt from wire format
      const dec = await ratchetDecrypt(bobState, enc.header, enc.nonce, enc.ciphertext);
      expect(dec.plaintext).toBe('wire format test');
    });
  });
});
