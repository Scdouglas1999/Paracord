/**
 * Per-file attachment encryption for end-to-end encrypted conversations.
 *
 * Every attachment gets its own fresh AES-256-GCM key and 96-bit nonce. The key
 * never leaves the device in the clear: it travels inside the Signal-encrypted
 * message body (see `attachmentEnvelope.ts`), so the server only ever sees an
 * opaque blob it cannot name, type or read.
 *
 * The raw key bytes are generated here rather than with `generateKey`, because
 * the envelope has to carry them. The `CryptoKey` derived from them is imported
 * as non-extractable so the only copy that can escape is the one this module
 * deliberately returns; callers wipe it once it is serialized.
 */
import { toArrayBuffer } from '../../crypto/util';

export const ATTACHMENT_KEY_BYTES = 32;
export const ATTACHMENT_NONCE_BYTES = 12;
/** AES-GCM authentication tag, counted against the server's ciphertext ceiling. */
export const ATTACHMENT_TAG_BYTES = 16;

export class AttachmentCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentCryptoError';
  }
}

export interface AttachmentKeyMaterial {
  /** base64 raw AES-256 key */
  readonly key: string;
  /** base64 96-bit GCM nonce */
  readonly nonce: string;
}

/** Chunked base64 so multi-megabyte attachments do not blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))));
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ATTACHMENT_KEY_BYTES) {
    throw new AttachmentCryptoError('An attachment key must be exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedAttachmentBytes {
  readonly material: AttachmentKeyMaterial;
  readonly ciphertext: Uint8Array;
  /** SHA-256 of the *plaintext*, so a recipient can prove what it decrypted. */
  readonly sha256: string;
  readonly size: number;
}

/** Encrypt one file body under a brand-new key. Never reuse a key or a nonce. */
export async function encryptAttachmentBytes(plaintext: Uint8Array): Promise<EncryptedAttachmentBytes> {
  if (plaintext.byteLength === 0) throw new AttachmentCryptoError('An empty file cannot be attached.');
  const raw = crypto.getRandomValues(new Uint8Array(ATTACHMENT_KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(ATTACHMENT_NONCE_BYTES));
  try {
    const key = await importKey(raw);
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(plaintext),
    ));
    return {
      material: { key: bytesToBase64(raw), nonce: bytesToBase64(nonce) },
      ciphertext: sealed,
      sha256: await sha256Hex(plaintext),
      size: plaintext.byteLength,
    };
  } finally { raw.fill(0); }
}

export interface AttachmentIntegrity {
  readonly size: number;
  readonly sha256: string;
}

/**
 * Decrypt one attachment body and prove it is the file the sender described.
 *
 * The GCM tag already proves nobody who lacks the key altered the ciphertext.
 * The plaintext hash and length are checked as well, because they are what the
 * *sender* committed to inside the encrypted message: a server that swapped one
 * of this conversation's own stored objects for another would otherwise produce
 * a body that decrypts under a different attachment's key without anyone
 * noticing. A mismatch is an error, never a rendered "best effort" file.
 */
export async function decryptAttachmentBytes(
  ciphertext: Uint8Array,
  material: AttachmentKeyMaterial,
  expected: AttachmentIntegrity,
): Promise<Uint8Array> {
  let raw: Uint8Array;
  let nonce: Uint8Array;
  try {
    raw = base64ToBytes(material.key);
    nonce = base64ToBytes(material.nonce);
  } catch {
    throw new AttachmentCryptoError('This attachment’s key material is malformed.');
  }
  if (nonce.byteLength !== ATTACHMENT_NONCE_BYTES) {
    throw new AttachmentCryptoError('An attachment nonce must be exactly 12 bytes.');
  }
  let plaintext: Uint8Array;
  try {
    const key = await importKey(raw);
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(ciphertext),
    ));
  } catch (error) {
    if (error instanceof AttachmentCryptoError) throw error;
    throw new AttachmentCryptoError('This attachment failed its authentication check and was not opened.');
  } finally { raw.fill(0); }
  if (plaintext.byteLength !== expected.size) {
    throw new AttachmentCryptoError('This attachment’s length does not match what the sender described.');
  }
  if (await sha256Hex(plaintext) !== expected.sha256.toLowerCase()) {
    throw new AttachmentCryptoError('This attachment’s contents do not match the hash the sender described.');
  }
  return plaintext;
}

/** Opaque stored-object name. Carries no extension, no type and no user text. */
export function opaqueObjectName(): string {
  return `${hex(crypto.getRandomValues(new Uint8Array(16)))}.bin`;
}

export const OPAQUE_CONTENT_TYPE = 'application/octet-stream';
