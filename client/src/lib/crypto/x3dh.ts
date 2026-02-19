import { x25519 } from '@noble/curves/ed25519.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { x3dhKDF } from './hkdf';
import type { PrekeyBundle, X25519KeyPair } from './types';

/**
 * Generate a fresh X25519 keypair.
 */
export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Convert an Ed25519 private key to an X25519 private key (Montgomery form).
 */
export function ed25519PrivateToX25519(edPriv: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(edPriv);
}

/**
 * Convert an Ed25519 public key to an X25519 public key (Montgomery form).
 */
export function ed25519PublicToX25519(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

export interface X3DHResult {
  sharedSecret: Uint8Array;
  ephemeralPublic: Uint8Array;
  usedOPKId?: number;
}

/**
 * X3DH initiator (Alice → Bob).
 *
 * @param myIdentityPrivateEd25519 - Our Ed25519 identity private key
 * @param peerBundle - Bob's prekey bundle from the server
 * @returns Shared secret + ephemeral public key to include in first message header
 */
export function x3dhInitiate(
  myIdentityPrivateEd25519: Uint8Array,
  peerBundle: PrekeyBundle,
): X3DHResult {
  // Verify the signed prekey's signature using the peer's Ed25519 identity key.
  // The identity key stored on the server is the Ed25519 public key (hex).
  // The signed prekey signature covers the SPK's X25519 public key bytes.
  const spkPubBytes = peerBundle.signedPrekey.publicKey;
  const sigBytes = peerBundle.signedPrekey.signature;

  // The peer's identity key in the bundle is already an Ed25519 public key.
  // We need to reconstruct the raw Ed25519 public from the bundle.
  // Verification: ed25519.verify(sig, message, publicKey)
  const valid = ed25519.verify(sigBytes, spkPubBytes, peerBundle.identityKey);
  if (!valid) {
    throw new Error('X3DH: Signed prekey signature verification failed');
  }

  // Convert identity keys to X25519
  const myIKx = ed25519PrivateToX25519(myIdentityPrivateEd25519);
  const peerIKx = ed25519PublicToX25519(peerBundle.identityKey);
  const spkPub = peerBundle.signedPrekey.publicKey; // Already X25519

  // Generate ephemeral X25519 keypair
  const ek = generateX25519KeyPair();

  // DH1 = X25519(IK_a, SPK_b)
  const dh1 = x25519.getSharedSecret(myIKx, spkPub);
  // DH2 = X25519(EK_a, IK_b)
  const dh2 = x25519.getSharedSecret(ek.privateKey, peerIKx);
  // DH3 = X25519(EK_a, SPK_b)
  const dh3 = x25519.getSharedSecret(ek.privateKey, spkPub);

  let dhConcat: Uint8Array;
  let usedOPKId: number | undefined;

  if (peerBundle.oneTimePrekey) {
    // DH4 = X25519(EK_a, OPK_b)
    const dh4 = x25519.getSharedSecret(ek.privateKey, peerBundle.oneTimePrekey.publicKey);
    dhConcat = concatBytes(dh1, dh2, dh3, dh4);
    usedOPKId = peerBundle.oneTimePrekey.id;
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  const sharedSecret = x3dhKDF(dhConcat);

  return {
    sharedSecret,
    ephemeralPublic: ek.publicKey,
    usedOPKId,
  };
}

/**
 * X3DH responder (Bob receives first message from Alice).
 *
 * @param myIdentityPrivateEd25519 - Our Ed25519 identity private key
 * @param mySpkPrivate - Our signed prekey's X25519 private key
 * @param myOpkPrivate - Our one-time prekey's X25519 private key (if used)
 * @param peerIdentityEd25519 - Alice's Ed25519 identity public key
 * @param ephemeralPublic - Alice's ephemeral X25519 public key from the header
 * @returns The same shared secret that Alice computed
 */
export function x3dhRespond(
  myIdentityPrivateEd25519: Uint8Array,
  mySpkPrivate: Uint8Array,
  myOpkPrivate: Uint8Array | null,
  peerIdentityEd25519: Uint8Array,
  ephemeralPublic: Uint8Array,
): Uint8Array {
  // Convert identity keys to X25519
  const myIKx = ed25519PrivateToX25519(myIdentityPrivateEd25519);
  const peerIKx = ed25519PublicToX25519(peerIdentityEd25519);

  // Mirror DH computations
  // DH1 = X25519(SPK_b, IK_a)
  const dh1 = x25519.getSharedSecret(mySpkPrivate, peerIKx);
  // DH2 = X25519(IK_b, EK_a)
  const dh2 = x25519.getSharedSecret(myIKx, ephemeralPublic);
  // DH3 = X25519(SPK_b, EK_a)
  const dh3 = x25519.getSharedSecret(mySpkPrivate, ephemeralPublic);

  let dhConcat: Uint8Array;

  if (myOpkPrivate) {
    // DH4 = X25519(OPK_b, EK_a)
    const dh4 = x25519.getSharedSecret(myOpkPrivate, ephemeralPublic);
    dhConcat = concatBytes(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  return x3dhKDF(dhConcat);
}
