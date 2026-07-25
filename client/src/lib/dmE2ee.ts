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
  loadPrekeyStore,
  savePrekeyStore,
  consumeLocalOPK,
  getSignedPrekeyPair,
} from './crypto/sessionManager';
import type { LocalPrekeyStore, MessageHeader, PrekeyBundle, RatchetState } from './crypto/types';
import { assertPinnedDmPeerIdentity, IdentityPinError } from './keyVerification';
import { keysApi } from '../api/keys';

// ── V1 legacy encryption (static ECDH) ──────────────────────────

const DM_E2EE_V1 = 1;
const DM_E2EE_V2 = 2;
const AES_GCM_NONCE_BYTES = 12;
const DM_E2EE_CONTEXT_PREFIX = 'paracord:dm-e2ee:v1:';
const DM_E2EE_ALLOW_V1_FALLBACK = import.meta.env.VITE_DM_E2EE_ALLOW_V1_FALLBACK === 'true';
let hasWarnedV1Fallback = false;

function warnV1Fallback(path: string): void {
  if (hasWarnedV1Fallback) {
    return;
  }
  hasWarnedV1Fallback = true;
  console.warn(
    `[dm-e2ee] Legacy V1 fallback was used via ${path}. V1 is deprecated and will be removed; migrate conversations to Signal V2 sessions.`,
  );
}

export type DmE2eeErrorCode =
  | 'SESSION_REQUIRED'
  | 'PEER_ID_REQUIRED'
  | 'PEER_BUNDLE_UNAVAILABLE'
  | 'PEER_IDENTITY_MISMATCH';

export class DmE2eeError extends Error {
  public readonly code: DmE2eeErrorCode;
  public readonly cause: unknown;

  constructor(code: DmE2eeErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'DmE2eeError';
    this.code = code;
    this.cause = cause;
  }
}

/** Canonical lowercase-hex form used for all identity-key comparisons. */
function normalizeIdentityHex(value: string): string {
  return value.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * Reject any payload whose claimed sender identity key is not the DM peer's.
 *
 * `header.ik` is attacker-controlled: it arrives with the ciphertext and is not
 * authenticated by anything we already trust. Deriving a session from it — as
 * this module used to — lets anyone able to insert a message into the channel
 * (the server operator, or anyone on the delivery path) install a ratchet they
 * control under the real peer's key, then read what the victim sends next and
 * inject messages that render as the peer. The header identity key is therefore
 * only ever a *claim* to be checked against the peer key the caller resolved.
 */
function assertHeaderIdentityIsPeer(headerIk: string, expectedPeerHex: string): void {
  let headerHex: string;
  try {
    headerHex = bytesToHex(fromBase64(headerIk));
  } catch {
    throw new DmE2eeError(
      'PEER_IDENTITY_MISMATCH',
      'Refusing to decrypt DM: message header identity key is malformed',
    );
  }
  if (!expectedPeerHex || headerHex !== expectedPeerHex) {
    throw new DmE2eeError(
      'PEER_IDENTITY_MISMATCH',
      'Refusing to decrypt DM: message claims an identity key that is not this conversation peer',
    );
  }
}

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
  peerUserId?: string | null,
): Promise<MessageE2eePayload> {
  // V1 derives the conversation key straight from the server-supplied peer key,
  // so the pin is the only thing standing between the user and a substituted
  // identity key.
  await assertPinnedDmPeerIdentity(channelId, peerPublicKeyEd25519Hex, peerUserId);
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
  peerUserId?: string | null,
): Promise<string> {
  await assertPinnedDmPeerIdentity(channelId, peerPublicKeyEd25519Hex, peerUserId);
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
 *
 * The bundle is entirely server-controlled, and its signed prekey is verified
 * against the identity key *from the same bundle* (see `x3dh.ts`), so that
 * signature proves nothing about who the peer is: a malicious server can hand
 * out its own identity key with a matching self-signed prekey. The identity key
 * is therefore checked twice before it is used — against the peer key the
 * caller already resolved, and against the pinned key for this user.
 */
async function fetchPeerBundle(
  channelId: string,
  peerUserId: string,
  expectedIdentityHex: string,
): Promise<PrekeyBundle> {
  if (!peerUserId.trim()) {
    throw new DmE2eeError('PEER_ID_REQUIRED', 'Unable to encrypt DM: recipient identity is unavailable');
  }

  let bundle: PrekeyBundle;
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

    bundle = {
      identityKey,
      signedPrekey: {
        id: data.signed_prekey.id,
        publicKey: spkPub,
        signature: spkSig,
      },
      oneTimePrekey,
    };
  } catch (err) {
    throw new DmE2eeError(
      'PEER_BUNDLE_UNAVAILABLE',
      'Unable to encrypt DM: recipient has no usable Signal prekey bundle',
      err,
    );
  }

  // Validation lives outside the try/catch above on purpose: an identity
  // mismatch must never be reported as "bundle unavailable", which callers may
  // treat as a reason to fall back to legacy V1 encryption.
  const bundleIdentityHex = bytesToHex(bundle.identityKey);
  if (bundleIdentityHex !== expectedIdentityHex) {
    throw new DmE2eeError(
      'PEER_IDENTITY_MISMATCH',
      'Refusing to encrypt DM: the prekey bundle identity key does not match the recipient',
    );
  }
  await assertPinnedDmPeerIdentity(channelId, bundleIdentityHex, peerUserId);

  return bundle;
}

