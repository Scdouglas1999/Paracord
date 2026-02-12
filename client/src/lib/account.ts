import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { wordlist } from './bip39-wordlist';

export interface AccountKeystore {
  version: 1;
  publicKey: string;
  encryptedPrivateKey: string;
  salt: string;
  iv: string;
  username: string;
  displayName?: string;
}

export interface UnlockedAccount {
  publicKey: string;
  privateKey: Uint8Array;
  username: string;
  displayName?: string;
}

export const ACCOUNT_STORAGE_KEY = 'paracord:account';

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const AES_IV_BYTES = 12;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : new Uint8Array(bytes).buffer as ArrayBuffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyBytes = await scryptAsync(utf8ToBytes(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
  });
  return crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptPrivateKey(
  privateKey: Uint8Array,
  password: string,
): Promise<{ encrypted: string; salt: string; iv: string }> {
  const salt = randomBytes(32);
  const iv = randomBytes(AES_IV_BYTES);
  const aesKey = await deriveAesKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(privateKey),
  );
  return {
    encrypted: toBase64(new Uint8Array(ciphertext)),
    salt: toBase64(salt),
    iv: toBase64(iv),
  };
}

async function decryptPrivateKey(
  encryptedB64: string,
  saltB64: string,
  ivB64: string,
  password: string,
): Promise<Uint8Array> {
  const salt = fromBase64(saltB64);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(encryptedB64);
  const aesKey = await deriveAesKey(password, salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Incorrect password or corrupted keystore');
  }
}

function storeKeystore(keystore: AccountKeystore): void {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(keystore));
}

export async function createAccount(
  username: string,
  password: string,
  displayName?: string,
): Promise<UnlockedAccount> {
  const privateKey = utils.randomSecretKey();
  const publicKeyBytes = await getPublicKeyAsync(privateKey);
  const publicKey = bytesToHex(publicKeyBytes);

  const { encrypted, salt, iv } = await encryptPrivateKey(privateKey, password);

  const keystore: AccountKeystore = {
    version: 1,
    publicKey,
    encryptedPrivateKey: encrypted,
    salt,
    iv,
    username,
    ...(displayName !== undefined && { displayName }),
  };
  storeKeystore(keystore);

  return {
    publicKey,
    privateKey: new Uint8Array(privateKey),
    username,
    ...(displayName !== undefined && { displayName }),
  };
}

export async function unlockAccount(password: string): Promise<UnlockedAccount> {
  const keystore = getStoredKeystore();
  if (!keystore) {
    throw new Error('No account found in storage');
  }

  const privateKey = await decryptPrivateKey(
    keystore.encryptedPrivateKey,
    keystore.salt,
    keystore.iv,
    password,
  );

  const derivedPubBytes = await getPublicKeyAsync(privateKey);
  const derivedPubHex = bytesToHex(derivedPubBytes);
  if (derivedPubHex !== keystore.publicKey) {
    throw new Error('Decrypted key does not match stored public key');
  }

  return {
    publicKey: keystore.publicKey,
    privateKey,
    username: keystore.username,
    ...(keystore.displayName !== undefined && { displayName: keystore.displayName }),
  };
}

export async function signChallenge(
  privateKey: Uint8Array,
  nonce: string,
  timestamp: number,
  serverOrigin: string,
): Promise<string> {
  const message = utf8ToBytes(nonce + ':' + timestamp.toString() + ':' + serverOrigin);
  const signature = await signAsync(message, privateKey);
  return bytesToHex(signature);
}

export function hasAccount(): boolean {
  return localStorage.getItem(ACCOUNT_STORAGE_KEY) !== null;
}

