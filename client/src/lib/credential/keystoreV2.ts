import type { CredentialParams, KdfParams } from '@/api/generated/CredentialParams';
import type { KeyBackup } from '@/api/generated/KeyBackup';
import { CredentialError, DOWNGRADE_MESSAGE, IDENTITY_MISMATCH_MESSAGE } from './errors';
import { fromB64url, fromHex } from './encoding';
import { CREDENTIAL_SALT_BYTES, deriveCredentialKeysFromWire } from './derive';
import { assertKdfPolicy, cleanKdf } from './kdfCore';
import { unwrapIdentity, WRAP_ALG_V2, WRAPPED_KEY_BYTES } from './wrap';

/**
 * Local keystore v2 (spec §3.5) and the per-account downgrade pins (§3.13).
 *
 * The keystore is the same blob as the server's key backup plus where it came
 * from, so unlocking works offline: derive from the password, unwrap. The pin
 * record is separate, versioned, and survives sign-out: it remembers that an
 * account on a server uses one password, the weakest parameters it was seen
 * with, and its identity public key.
 */

export const IDENTITY_KEYSTORE_V2_STORAGE_KEY = 'paracord:encrypted-identity:v2';
export const CREDENTIAL_PINS_STORAGE_KEY = 'paracord:credential-pins:v1';
/** Shared with the v1 keystore (`crypto/identityKeystore.ts`) so v1 → v2 moves serialize with it. */
const KEYSTORE_LOCK = 'paracord:encrypted-identity';
const PINS_LOCK = 'paracord:credential-pins';

export interface AccountKeystoreV2 {
  version: 2;
  /** `new URL(homeServer).origin`. */
  homeOrigin: string;
  userId: string;
  username: string;
  /** Lowercase hex Ed25519 public key. */
  publicKey: string;
  /** b64url(iv12 || AES-256-GCM(...)), `wrap_alg` "aes256gcm-v2". */
  wrappedKey: string;
  kdf: KdfParams;
  /** b64url, 32 bytes. */
  salt: string;
  epoch: number;
}

export interface CredentialPin {
  homeOrigin: string;
  userId: string;
  /** Lowercased names this account signs in with (username, email), for checks before the user id is known. */
  identifiers: string[];
  credentialVersion: 2;
  publicKey: string;
  /** The strongest parameters seen for this account; anything weaker is a downgrade. */
  kdf: KdfParams;
}

interface PinRecord {
  version: 1;
  pins: CredentialPin[];
}

const KEYSTORE_FIELDS = ['version', 'homeOrigin', 'userId', 'username', 'publicKey', 'wrappedKey', 'kdf', 'salt', 'epoch'];
const invalid = (detail: string) => new CredentialError('invalid', `Invalid encrypted identity keystore: ${detail}.`);

export function normalizeHomeOrigin(value: string): string {
  try {
    const origin = new URL(value).origin;
    if (origin === 'null') throw new Error('opaque');
    return origin;
  } catch {
    throw new CredentialError('invalid', `Not a server address: ${value}`);
  }
}

export const normalizeIdentifier = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export function validateKeystoreV2(value: unknown): AccountKeystoreV2 {
  const keystore = value as AccountKeystoreV2;
  if (!keystore || typeof keystore !== 'object' || keystore.version !== 2) throw invalid('not version 2');
  if (Object.keys(keystore).some((field) => !KEYSTORE_FIELDS.includes(field))) throw invalid('unsupported fields');
  if (typeof keystore.homeOrigin !== 'string' || normalizeHomeOrigin(keystore.homeOrigin) !== keystore.homeOrigin) throw invalid('home origin');
  if (typeof keystore.userId !== 'string' || !/^\d+$/.test(keystore.userId)) throw invalid('user id');
  if (typeof keystore.username !== 'string' || keystore.username.length === 0) throw invalid('username');
  fromHex(keystore.publicKey, 32, 'identity public key');
  fromB64url(keystore.wrappedKey, WRAPPED_KEY_BYTES, 'wrapped identity');
  fromB64url(keystore.salt, CREDENTIAL_SALT_BYTES, 'credential salt');
  if (!keystore.kdf || typeof keystore.kdf !== 'object' || Object.keys(keystore.kdf).length !== 4) throw invalid('kdf');
  assertKdfPolicy(keystore.kdf);
  if (!isEpoch(keystore.epoch)) throw invalid('epoch');
  return keystore;
}

async function locked<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  if (!navigator.locks) throw new Error('Encrypted identity storage requires Web Locks in a secure context.');
  return navigator.locks.request(name, { mode: 'exclusive' }, async () => operation());
}

