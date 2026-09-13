import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { wordlist } from './bip39-wordlist';
import { IDENTITY_KEYSTORE_STORAGE_KEY, readIdentityKeystore, writeIdentityKeystore, updateIdentityKeystore, deleteIdentityKeystore } from './crypto/identityKeystore';
import { toArrayBuffer, toBase64, fromBase64 } from './crypto/util';

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
const ACCOUNT_EXISTS_KEY = 'paracord:account:exists';

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const AES_IV_BYTES = 12;

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyBytes = await scryptAsync(utf8ToBytes(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
  });
  try {
    return await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally { keyBytes.fill(0); }
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

export async function createAccount(
  username: string,
  password: string,
  displayName?: string,
): Promise<UnlockedAccount> {
  const privateKey = utils.randomSecretKey();
  try {
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
    await writeIdentityKeystore(keystore, false);

    return {
      publicKey,
      privateKey: new Uint8Array(privateKey),
      username,
      ...(displayName !== undefined && { displayName }),
    };
  } finally { privateKey.fill(0); }
}

export async function unlockAccount(password: string): Promise<UnlockedAccount> {
  const keystore = await getStoredKeystore();
  if (!keystore) {
    throw new Error('No account found in storage');
  }

  const privateKey = await decryptPrivateKey(
    keystore.encryptedPrivateKey,
    keystore.salt,
    keystore.iv,
    password,
  );
  if (bytesToHex(await getPublicKeyAsync(privateKey)) !== keystore.publicKey.toLowerCase()) {
    privateKey.fill(0);
    throw new Error('The encrypted private key does not match this identity. Restore a valid backup.');
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
  return (
    localStorage.getItem(IDENTITY_KEYSTORE_STORAGE_KEY) !== null ||
    localStorage.getItem(ACCOUNT_EXISTS_KEY) === '1' ||
    localStorage.getItem(ACCOUNT_STORAGE_KEY) !== null
  );
}

export async function getStoredKeystore(): Promise<AccountKeystore | null> {
  return readIdentityKeystore();
}

export async function updateKeystoreProfile(username: string, displayName?: string): Promise<void> {
  await updateIdentityKeystore(keystore => {
    const next = { ...keystore, username };
    if (displayName !== undefined) next.displayName = displayName;
    else delete next.displayName;
    return next;
  });
}

export async function exportKeystore(): Promise<string | null> {
  const keystore = await getStoredKeystore();
  return keystore ? JSON.stringify(keystore) : null;
}

export async function importKeystore(json: string): Promise<void> {
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
  await writeIdentityKeystore(parsed, true);
}

export async function deleteAccount(): Promise<void> {
  await deleteIdentityKeystore();
}

export function generateRecoveryPhrase(privateKey: Uint8Array): string {
  if (wordlist.length !== 2048) {
    throw new Error('BIP39 wordlist not loaded (expected 2048 words)');
  }
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }

  // 256 bits entropy + first 8 bits of SHA-256 checksum = 264 bits.
  const checksum = sha256(privateKey)[0];

  // Build a bit stream: 256 bits from the key + 8 bits checksum = 264 bits
  const allBytes = new Uint8Array(33);
  allBytes.set(privateKey);
  allBytes[32] = checksum;

  // Stream the 264 bits out 11 at a time. A 16-bit read cannot hold an 11-bit
  // window that starts 6 or 7 bits into a byte — the shift it needs goes
  // negative, and JavaScript's `>>` masks its count to 5 bits, so `>> -1`
  // becomes `>> 31` and yields 0. That is a silent, deterministic loss: words
  // 3, 6, 11, 14, 19 and 22 of every phrase came out as wordlist[0]
  // ("abandon"), destroying 66 bits of the key and leaving no generated phrase
  // able to pass its own checksum on recovery. Carrying the bits in an
  // accumulator never shifts by a negative count.
  const words: string[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const byte of allBytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 11) {
      bits -= 11;
      words.push(wordlist[(accumulator >> bits) & 0x7ff]);
    }
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

  // Reconstruct 264 bits (33 bytes) from 24 x 11-bit indices — the exact
  // inverse of the accumulator in `generateRecoveryPhrase`. The byte-at-a-time
  // form this replaces shifted by `8 - remaining`, which goes negative for the
  // six words that start 6 or 7 bits into a byte, and a negative `<<` count is
  // masked to 5 bits and drops the bits entirely.
  const allBytes = new Uint8Array(33);
  let bits = 0;
  let accumulator = 0;
  let written = 0;
  for (const index of indices) {
    accumulator = (accumulator << 11) | index;
    bits += 11;
    while (bits >= 8) {
      bits -= 8;
      allBytes[written++] = (accumulator >> bits) & 0xff;
    }
  }

  const privateKey = allBytes.slice(0, 32);
  const storedChecksum = allBytes[32];

  // Verify checksum.
  // Accept legacy XOR-fold phrases for backward compatibility.
  const strongChecksum = sha256(privateKey)[0];
  if (strongChecksum !== storedChecksum) {
    let legacyChecksum = 0;
    for (let i = 0; i < 32; i++) {
      legacyChecksum ^= privateKey[i];
    }
    if (legacyChecksum !== storedChecksum) {
      throw new Error('Invalid recovery phrase (checksum mismatch)');
    }
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
  await writeIdentityKeystore(keystore, true);

  return {
    publicKey,
    privateKey,
    username,
    ...(displayName !== undefined && { displayName }),
  };
}
