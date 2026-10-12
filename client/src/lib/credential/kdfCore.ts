import { scryptAsync } from '@noble/hashes/scrypt.js';
import type { KdfParams } from '@/api/generated/CredentialParams';
import { CredentialError, HEAVY_KDF_MESSAGE, WEAK_KDF_MESSAGE } from './errors';

/**
 * The scrypt policy and the worker's message protocol (spec §3.2). Shared by
 * the main thread (`derive.ts`, which refuses before spawning anything) and
 * the worker (`kdf.worker.ts`, which refuses again before allocating).
 */

export const KDF_ALG_SCRYPT = 'scrypt';
/** Floor: N = 2^17, r = 8, p = 1 (128 MiB). Mirrors `paracord-contracts` `SCRYPT_MIN_LOG_N`. */
export const SCRYPT_MIN_LOG_N = 17;
/** Ceiling: N = 2^20. Mirrors `SCRYPT_MAX_LOG_N`. */
export const SCRYPT_MAX_LOG_N = 20;
export const SCRYPT_MIN_R = 8;
export const SCRYPT_MIN_P = 1;
/**
 * N·r·p at most 2^23 — the cost of the ceiling N = 2^20 with r = 8, p = 1
 * (1 GiB, about eight times the default). The contract's `within_policy` has
 * no bound on r or p; without this one a server could ask a device for an
 * unbounded amount of memory or time.
 */
export const SCRYPT_MAX_WORK = 2 ** 23;
export const MASTER_BYTES = 32;

export const DEFAULT_KDF: Readonly<KdfParams> = Object.freeze({
  alg: KDF_ALG_SCRYPT,
  log_n: SCRYPT_MIN_LOG_N,
  r: SCRYPT_MIN_R,
  p: SCRYPT_MIN_P,
});

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/** Throws `weak_kdf` below the floor and `heavy_kdf` above the ceiling. */
export function assertKdfPolicy(kdf: KdfParams): void {
  if (
    !kdf || kdf.alg !== KDF_ALG_SCRYPT
    || !isCount(kdf.log_n) || !isCount(kdf.r) || !isCount(kdf.p)
    || kdf.log_n < SCRYPT_MIN_LOG_N || kdf.r < SCRYPT_MIN_R || kdf.p < SCRYPT_MIN_P
  ) {
    throw new CredentialError('weak_kdf', WEAK_KDF_MESSAGE);
  }
  if (kdf.log_n > SCRYPT_MAX_LOG_N || 2 ** kdf.log_n * kdf.r * kdf.p > SCRYPT_MAX_WORK) {
    throw new CredentialError('heavy_kdf', HEAVY_KDF_MESSAGE);
  }
}

/** `"scrypt:17:8:1"`, the `users.credential_kdf` spelling. */
export const kdfToText = (kdf: KdfParams): string => `${kdf.alg}:${kdf.log_n}:${kdf.r}:${kdf.p}`;

/** Only the four wire fields, in contract order (drops anything extra a server sent). */
export const cleanKdf = (kdf: KdfParams): KdfParams => ({ alg: kdf.alg, log_n: kdf.log_n, r: kdf.r, p: kdf.p });

export interface KdfRequest {
  type: 'pc-kdf';
  /** UTF-8(NFKC(password)); transferred, then zeroed by the worker. */
  password: ArrayBuffer;
  /** SHA-256("paracord/credential/v2/salt" || salt). */
  salt: ArrayBuffer;
  kdf: KdfParams;
}

export type KdfResponse =
  | { type: 'pc-kdf-result'; ok: true; master: ArrayBuffer }
  | { type: 'pc-kdf-result'; ok: false; code: string; message: string };

export function isKdfResponse(value: unknown): value is KdfResponse {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'pc-kdf-result';
}

/** scrypt(password, salt, N, r, p, dkLen = 32) under the policy. */
export async function runScrypt(password: Uint8Array, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  assertKdfPolicy(kdf);
  const N = 2 ** kdf.log_n;
  return scryptAsync(password, salt, {
    N,
    r: kdf.r,
    p: kdf.p,
    dkLen: MASTER_BYTES,
    // noble's own check is blockSize·(N + p); the policy already bounded it.
    maxmem: 128 * kdf.r * (N + kdf.p),
    // The worker has no frames to keep; yield rarely.
    asyncTick: 250,
  });
}

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

/** The worker's whole job, kept here so tests can drive it without a Worker. */
export async function handleKdfRequest(data: unknown): Promise<{ response: KdfResponse; transfer: Transferable[] }> {
  const request = data as Partial<KdfRequest> | null;
  if (!request || request.type !== 'pc-kdf' || !isArrayBuffer(request.password)
    || !isArrayBuffer(request.salt) || !request.kdf) {
    return { response: { type: 'pc-kdf-result', ok: false, code: 'invalid', message: 'Malformed key derivation request.' }, transfer: [] };
  }
  const password = new Uint8Array(request.password as ArrayBuffer);
  try {
    const master = await runScrypt(password, new Uint8Array(request.salt as ArrayBuffer), request.kdf);
    const buffer = master.buffer.byteLength === master.byteLength ? master.buffer as ArrayBuffer : master.slice().buffer as ArrayBuffer;
    return { response: { type: 'pc-kdf-result', ok: true, master: buffer }, transfer: [buffer] };
  } catch (error) {
    const code = error instanceof CredentialError ? error.code : 'worker_failed';
    const message = error instanceof Error ? error.message : String(error);
    return { response: { type: 'pc-kdf-result', ok: false, code, message }, transfer: [] };
  } finally {
    password.fill(0);
  }
}
