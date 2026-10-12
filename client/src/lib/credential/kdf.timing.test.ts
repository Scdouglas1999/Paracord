// @vitest-environment node
import { describe, expect, it } from 'vitest';
import vectors from './vectors.json';
import { fromHex, toHex } from './encoding';
import { DEFAULT_KDF, handleKdfRequest, type KdfResponse } from './kdfCore';

/**
 * Plan §2.1 S1: a jsdom-free run of the worker's own handler at the default
 * parameters (N = 2^17, r = 8, p = 1, 128 MiB), logging how long one
 * derivation takes so regressions in cost are visible in CI output.
 */
describe('scrypt cost', () => {
  it('derives the vector master at the default parameters and logs the time', async () => {
    const v = vectors.derivation[0];
    const password = new TextEncoder().encode(v.password_nfkc);
    const started = performance.now();
    const { response } = await handleKdfRequest({
      type: 'pc-kdf',
      password: password.buffer,
      salt: fromHex(v.scrypt_salt_hex, 32).slice().buffer,
      kdf: DEFAULT_KDF,
    });
    const elapsed = performance.now() - started;
    console.info(`[credential] scrypt N=2^${DEFAULT_KDF.log_n} r=${DEFAULT_KDF.r} p=${DEFAULT_KDF.p}: ${elapsed.toFixed(0)} ms`);
    expect((response as KdfResponse).ok).toBe(true);
    expect(toHex(new Uint8Array((response as Extract<KdfResponse, { ok: true }>).master))).toBe(v.master_hex);
    // The worker zeroes the password it was handed.
    expect(password.every((byte) => byte === 0)).toBe(true);
  });
});
