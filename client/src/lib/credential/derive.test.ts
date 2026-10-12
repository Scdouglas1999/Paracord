import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCredential, deriveCredentialKeys, deriveMaster, setKdfWorkerFactory } from './derive';
import { fromB64url } from './encoding';
import { DEFAULT_KDF, type KdfRequest } from './kdfCore';
import { InlineKdfWorker } from './testWorker';

/**
 * The worker's lifecycle (plan §2.1 S1): one worker per derivation, always
 * terminated — after a result, after a refusal and after a crash — so the
 * 128 MiB scrypt buffer is returned. These use a canned answer instead of
 * scrypt; `vectors.test.ts` runs the real one.
 */

const salt = new Uint8Array(32).fill(7);
const canned = (master = new Uint8Array(32).fill(9)) => () =>
  new InlineKdfWorker(() => ({ type: 'pc-kdf-result', ok: true, master: master.slice().buffer }));

beforeEach(() => { InlineKdfWorker.created = []; });
afterEach(() => setKdfWorkerFactory(null));

describe('deriveMaster worker lifecycle', () => {
  it('terminates the worker after a result', async () => {
    setKdfWorkerFactory(canned());
    const master = await deriveMaster('correct horse battery staple', salt, DEFAULT_KDF);
    expect(master).toEqual(new Uint8Array(32).fill(9));
    expect(InlineKdfWorker.created).toHaveLength(1);
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('terminates the worker after a refusal from inside it', async () => {
    setKdfWorkerFactory(() => new InlineKdfWorker(() => ({ type: 'pc-kdf-result', ok: false, code: 'weak_kdf', message: 'nope' })));
    await expect(deriveMaster('pw', salt, DEFAULT_KDF)).rejects.toMatchObject({ code: 'weak_kdf' });
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('terminates the worker after it crashes', async () => {
    setKdfWorkerFactory(() => new InlineKdfWorker('error'));
    await expect(deriveMaster('pw', salt, DEFAULT_KDF)).rejects.toMatchObject({ code: 'worker_failed' });
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('refuses a malformed answer', async () => {
    setKdfWorkerFactory(canned(new Uint8Array(16)));
    await expect(deriveMaster('pw', salt, DEFAULT_KDF)).rejects.toMatchObject({ code: 'worker_failed' });
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('refuses weak or heavy parameters before spawning anything', async () => {
    const factory = vi.fn(canned());
    setKdfWorkerFactory(factory);
    await expect(deriveMaster('pw', salt, { ...DEFAULT_KDF, log_n: 16 })).rejects.toMatchObject({
      code: 'weak_kdf', message: 'This server asked for weaker protection than Paracord allows.',
    });
    await expect(deriveMaster('pw', salt, { ...DEFAULT_KDF, log_n: 21 })).rejects.toMatchObject({ code: 'heavy_kdf' });
    await expect(deriveMaster('pw', salt, { ...DEFAULT_KDF, alg: 'pbkdf2' })).rejects.toMatchObject({ code: 'weak_kdf' });
    await expect(deriveMaster('pw', new Uint8Array(16), DEFAULT_KDF)).rejects.toMatchObject({ code: 'invalid' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('sends the worker the normalized password and hashed salt, transferred', async () => {
    let seen: KdfRequest | null = null;
    setKdfWorkerFactory(() => new InlineKdfWorker((data) => {
      seen = data as KdfRequest;
      return { type: 'pc-kdf-result', ok: true, master: new Uint8Array(32).buffer };
    }));
    await deriveMaster('ﬁ', salt, DEFAULT_KDF);
    expect(new TextDecoder().decode(seen!.password)).toBe('fi');
    expect(seen!.salt.byteLength).toBe(32);
    expect(seen!.kdf).toEqual({ alg: 'scrypt', log_n: 17, r: 8, p: 1 });
    // Both buffers move to the worker; no copy of the password stays behind.
    expect(InlineKdfWorker.created[0].transferred).toHaveLength(2);
  });

  it('fails loudly without Web Workers instead of running scrypt on the main thread', async () => {
    setKdfWorkerFactory(null);
    vi.stubGlobal('Worker', undefined);
    try {
      await expect(deriveMaster('pw', salt, DEFAULT_KDF)).rejects.toMatchObject({ code: 'worker_failed' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('credential keys', () => {
  it('gives a b64url auth key and a wrap key that cannot be exported', async () => {
    setKdfWorkerFactory(canned());
    const { authKey, wrapKey } = await deriveCredentialKeys('pw', salt, DEFAULT_KDF);
    expect(fromB64url(authKey, 32)).toHaveLength(32);
    expect(wrapKey.extractable).toBe(false);
    expect(wrapKey.algorithm.name).toBe('AES-GCM');
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('creates a credential with a fresh salt and the default parameters', async () => {
    setKdfWorkerFactory(canned());
    const a = await createCredential('correct horse battery staple');
    const b = await createCredential('correct horse battery staple');
    expect(a.credential.kdf).toEqual({ alg: 'scrypt', log_n: 17, r: 8, p: 1 });
    expect(fromB64url(a.credential.salt, 32)).toHaveLength(32);
    expect(a.credential.salt).not.toBe(b.credential.salt);
    expect(Object.keys(a.credential).sort()).toEqual(['auth_key', 'kdf', 'salt']);
  });
});