function readKeystoreUnlocked(): AccountKeystoreV2 | null {
  const raw = localStorage.getItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('not JSON');
  }
  return validateKeystoreV2(parsed);
}

/** The device's v2 keystore, or null. A malformed one throws (never treated as absent). */
export const readKeystoreV2 = (): Promise<AccountKeystoreV2 | null> => locked(KEYSTORE_LOCK, readKeystoreUnlocked);

/**
 * Save the keystore. Without `replace`, an existing keystore for a different
 * account or identity is refused; the same account is always updated in place
 * (a newer epoch after a password change elsewhere, §3.5).
 */
export function writeKeystoreV2(keystore: AccountKeystoreV2, options: { replace?: boolean } = {}): Promise<void> {
  const next = validateKeystoreV2({ ...keystore, kdf: cleanKdf(keystore.kdf) });
  return locked(KEYSTORE_LOCK, () => {
    const current = readKeystoreUnlocked();
    if (current && !options.replace && (
      current.homeOrigin !== next.homeOrigin || current.userId !== next.userId || current.publicKey !== next.publicKey
    )) {
      throw new CredentialError('identity_mismatch', 'This device already holds a different identity. Sign out of it first.');
    }
    localStorage.setItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY, JSON.stringify(next));
  });
}

export const deleteKeystoreV2 = (): Promise<void> =>
  locked(KEYSTORE_LOCK, () => localStorage.removeItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY));

/**
 * Build the local keystore from what sign-in fetched: `params` from
 * `/auth/credential/params` and `backup` from `GET /users/@me/key-backup`.
 */
export function keystoreFromBackup(
  account: { homeOrigin: string; userId: string; username: string },
  params: Extract<CredentialParams, { version: 2 }>,
  backup: KeyBackup,
): AccountKeystoreV2 {
  if (backup.wrap_alg !== WRAP_ALG_V2) throw new CredentialError('invalid', `Unsupported key backup format: ${backup.wrap_alg}.`);
  if (backup.epoch !== params.epoch) {
    throw new CredentialError('invalid', 'The password changed while signing in. Sign in again.');
  }
  return validateKeystoreV2({
    version: 2,
    homeOrigin: normalizeHomeOrigin(account.homeOrigin),
    userId: account.userId,
    username: account.username,
    publicKey: backup.public_key,
    wrappedKey: backup.wrapped_key,
    kdf: cleanKdf(params.kdf),
    salt: params.salt,
    epoch: params.epoch,
  });
}

/**
 * Unlock offline: derive from the password with the keystore's own salt and
 * parameters, then unwrap. Throws `unwrap_failed` for a wrong password or a
 * password changed on another device (the caller then asks the server for
 * `params`, §3.5).
 */
export async function unlockKeystoreV2(keystore: AccountKeystoreV2, password: string): Promise<Uint8Array> {
  validateKeystoreV2(keystore);
  const { wrapKey } = await deriveCredentialKeysFromWire(password, keystore.salt, keystore.kdf);
  return unwrapIdentity(wrapKey, keystore.wrappedKey, keystore.publicKey);
}

// ── §3.13 pins ─────────────────────────────────────────────────────────────

function validatePin(pin: CredentialPin): CredentialPin {
  if (!pin || pin.credentialVersion !== 2 || typeof pin.homeOrigin !== 'string' || typeof pin.userId !== 'string'
    || !Array.isArray(pin.identifiers) || pin.identifiers.some((id) => typeof id !== 'string')) {
    throw new CredentialError('invalid', 'Invalid credential pin record.');
  }
  fromHex(pin.publicKey, 32, 'pinned public key');
  assertKdfPolicy(pin.kdf);
  return pin;
}

function readPinsUnlocked(): CredentialPin[] {
  const raw = localStorage.getItem(CREDENTIAL_PINS_STORAGE_KEY);
  if (raw === null) return [];
  let record: PinRecord;
  try {
    record = JSON.parse(raw) as PinRecord;
  } catch {
    throw new CredentialError('invalid', 'Invalid credential pin record.');
  }
  if (!record || record.version !== 1 || !Array.isArray(record.pins)) throw new CredentialError('invalid', 'Invalid credential pin record.');
  return record.pins.map(validatePin);
}

const writePinsUnlocked = (pins: CredentialPin[]) =>
  localStorage.setItem(CREDENTIAL_PINS_STORAGE_KEY, JSON.stringify({ version: 1, pins } satisfies PinRecord));

/**
 * The pin for an account on a home server, by user id (after sign-in) or by
 * the identifier typed into the sign-in form (before it).
 */
