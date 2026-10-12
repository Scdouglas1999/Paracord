import { getPublicKeyAsync } from '@noble/ed25519';
import { CredentialError, IDENTITY_MISMATCH_MESSAGE, UNWRAP_FAILED_MESSAGE } from './errors';
import { concatBytes, exactBuffer, fromB64url, fromHex, toB64url, toHex, utf8 } from './encoding';

/**
 * Spec §3.3 step 3:
 *
 *   wrapped_key = b64url(iv12 || AES-256-GCM(wrap_key, iv, identity_sk,
 *                        aad = "paracord/identity/v2|" + public_key_hex))
 *
 * Unwrapping also proves the result is the private key of `public_key_hex`,
 * so a swapped backup is refused even if it decrypts.
 */

export const WRAP_ALG_V2 = 'aes256gcm-v2';
export const WRAP_IV_BYTES = 12;
export const IDENTITY_KEY_BYTES = 32;
/** 12-byte IV + 32-byte key + 16-byte tag. */
export const WRAPPED_KEY_BYTES = WRAP_IV_BYTES + IDENTITY_KEY_BYTES + 16;
export const IDENTITY_AAD_PREFIX = 'paracord/identity/v2|';

/** The AAD binds the ciphertext to its identity's (lowercase hex) public key. */
export function identityAad(publicKeyHex: string): Uint8Array {
  fromHex(publicKeyHex, 32, 'identity public key');
  return utf8(IDENTITY_AAD_PREFIX + publicKeyHex);
}

/**
 * Seal with a caller-chosen IV. Exists for the test vectors (§3.14); every
 * product path uses `wrapIdentity`, which draws a fresh random IV.
 */
export async function sealIdentityWithIv(
  wrapKey: CryptoKey,
  privateKey: Uint8Array,
  publicKeyHex: string,
  iv: Uint8Array,
): Promise<string> {
  if (privateKey.length !== IDENTITY_KEY_BYTES) throw new CredentialError('invalid', 'The identity private key must be 32 bytes.');
  if (iv.length !== WRAP_IV_BYTES) throw new CredentialError('invalid', 'The wrap IV must be 12 bytes.');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: exactBuffer(iv), additionalData: exactBuffer(identityAad(publicKeyHex)) },
    wrapKey,
    exactBuffer(privateKey),
  );
  return toB64url(concatBytes(iv, new Uint8Array(ciphertext)));
}

/** Wrap the identity private key under the wrap key. */
export async function wrapIdentity(wrapKey: CryptoKey, privateKey: Uint8Array, publicKeyHex: string): Promise<string> {
  const derived = toHex(await getPublicKeyAsync(privateKey));
  if (derived !== publicKeyHex) throw new CredentialError('identity_mismatch', 'The private key does not belong to this public key.');
  return sealIdentityWithIv(wrapKey, privateKey, publicKeyHex, crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES)));
}

/**
 * Unwrap and check. `unwrap_failed` means the key did not open it (wrong
 * password or a newer epoch, §3.5); `identity_mismatch` means it opened but
 * is not the private key of `publicKeyHex`.
 */
export async function unwrapIdentity(wrapKey: CryptoKey, wrappedKey: string, publicKeyHex: string): Promise<Uint8Array> {
  const sealed = fromB64url(wrappedKey, WRAPPED_KEY_BYTES, 'wrapped identity');
  let privateKey: Uint8Array;
  try {
    privateKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: exactBuffer(sealed.subarray(0, WRAP_IV_BYTES)), additionalData: exactBuffer(identityAad(publicKeyHex)) },
      wrapKey,
      exactBuffer(sealed.subarray(WRAP_IV_BYTES)),
    ));
  } catch {
    throw new CredentialError('unwrap_failed', UNWRAP_FAILED_MESSAGE);
  }
  if (toHex(await getPublicKeyAsync(privateKey)) !== publicKeyHex) {
    privateKey.fill(0);
    throw new CredentialError('identity_mismatch', IDENTITY_MISMATCH_MESSAGE);
  }
  return privateKey;
}
