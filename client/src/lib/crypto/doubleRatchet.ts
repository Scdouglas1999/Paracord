import { x25519 } from '@noble/curves/ed25519.js';
import { kdfRK, kdfCK } from './hkdf';
import { generateX25519KeyPair } from './x3dh';
import { toBase64, fromBase64, toArrayBuffer, bytesToHex } from './util';
import type { RatchetState, MessageHeader, X25519KeyPair } from './types';
import { MAX_SKIP } from './types';

const AES_GCM_NONCE_BYTES = 12;

/**
 * Initialize the ratchet state for the initiator (Alice).
 * Alice has the shared secret from X3DH and the peer's signed prekey as the
 * initial remote DH public key.
 */
export function initializeInitiator(
  sharedSecret: Uint8Array,
  peerSignedPrekey: Uint8Array,
): RatchetState {
  const DHs = generateX25519KeyPair();
  const DHr = peerSignedPrekey;
  const { rootKey, chainKey } = kdfRK(
    sharedSecret,
    x25519.getSharedSecret(DHs.privateKey, DHr),
  );

  return {
    DHs,
    DHr,
    RK: rootKey,
    CKs: chainKey,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

/**
 * Initialize the ratchet state for the responder (Bob).
 * Bob uses his signed prekey pair as the initial DH keypair.
 */
export function initializeResponder(
  sharedSecret: Uint8Array,
  mySignedPrekeyPair: X25519KeyPair,
): RatchetState {
  return {
    DHs: mySignedPrekeyPair,
    DHr: null,
    RK: sharedSecret,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

export interface EncryptResult {
  header: MessageHeader;
  nonce: string;
  ciphertext: string;
  state: RatchetState;
}

/**
 * Encrypt a plaintext message using the Double Ratchet.
 */
export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: string,
): Promise<EncryptResult> {
  if (!state.CKs) {
    throw new Error('Sending chain not initialized');
  }

  const { chainKey, messageKey } = kdfCK(state.CKs);
  const newState: RatchetState = { ...state, CKs: chainKey, Ns: state.Ns + 1 };

  const header: MessageHeader = {
    dh: toBase64(state.DHs.publicKey),
    pn: state.PN,
    n: state.Ns,
  };

  // AES-256-GCM encrypt
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(messageKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const plaintextBytes = new TextEncoder().encode(plaintext);
  // Use the header as associated data for authenticated encryption
  const headerJson = JSON.stringify(header);
  const ciphertextBuf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: new TextEncoder().encode(headerJson),
    },
    key,
    toArrayBuffer(plaintextBytes),
  );

  return {
    header,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertextBuf)),
    state: newState,
  };
}

export interface DecryptResult {
  plaintext: string;
  state: RatchetState;
}

/**
 * Decrypt a ciphertext message using the Double Ratchet.
 */
export async function ratchetDecrypt(
  state: RatchetState,
  header: MessageHeader,
  nonce: string,
  ciphertext: string,
): Promise<DecryptResult> {
  const headerDhPub = fromBase64(header.dh);
  const headerDhHex = bytesToHex(headerDhPub);

  // 1. Try skipped message keys first
  const skipKey = `${headerDhHex}:${header.n}`;
  const skippedMk = state.MKSKIPPED.get(skipKey);
  if (skippedMk) {
    const newSkipped = new Map(state.MKSKIPPED);
    newSkipped.delete(skipKey);
    const plaintext = await decryptWithKey(skippedMk, header, nonce, ciphertext);
    return { plaintext, state: { ...state, MKSKIPPED: newSkipped } };
  }

  let currentState = { ...state, MKSKIPPED: new Map(state.MKSKIPPED) };

  // 2. Check if we need a DH ratchet step
  const currentDHrHex = currentState.DHr ? bytesToHex(currentState.DHr) : null;
  if (headerDhHex !== currentDHrHex) {
    // Skip missed messages from the previous receiving chain
    if (currentState.CKr !== null && currentState.DHr !== null) {
      currentState = skipMessageKeys(currentState, header.pn);
    }

    // DH ratchet step
    currentState.PN = currentState.Ns;
    currentState.Ns = 0;
    currentState.Nr = 0;
    currentState.DHr = headerDhPub;

    const dhOut = x25519.getSharedSecret(currentState.DHs.privateKey, currentState.DHr!);
    const { rootKey, chainKey } = kdfRK(currentState.RK, dhOut);
    currentState.RK = rootKey;
    currentState.CKr = chainKey;

    // Generate new sending keypair
    currentState.DHs = generateX25519KeyPair();
    const dhOut2 = x25519.getSharedSecret(currentState.DHs.privateKey, currentState.DHr!);
    const { rootKey: rk2, chainKey: ck2 } = kdfRK(currentState.RK, dhOut2);
    currentState.RK = rk2;
    currentState.CKs = ck2;
  }

  // 3. Skip any missed messages in the current receiving chain
  currentState = skipMessageKeys(currentState, header.n);

  // 4. Derive the message key
  if (!currentState.CKr) {
    throw new Error('Receiving chain not initialized');
  }
  const { chainKey: newCKr, messageKey: mk } = kdfCK(currentState.CKr);
  currentState.CKr = newCKr;
  currentState.Nr = currentState.Nr + 1;

  // 5. Decrypt
  const plaintext = await decryptWithKey(mk, header, nonce, ciphertext);

  return { plaintext, state: currentState };
}

/**
 * Skip message keys up to the given counter value, caching them in MKSKIPPED.
 */
function skipMessageKeys(state: RatchetState, until: number): RatchetState {
  if (!state.CKr || !state.DHr) return state;

  if (until - state.Nr > MAX_SKIP) {
    throw new Error(`Too many skipped messages (${until - state.Nr} > ${MAX_SKIP})`);
  }

  let ckr = state.CKr;
  const dhHex = bytesToHex(state.DHr);
  const newSkipped = new Map(state.MKSKIPPED);
  let nr = state.Nr;

  while (nr < until) {
    const { chainKey, messageKey } = kdfCK(ckr);
    newSkipped.set(`${dhHex}:${nr}`, messageKey);
    ckr = chainKey;
    nr++;
  }

  return { ...state, CKr: ckr, Nr: nr, MKSKIPPED: newSkipped };
}

/**
 * Decrypt ciphertext with a specific message key.
 */
async function decryptWithKey(
  messageKey: Uint8Array,
  header: MessageHeader,
  nonce: string,
  ciphertext: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(messageKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const nonceBytes = fromBase64(nonce);
  const ciphertextBytes = fromBase64(ciphertext);
  const headerJson = JSON.stringify(header);
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonceBytes),
      additionalData: new TextEncoder().encode(headerJson),
    },
    key,
    toArrayBuffer(ciphertextBytes),
  );
  return new TextDecoder().decode(plainBuf);
}
