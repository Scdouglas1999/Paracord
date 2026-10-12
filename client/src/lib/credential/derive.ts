import { sha256 } from '@noble/hashes/sha2.js';
import type { KdfParams } from '@/api/generated/CredentialParams';
import type { NewCredential } from '@/api/generated/CredentialRegister';
import { CredentialError } from './errors';
import { concatBytes, exactBuffer, fromB64url, toB64url, utf8 } from './encoding';
import { assertKdfPolicy, cleanKdf, DEFAULT_KDF, isKdfResponse, MASTER_BYTES, type KdfRequest } from './kdfCore';

/**
 * Spec §3.2:
 *
 *   pw       = UTF-8(NFKC(password))
 *   master   = scrypt(pw, SHA-256("paracord/credential/v2/salt" || salt), N, r, p, 32)
 *   auth_key = HKDF-SHA256(master, salt = empty, "paracord/credential/v2/auth", 32)
 *   wrap_key = HKDF-SHA256(master, salt = empty, "paracord/credential/v2/wrap", 32)
 *
 * scrypt runs in a dedicated worker that is terminated after each use; HKDF
 * runs in Web Crypto. There is no main-thread scrypt path.
 */

export const CREDENTIAL_SALT_BYTES = 32;
export const AUTH_KEY_BYTES = 32;
export const SALT_LABEL = 'paracord/credential/v2/salt';
export const AUTH_INFO = 'paracord/credential/v2/auth';
export const WRAP_INFO = 'paracord/credential/v2/wrap';

/** The subset of `Worker` the derivation uses (tests substitute a fake). */
export interface KdfWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
}
export type KdfWorkerFactory = () => KdfWorkerLike;

const spawnModuleWorker: KdfWorkerFactory = () => {
  if (typeof Worker === 'undefined') {
    throw new CredentialError('worker_failed', "This browser can't run Paracord's password protection (Web Workers are unavailable).");
  }
  return new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module', name: 'paracord-kdf' });
};

let workerFactory: KdfWorkerFactory = spawnModuleWorker;

/** Replace the worker factory (tests); `null` restores the real module worker. */
export function setKdfWorkerFactory(factory: KdfWorkerFactory | null): void {
  workerFactory = factory ?? spawnModuleWorker;
}

/** UTF-8(NFKC(password)) — the only form of the password the derivation sees. */
export const normalizePassword = (password: string): Uint8Array => utf8(password.normalize('NFKC'));

/** SHA-256("paracord/credential/v2/salt" || salt): the salt scrypt actually gets. */
export const scryptSalt = (salt: Uint8Array): Uint8Array => sha256(concatBytes(utf8(SALT_LABEL), salt));

/** scrypt in a fresh worker; the worker is terminated whatever happens. */
export async function deriveMaster(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  assertKdfPolicy(kdf);
  if (salt.length !== CREDENTIAL_SALT_BYTES) throw new CredentialError('invalid', 'The credential salt must be 32 bytes.');
  const pw = normalizePassword(password);
  const request: KdfRequest = {
    type: 'pc-kdf',
    password: exactBuffer(pw),
    salt: exactBuffer(scryptSalt(salt)),
    kdf: cleanKdf(kdf),
  };
  let worker: KdfWorkerLike | null = null;
  try {
    const active = workerFactory();
    worker = active;
    return await new Promise<Uint8Array>((resolve, reject) => {
      active.addEventListener('message', (event: MessageEvent) => {
        const data: unknown = event.data;
        if (!isKdfResponse(data)) return;
        if (data.ok) {
          const master = new Uint8Array(data.master);
          if (master.length !== MASTER_BYTES) reject(new CredentialError('worker_failed', 'The password worker returned a malformed key.'));
          else resolve(master);
        } else {
          const code = data.code === 'weak_kdf' || data.code === 'heavy_kdf' || data.code === 'invalid' ? data.code : 'worker_failed';
          reject(new CredentialError(code, data.message));
        }
      });
      active.addEventListener('error', (event: ErrorEvent) => {
        reject(new CredentialError('worker_failed', `The password worker failed: ${event.message || 'unknown error'}`));
      });
      active.postMessage(request, [request.password, request.salt]);
    });
  } finally {
    worker?.terminate();
    // Once posted, the bytes were transferred (this buffer is detached and
    // empty); zero them only if posting never happened.
    if (pw.buffer.byteLength > 0) pw.fill(0);
  }
}

async function hkdf(master: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', exactBuffer(master), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: exactBuffer(utf8(info)) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Both HKDF outputs as raw bytes. Callers own (and should zero) them. */
export async function expandMaster(master: Uint8Array): Promise<{ authKey: Uint8Array; wrapKeyBytes: Uint8Array }> {
  if (master.length !== MASTER_BYTES) throw new CredentialError('invalid', 'The master key must be 32 bytes.');
  const [authKey, wrapKeyBytes] = await Promise.all([hkdf(master, AUTH_INFO), hkdf(master, WRAP_INFO)]);
  return { authKey, wrapKeyBytes };
}

/** A non-extractable AES-256-GCM key for wrapping the identity. */
export async function importWrapKey(wrapKeyBytes: Uint8Array): Promise<CryptoKey> {
  if (wrapKeyBytes.length !== 32) throw new CredentialError('invalid', 'The wrap key must be 32 bytes.');
  return crypto.subtle.importKey('raw', exactBuffer(wrapKeyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface CredentialKeys {
  /** b64url of the 32-byte auth key: what the server receives. */
  authKey: string;
  /** Never leaves the device and cannot be exported. */
  wrapKey: CryptoKey;
}

/** password + salt + params → the auth key for the server and the local wrap key. */
export async function deriveCredentialKeys(password: string, salt: Uint8Array, kdf: KdfParams): Promise<CredentialKeys> {
  const master = await deriveMaster(password, salt, kdf);
  try {
    const { authKey, wrapKeyBytes } = await expandMaster(master);
    try {
      return { authKey: toB64url(authKey), wrapKey: await importWrapKey(wrapKeyBytes) };
    } finally {
      authKey.fill(0);
      wrapKeyBytes.fill(0);
    }
  } finally {
    master.fill(0);
  }
}

/** Same, from the wire form of the salt (`CredentialParams.salt`, `AccountKeystoreV2.salt`). */
export const deriveCredentialKeysFromWire = (password: string, saltB64url: string, kdf: KdfParams) =>
  deriveCredentialKeys(password, fromB64url(saltB64url, CREDENTIAL_SALT_BYTES, 'credential salt'), kdf);

/** A brand-new credential (sign-up, change, reset): fresh salt, default parameters. */
export async function createCredential(password: string): Promise<{ credential: NewCredential; wrapKey: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(CREDENTIAL_SALT_BYTES));
  const kdf = cleanKdf(DEFAULT_KDF);
  const { authKey, wrapKey } = await deriveCredentialKeys(password, salt, kdf);
  return { credential: { salt: toB64url(salt), kdf, auth_key: authKey }, wrapKey };
}