export function findCredentialPin(homeOrigin: string, by: { userId: string } | { identifier: string }): CredentialPin | null {
  const origin = normalizeHomeOrigin(homeOrigin);
  const pins = readPinsUnlocked().filter((pin) => pin.homeOrigin === origin);
  if ('userId' in by) return pins.find((pin) => pin.userId === by.userId) ?? null;
  const identifier = normalizeIdentifier(by.identifier);
  return pins.find((pin) => pin.identifiers.includes(identifier)) ?? null;
}

const weaker = (kdf: KdfParams, than: KdfParams) => kdf.log_n < than.log_n || kdf.r < than.r || kdf.p < than.p;
const stronger = (a: KdfParams, b: KdfParams): KdfParams => ({
  alg: a.alg, log_n: Math.max(a.log_n, b.log_n), r: Math.max(a.r, b.r), p: Math.max(a.p, b.p),
});

/**
 * Record (or refresh) the pin after a successful v2 sign-in or unlock. A pin
 * never weakens: parameters only ratchet up, identifiers accumulate. A
 * different public key is refused unless `replaceIdentity` (the "Start over"
 * email reset, §3.9, is the one flow that legitimately makes a new identity).
 */
export function recordCredentialPin(
  input: { homeOrigin: string; userId: string; identifiers: string[]; publicKey: string; kdf: KdfParams },
  options: { replaceIdentity?: boolean } = {},
): Promise<CredentialPin> {
  return locked(PINS_LOCK, () => {
    const homeOrigin = normalizeHomeOrigin(input.homeOrigin);
    assertKdfPolicy(input.kdf);
    fromHex(input.publicKey, 32, 'identity public key');
    const pins = readPinsUnlocked();
    const index = pins.findIndex((pin) => pin.homeOrigin === homeOrigin && pin.userId === input.userId);
    const current = index >= 0 ? pins[index] : null;
    if (current && current.publicKey !== input.publicKey && !options.replaceIdentity) {
      throw new CredentialError('identity_mismatch', IDENTITY_MISMATCH_MESSAGE);
    }
    const identifiers = [...new Set([...(current?.identifiers ?? []), ...input.identifiers.map(normalizeIdentifier)])].filter(Boolean);
    const kdf = cleanKdf(current ? stronger(current.kdf, input.kdf) : input.kdf);
    const pin: CredentialPin = { homeOrigin, userId: input.userId, identifiers, credentialVersion: 2, publicKey: input.publicKey, kdf };
    // An identifier belongs to one account per server: drop it from any other pin.
    const rest = pins
      .filter((_, i) => i !== index)
      .map((other) => other.homeOrigin === homeOrigin
        ? { ...other, identifiers: other.identifiers.filter((id) => !identifiers.includes(id)) }
        : other);
    writePinsUnlocked([...rest, pin]);
    return pin;
  });
}

/** Remove an account's pin (account deleted). Sign-out keeps it on purpose. */
export const forgetCredentialPin = (homeOrigin: string, userId: string): Promise<void> =>
  locked(PINS_LOCK, () => {
    const origin = normalizeHomeOrigin(homeOrigin);
    writePinsUnlocked(readPinsUnlocked().filter((pin) => !(pin.homeOrigin === origin && pin.userId === userId)));
  });

/**
 * Gate on what `/auth/credential/params` answered, before anything is
 * derived or sent. With a pin: `version: 1` or weaker parameters is a
 * downgrade and nothing is sent. Without one: v2 parameters must still meet
 * the floor; `version: 1` is returned for the caller's distinct legacy screen
 * (§3.11).
 */
export function checkCredentialParams(params: CredentialParams, pin: CredentialPin | null): CredentialParams {
  if (params.version === 1) {
    if (pin) throw new CredentialError('downgrade', DOWNGRADE_MESSAGE);
    return params;
  }
  if (params.version !== 2) throw new CredentialError('invalid', 'The server answered with an unknown sign-in version.');
  assertKdfPolicy(params.kdf);
  fromB64url(params.salt, CREDENTIAL_SALT_BYTES, 'credential salt');
  if (!isEpoch(params.epoch)) throw new CredentialError('invalid', 'The server answered with an invalid credential epoch.');
  if (pin && weaker(params.kdf, pin.kdf)) throw new CredentialError('downgrade', DOWNGRADE_MESSAGE);
  return params;
}

/** The identity a server hands back must be the one pinned for the account. */
export function checkPinnedIdentity(publicKey: string, pin: CredentialPin | null): void {
  if (pin && pin.publicKey !== publicKey) throw new CredentialError('identity_mismatch', IDENTITY_MISMATCH_MESSAGE);
}