function getMyPublicKeyHex(myPrivateKeyEd25519: Uint8Array): string {
  const edPub = ed25519.getPublicKey(myPrivateKeyEd25519);
  return bytesToHex(edPub);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Encrypt a DM message using Signal v2 from an existing session.
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
    if (DM_E2EE_ALLOW_V1_FALLBACK) {
      warnV1Fallback('encryptDmMessage');
      return encryptV1(channelId, plaintext, myPrivateKeyEd25519, peerPublicKeyEd25519Hex);
    }
    throw new DmE2eeError(
      'SESSION_REQUIRED',
      'Unable to encrypt DM: no Signal session exists for this peer',
    );
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
  const expectedPeerHex = normalizeIdentityHex(peerPublicKeyEd25519Hex);

  // Try to load an existing session
  let session = await loadSession(myPubHex, peerPublicKeyEd25519Hex);

  if (!session) {
    // No session — initiate via X3DH
    const bundle = await fetchPeerBundle(channelId, peerUserId, expectedPeerHex).catch((err) => {
      // Only a genuinely missing/unusable bundle may fall back. An identity
      // mismatch or a rotated pin must fail closed — falling back to V1 would
      // encrypt to the substituted key we just rejected.
      if (DM_E2EE_ALLOW_V1_FALLBACK && err instanceof DmE2eeError
        && err.code === 'PEER_BUNDLE_UNAVAILABLE') {
        warnV1Fallback('encryptDmMessageV2:bundle-fetch');
        return null;
      }
      throw err;
    });
    if (!bundle) {
      warnV1Fallback('encryptDmMessageV2:legacy-encrypt');
      return encryptV1(
        channelId,
        plaintext,
        myPrivateKeyEd25519,
        peerPublicKeyEd25519Hex,
        peerUserId,
      );
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
 * The header the sender actually authenticated.
 *
 * `ratchetEncrypt` seals the ciphertext with `JSON.stringify({dh, pn, n})` as
 * AES-GCM additional data; the X3DH fields (`ik`/`ek`/`opk_id`) are attached to
 * the wire header afterwards. Feeding the full wire header back into
 * `ratchetDecrypt` therefore produces different additional data and the tag
 * check fails — which is why the first message of a conversation never
 * decrypted. Rebuild the ratchet header in the sender's field order.
 *
 * The X3DH fields being outside the AAD is not a trust gap: `header.ik` is
 * checked against the pinned peer identity before it is used at all.
 */
function ratchetHeaderOf(header: MessageHeader): MessageHeader {
  return { dh: header.dh, pn: header.pn, n: header.n };
}

/**
 * Derive a responder session from an X3DH initial message and decrypt with it.
 *
 * Nothing is persisted unless the ciphertext actually decrypts. That matters
 * twice over:
 *
 *  - The stored session is only replaced by a message that authenticates under
 *    the derived keys. DH1 = X25519(SPK_b, IK_a) can only be computed by the
 *    holder of the peer's identity private key, and `header.ik` has already
 *    been checked against the pinned peer key, so a successful decrypt proves
 *    the real peer sent this message. A failed decrypt leaves the existing
 *    session untouched — there is no reset oracle.
 *  - A one-time prekey is only burned once the message using it is known to be
 *    genuine. Consuming it eagerly would let anyone posting garbage destroy the
 *    private key the real message needs.
 */
async function decryptViaX3dhResponder(
  channelId: string,
  header: MessageHeader,
  payload: MessageE2eePayload,
  myPrivateKeyEd25519: Uint8Array,
  myPubHex: string,
  peerPublicKeyEd25519Hex: string,
  peerUserId?: string | null,
): Promise<string> {
  await assertPinnedDmPeerIdentity(channelId, peerPublicKeyEd25519Hex, peerUserId);

  const peerEdPub = fromBase64(header.ik!);
  const ephemeralPub = fromBase64(header.ek!);

  const prekeyStore = await loadPrekeyStore();
  if (!prekeyStore) {
    throw new Error('Cannot decrypt X3DH message: no local prekey store');
  }

  let opkPrivate: Uint8Array | null = null;
  let updatedStore: LocalPrekeyStore = prekeyStore;
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

  const candidate: RatchetState = initializeResponder(
    sharedSecret,
    getSignedPrekeyPair(prekeyStore),
  );
  const result = await ratchetDecrypt(
    candidate,
    ratchetHeaderOf(header),
    payload.nonce,
    payload.ciphertext,
  );

  await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);
  if (opkPrivate && updatedStore !== prekeyStore) {
    await savePrekeyStore(updatedStore);
  }
  return result.plaintext;
}

/**
 * Decrypt a DM message. Routes to v1 or v2 based on payload version.
 *
 * @param peerUserId - optional; when the caller knows the peer's user id it is
 *   used to enforce the user-scoped identity pin as well as the channel-scoped
 *   one.
 */
export async function decryptDmMessage(
  channelId: string,
  payload: MessageE2eePayload,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
  peerUserId?: string | null,
): Promise<string> {
  if (payload.version === DM_E2EE_V1 || !payload.header) {
    warnV1Fallback('decryptDmMessage');
    return decryptV1(channelId, payload, myPrivateKeyEd25519, peerPublicKeyEd25519Hex, peerUserId);
  }

  if (payload.version !== DM_E2EE_V2) {
    throw new Error(`Unsupported DM E2EE version: ${payload.version}`);
  }

  const header: MessageHeader = JSON.parse(payload.header);
  const myPubHex = getMyPublicKeyHex(myPrivateKeyEd25519);
  const expectedPeerHex = normalizeIdentityHex(peerPublicKeyEd25519Hex);

  // Check the claimed sender identity before it can influence anything else.
  if (header.ik !== undefined && header.ik !== null) {
    assertHeaderIdentityIsPeer(header.ik, expectedPeerHex);
  }

  const isX3dhInitial = Boolean(header.ik && header.ek);
  const session = await loadSession(myPubHex, peerPublicKeyEd25519Hex);

  if (session) {
    try {
      const result = await ratchetDecrypt(
        session,
        ratchetHeaderOf(header),
        payload.nonce,
        payload.ciphertext,
      );
      await saveSession(myPubHex, peerPublicKeyEd25519Hex, result.state);
      return result.plaintext;
    } catch (err) {
      // A peer that reinstalled starts a brand-new X3DH session, which the
      // current ratchet cannot decrypt. Try that interpretation without
      // touching the stored session; only an authenticated message replaces it.
      if (!isX3dhInitial) throw err;
      try {
        return await decryptViaX3dhResponder(
          channelId,
          header,
          payload,
          myPrivateKeyEd25519,
          myPubHex,
          peerPublicKeyEd25519Hex,
          peerUserId,
        );
      } catch (reinitErr) {
        // A pin failure is the actionable diagnosis; anything else means this
        // simply was not a valid re-initiation, so report the original failure.
        if (reinitErr instanceof IdentityPinError || reinitErr instanceof DmE2eeError) {
          throw reinitErr;
        }
        throw err;
      }
    }
  }

  if (!isX3dhInitial) {
    throw new Error('No session found and message is not an X3DH initial message');
  }

  return decryptViaX3dhResponder(
    channelId,
    header,
    payload,
    myPrivateKeyEd25519,
    myPubHex,
    peerPublicKeyEd25519Hex,
    peerUserId,
  );
}