export function getStoredKeystore(): AccountKeystore | null {
  const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AccountKeystore;
    if (parsed.version !== 1 || !parsed.publicKey || !parsed.encryptedPrivateKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function updateKeystoreProfile(username: string, displayName?: string): void {
  const keystore = getStoredKeystore();
  if (!keystore) {
    throw new Error('No account found in storage');
  }
  keystore.username = username;
  if (displayName !== undefined) {
    keystore.displayName = displayName;
  } else {
    delete keystore.displayName;
  }
  storeKeystore(keystore);
}

export function exportKeystore(): string | null {
  const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  return raw ?? null;
}

export function importKeystore(json: string): void {
  let parsed: AccountKeystore;
  try {
    parsed = JSON.parse(json) as AccountKeystore;
  } catch {
    throw new Error('Invalid keystore JSON');
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.encryptedPrivateKey !== 'string' ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.username !== 'string'
  ) {
    throw new Error('Invalid keystore format');
  }
  storeKeystore(parsed);
}

export function deleteAccount(): void {
  localStorage.removeItem(ACCOUNT_STORAGE_KEY);
}

export function generateRecoveryPhrase(privateKey: Uint8Array): string {
  if (wordlist.length !== 2048) {
    throw new Error('BIP39 wordlist not loaded (expected 2048 words)');
  }
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }

  // 256 bits entropy + 8-bit XOR-fold checksum = 264 bits = 24 x 11-bit word indices
  let checksum = 0;
  for (let i = 0; i < 32; i++) {
    checksum ^= privateKey[i];
  }

  // Build a bit stream: 256 bits from the key + 8 bits checksum = 264 bits
  const allBytes = new Uint8Array(33);
  allBytes.set(privateKey);
  allBytes[32] = checksum;

  const words: string[] = [];
  for (let i = 0; i < 24; i++) {
    const bitOffset = i * 11;
    const byteIndex = bitOffset >> 3;
    const bitIndex = bitOffset & 7;

    // Read 16 bits starting at byteIndex, then extract the 11-bit window
    const val =
      ((allBytes[byteIndex] << 8) |
        (byteIndex + 1 < allBytes.length ? allBytes[byteIndex + 1] : 0)) >>
      (16 - 11 - bitIndex);
    const index = val & 0x7ff;
    words.push(wordlist[index]);
  }

  return words.join(' ');
}

export async function recoverFromPhrase(
  phrase: string,
  username: string,
  password: string,
  displayName?: string,
): Promise<UnlockedAccount> {
  if (wordlist.length !== 2048) {
    throw new Error('BIP39 wordlist not loaded (expected 2048 words)');
  }

  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 24) {
    throw new Error('Recovery phrase must be exactly 24 words');
  }

  // Convert words back to 11-bit indices
  const indices: number[] = [];
  for (const word of words) {
    const idx = wordlist.indexOf(word);
    if (idx === -1) {
      throw new Error(`Unknown word in recovery phrase: "${word}"`);
    }
    indices.push(idx);
  }

  // Reconstruct 264 bits (33 bytes) from 24 x 11-bit indices
  const allBytes = new Uint8Array(33);
  for (let i = 0; i < 24; i++) {
    const bitOffset = i * 11;
    const byteIndex = bitOffset >> 3;
    const bitIndex = bitOffset & 7;
    const val = indices[i];

    // Write 11 bits at the correct position
    allBytes[byteIndex] |= (val >> (11 - (8 - bitIndex))) & 0xff;
    const remaining = 11 - (8 - bitIndex);
    if (remaining > 0 && byteIndex + 1 < allBytes.length) {
      allBytes[byteIndex + 1] |= (val << (8 - remaining)) & 0xff;
      if (remaining > 8 && byteIndex + 2 < allBytes.length) {
        allBytes[byteIndex + 2] |= (val << (16 - remaining)) & 0xff;
      }
    }
  }

  const privateKey = allBytes.slice(0, 32);
  const storedChecksum = allBytes[32];

  // Verify checksum
  let checksum = 0;
  for (let i = 0; i < 32; i++) {
    checksum ^= privateKey[i];
  }
  if (checksum !== storedChecksum) {
    throw new Error('Invalid recovery phrase (checksum mismatch)');
  }

  const publicKeyBytes = await getPublicKeyAsync(privateKey);
  const publicKey = bytesToHex(publicKeyBytes);

  const { encrypted, salt, iv } = await encryptPrivateKey(privateKey, password);

  const keystore: AccountKeystore = {
    version: 1,
    publicKey,
    encryptedPrivateKey: encrypted,
    salt,
    iv,
    username,
    ...(displayName !== undefined && { displayName }),
  };
  storeKeystore(keystore);

  return {
    publicKey,
    privateKey,
    username,
    ...(displayName !== undefined && { displayName }),
  };
}
