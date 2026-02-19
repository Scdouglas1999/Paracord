import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MessageE2eePayload } from '../types';
import { toBase64, fromBase64, toArrayBuffer, bytesToHex } from './crypto/util';
import { x3dhInitiate, x3dhRespond } from './crypto/x3dh';
import {
  initializeInitiator,
  initializeResponder,
  ratchetEncrypt,
  ratchetDecrypt,
} from './crypto/doubleRatchet';
import {
  loadSession,
  saveSession,
  deleteSession,
  loadPrekeyStore,
  savePrekeyStore,
  consumeLocalOPK,
  getSignedPrekeyPair,
} from './crypto/sessionManager';
import type { MessageHeader, PrekeyBundle } from './crypto/types';
import { keysApi } from '../api/keys';

// ── V1 legacy encryption (static ECDH) ──────────────────────────

const DM_E2EE_V1 = 1;
const DM_E2EE_V2 = 2;
const AES_GCM_NONCE_BYTES = 12;
const DM_E2EE_CONTEXT_PREFIX = 'paracord:dm-e2ee:v1:';

function deriveConversationKeyMaterial(
  channelId: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Uint8Array {
  const myPrivateX25519 = ed25519.utils.toMontgomerySecret(myPrivateKeyEd25519);
  const peerPublicEd25519 = hexToBytes(peerPublicKeyEd25519Hex);
  const peerPublicX25519 = ed25519.utils.toMontgomery(peerPublicEd25519);
  const sharedSecret = x25519.getSharedSecret(myPrivateX25519, peerPublicX25519);
  const context = utf8ToBytes(`${DM_E2EE_CONTEXT_PREFIX}${channelId}`);
  return sha256(concatBytes(context, sharedSecret));
}

async function deriveConversationKey(
  channelId: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Promise<CryptoKey> {
  const keyMaterial = deriveConversationKeyMaterial(
    channelId,
    myPrivateKeyEd25519,
    peerPublicKeyEd25519Hex,
  );
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyMaterial),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptV1(
  channelId: string,
  plaintext: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Promise<MessageE2eePayload> {
  const key = await deriveConversationKey(
    channelId,
    myPrivateKeyEd25519,
    peerPublicKeyEd25519Hex,
  );
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const plaintextBytes = utf8ToBytes(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plaintextBytes),
  );
  return {
    version: DM_E2EE_V1,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptV1(
  channelId: string,
  payload: MessageE2eePayload,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Promise<string> {
  const key = await deriveConversationKey(
    channelId,
    myPrivateKeyEd25519,
    peerPublicKeyEd25519Hex,
  );
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    throw new Error('Invalid DM E2EE nonce');
  }
  const ciphertext = fromBase64(payload.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// ── V2 Signal Protocol encryption ────────────────────────────────

/**
 * Fetch a peer's prekey bundle from the server and parse it into typed form.
 */
async function fetchPeerBundle(peerUserId: string): Promise<PrekeyBundle | null> {
  try {
    const { data } = await keysApi.getBundle(peerUserId);
    const identityKey = hexToBytes(data.identity_key);
    const spkPub = fromBase64(data.signed_prekey.public_key);
    const spkSig = fromBase64(data.signed_prekey.signature);
    const oneTimePrekey = data.one_time_prekey
      ? {
          id: data.one_time_prekey.id,
          publicKey: fromBase64(data.one_time_prekey.public_key),
        }
      : undefined;

    return {
      identityKey,
      signedPrekey: {
        id: data.signed_prekey.id,
        publicKey: spkPub,
        signature: spkSig,
      },
      oneTimePrekey,
    };
  } catch {
    return null;
  }
}

function getMyPublicKeyHex(myPrivateKeyEd25519: Uint8Array): string {
  const edPub = ed25519.getPublicKey(myPrivateKeyEd25519);
  return bytesToHex(edPub);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Encrypt a DM message using Signal v2 if possible, falling back to v1.
 */
export async function encryptDmMessage(
  channelId: string,
  plaintext: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Promise<MessageE2eePayload> {
  const myPubHex = getMyPublicKeyHex(myPrivateKeyEd25519);

  // Try to load an existing session
  let session = await loadSession(myPubHex, peerPublicKeyEd25519Hex);

  if (!session) {
    // No session exists — fall back to v1 (use encryptDmMessageV2 with peerUserId
    // to enable X3DH session initiation)
    return encryptV1(channelId, plaintext, myPrivateKeyEd25519, peerPublicKeyEd25519Hex);
  }

  // Encrypt with the existing session
  const result = await ratchetEncrypt(session, plaintext);
  await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);

  return {
    version: DM_E2EE_V2,
    nonce: result.nonce,
    ciphertext: result.ciphertext,
    header: JSON.stringify(result.header),
  };
}

/**
 * Encrypt a DM message with peer user ID available (enables X3DH session initiation).
 */
export async function encryptDmMessageV2(
  channelId: string,
  plaintext: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
  peerUserId: string,
): Promise<MessageE2eePayload> {
  const myPubHex = getMyPublicKeyHex(myPrivateKeyEd25519);

  // Try to load an existing session
  let session = await loadSession(myPubHex, peerPublicKeyEd25519Hex);

  if (!session) {
    // No session — initiate via X3DH
    const bundle = await fetchPeerBundle(peerUserId);
    if (!bundle) {
      // Peer has no prekey bundle — fall back to v1
      return encryptV1(channelId, plaintext, myPrivateKeyEd25519, peerPublicKeyEd25519Hex);
    }

    const x3dhResult = x3dhInitiate(myPrivateKeyEd25519, bundle);
    session = initializeInitiator(x3dhResult.sharedSecret, bundle.signedPrekey.publicKey);

    // Encrypt the first message
    const result = await ratchetEncrypt(session, plaintext);
    await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);

    // Add X3DH header fields to the first message
    const myEdPub = ed25519.getPublicKey(myPrivateKeyEd25519);
    const header: MessageE2eePayload['header'] = JSON.stringify({
      ...result.header,
      ik: toBase64(myEdPub),
      ek: toBase64(x3dhResult.ephemeralPublic),
      opk_id: x3dhResult.usedOPKId,
    });

    return {
      version: DM_E2EE_V2,
      nonce: result.nonce,
      ciphertext: result.ciphertext,
      header,
    };
  }

  // Existing session — normal ratchet encrypt
  const result = await ratchetEncrypt(session, plaintext);
  await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);

  return {
    version: DM_E2EE_V2,
    nonce: result.nonce,
    ciphertext: result.ciphertext,
    header: JSON.stringify(result.header),
  };
}

/**
 * Decrypt a DM message. Routes to v1 or v2 based on payload version.
 */
export async function decryptDmMessage(
  channelId: string,
  payload: MessageE2eePayload,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Promise<string> {
  if (payload.version === DM_E2EE_V1 || !payload.header) {
    return decryptV1(channelId, payload, myPrivateKeyEd25519, peerPublicKeyEd25519Hex);
  }

  if (payload.version !== DM_E2EE_V2) {
    throw new Error(`Unsupported DM E2EE version: ${payload.version}`);
  }

  const header: MessageHeader = JSON.parse(payload.header);
  const myPubHex = getMyPublicKeyHex(myPrivateKeyEd25519);
  let session = await loadSession(myPubHex, peerPublicKeyEd25519Hex);

  // If this is an X3DH initial message (has ik + ek), we may need to init as responder
  if (!session && header.ik && header.ek) {
    const peerEdPub = fromBase64(header.ik);
    const ephemeralPub = fromBase64(header.ek);

    // Load our prekey store to get the signed prekey private + optional OPK
    const prekeyStore = await loadPrekeyStore();
    if (!prekeyStore) {
      throw new Error('Cannot decrypt X3DH message: no local prekey store');
    }

    let opkPrivate: Uint8Array | null = null;
    let updatedStore = prekeyStore;
    if (header.opk_id !== undefined && header.opk_id !== null) {
      const consumed = consumeLocalOPK(prekeyStore, header.opk_id);
      if (consumed) {
        opkPrivate = consumed.privateKey;
        updatedStore = consumed.updatedStore;
      }
    }

    const sharedSecret = x3dhRespond(
      myPrivateKeyEd25519,
      prekeyStore.signedPrekey.privateKey,
      opkPrivate,
      peerEdPub,
      ephemeralPub,
    );

    session = initializeResponder(sharedSecret, getSignedPrekeyPair(prekeyStore));

    // Save the updated prekey store (OPK consumed)
    if (opkPrivate) {
      await savePrekeyStore(updatedStore);
    }
  }

  if (!session) {
    // Try X3DH re-initiation: clear any stale session and fail
    throw new Error('No session found and message is not an X3DH initial message');
  }

  try {
    const result = await ratchetDecrypt(session, header, payload.nonce, payload.ciphertext);
    await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);
    return result.plaintext;
  } catch (err) {
    // If decryption fails and this is an X3DH initial message, try resetting
    if (header.ik && header.ek) {
      await deleteSession(myPubHex, peerPublicKeyEd25519Hex);

      // Retry with a fresh session
      const peerEdPub = fromBase64(header.ik);
      const ephemeralPub = fromBase64(header.ek);
      const prekeyStore = await loadPrekeyStore();
      if (!prekeyStore) throw err;

      let opkPrivate: Uint8Array | null = null;
      let updatedStore = prekeyStore;
      if (header.opk_id !== undefined && header.opk_id !== null) {
        const consumed = consumeLocalOPK(prekeyStore, header.opk_id);
        if (consumed) {
          opkPrivate = consumed.privateKey;
          updatedStore = consumed.updatedStore;
        }
      }

      const sharedSecret = x3dhRespond(
        myPrivateKeyEd25519,
        prekeyStore.signedPrekey.privateKey,
        opkPrivate,
        peerEdPub,
        ephemeralPub,
      );

      const freshSession = initializeResponder(sharedSecret, getSignedPrekeyPair(prekeyStore));
      const result = await ratchetDecrypt(freshSession, header, payload.nonce, payload.ciphertext);
      await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);
      if (opkPrivate) await savePrekeyStore(updatedStore);
      return result.plaintext;
    }
    throw err;
  }
}
