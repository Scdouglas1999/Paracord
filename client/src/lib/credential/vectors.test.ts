import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAsync } from '@noble/ed25519';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateRecoveryPhrase } from '../account';
import vectors from './vectors.json';
import { deriveCredentialKeys, deriveMaster, expandMaster, importWrapKey, normalizePassword, scryptSalt, setKdfWorkerFactory } from './derive';
import { fromB64url, fromHex, toB64url, toHex, utf8 } from './encoding';
import { assertKdfPolicy } from './kdfCore';
import { phraseFromPrivateKey, privateKeyFromPhrase, privateKeyFromPhraseFor } from './phrase';
import { credentialProofMessage, PROOF_PURPOSE, signCredentialProof, type ProofPurpose } from './proofs';
import { InlineKdfWorker } from './testWorker';
import { identityAad, sealIdentityWithIv, unwrapIdentity, WRAP_ALG_V2, WRAPPED_KEY_BYTES } from './wrap';

/**
 * Spec §3.14. `vectors.json` comes from `vectors.reference.mjs` (node:crypto
 * only); these tests run the client implementation — the worker protocol,
 * Web Crypto HKDF and AES-GCM, noble Ed25519 — against it byte for byte.
 */

const here = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  InlineKdfWorker.created = [];
  setKdfWorkerFactory(() => new InlineKdfWorker());
});
afterEach(() => setKdfWorkerFactory(null));

describe('credential vectors', () => {
  it('ships one file, byte-identical to the server fixture', () => {
    const client = readFileSync(resolve(here, 'vectors.json'), 'utf8');
    const server = readFileSync(resolve(here, '../../../../crates/paracord-api/tests/fixtures/credential_vectors.json'), 'utf8');
    expect(server).toBe(client);
  });

  it.each(vectors.derivation.map((v) => [v.name, v] as const))('derives %s through the worker', async (_name, v) => {
    expect(toHex(normalizePassword(v.password))).toBe(v.password_utf8_hex);
    const salt = fromB64url(v.salt, 32);
    expect(toHex(salt)).toBe(v.salt_hex);
    expect(toHex(scryptSalt(salt))).toBe(v.scrypt_salt_hex);

    const master = await deriveMaster(v.password, salt, v.kdf);
    expect(toHex(master)).toBe(v.master_hex);
    const { authKey, wrapKeyBytes } = await expandMaster(master);
    expect(toHex(authKey)).toBe(v.auth_key_hex);
    expect(toB64url(authKey)).toBe(v.auth_key);
    expect(toHex(wrapKeyBytes)).toBe(v.wrap_key_hex);

    expect(InlineKdfWorker.created).toHaveLength(1);
    expect(InlineKdfWorker.created[0].terminated).toBe(true);
  });

  it('folds equivalent spellings to the same keys (NFKC)', () => {
    for (const v of vectors.derivation.filter((d) => 'same_as' in d && d.same_as)) {
      const twin = vectors.derivation.find((d) => d.name === (v as { same_as: string }).same_as)!;
      expect(v.password).not.toBe(twin.password);
      expect(v.master_hex).toBe(twin.master_hex);
      expect(toHex(normalizePassword(v.password))).toBe(toHex(normalizePassword(twin.password)));
    }
  });

  it('wraps the identity to the vector for a fixed IV, and unwraps it', async () => {
    const w = vectors.wrap[0];
    const key = await importWrapKey(fromHex(w.wrap_key_hex, 32));
    expect(new TextDecoder().decode(identityAad(w.public_key))).toBe(w.aad);
    const sealed = await sealIdentityWithIv(key, fromHex(w.private_key_hex, 32), w.public_key, fromHex(w.iv_hex, 12));
    expect(sealed).toBe(w.wrapped_key);
    expect(fromB64url(sealed)).toHaveLength(WRAPPED_KEY_BYTES);
    expect(w.wrapped_key_bytes).toBe(WRAPPED_KEY_BYTES);
    expect(vectors.labels.wrap_alg).toBe(WRAP_ALG_V2);

    const opened = await unwrapIdentity(key, w.wrapped_key, w.public_key);
    expect(toHex(opened)).toBe(w.private_key_hex);
  });

  it('opens the register vector end to end from the password', async () => {
    const d = vectors.derivation.find((v) => v.name === vectors.wrap[0].wrap_key_from)!;
    const { authKey, wrapKey } = await deriveCredentialKeys(d.password, fromB64url(vectors.register.credential.salt, 32), vectors.register.credential.kdf);
    expect(authKey).toBe(vectors.register.credential.auth_key);
    const sk = await unwrapIdentity(wrapKey, vectors.register.identity.wrapped_key, vectors.register.identity.public_key);
    expect(toHex(sk)).toBe(vectors.wrap[0].private_key_hex);
    await expect(unwrapIdentity(wrapKey, vectors.register.identity.wrapped_key, vectors.phrase[1].public_key))
      .rejects.toMatchObject({ code: 'unwrap_failed' });
  });

  it.each(vectors.proofs.map((p) => [p.purpose, p] as const))('signs the %s proof byte for byte', async (_purpose, p) => {
    const purpose = p.purpose as ProofPurpose;
    expect(Object.values(PROOF_PURPOSE)).toContain(purpose);
    expect(credentialProofMessage(purpose, p.nonce, p.timestamp, p.origin)).toBe(p.message);
    const proof = await signCredentialProof(
      fromHex(vectors.wrap[0].private_key_hex, 32),
      purpose,
      { nonce: p.nonce, timestamp: p.timestamp, server_origin: p.origin },
      p.origin,
    );
    expect(proof).toEqual({ nonce: p.nonce, timestamp: p.timestamp, signature: p.signature });
    expect(await verifyAsync(fromHex(p.signature, 64), utf8(p.message), fromHex(p.public_key, 32))).toBe(true);
  });

  it('register body carries the register proof', () => {
    expect(vectors.register.identity.proof.signature).toBe(vectors.proofs.find((p) => p.purpose === PROOF_PURPOSE.register)!.signature);
  });

  it.each(vectors.phrase.map((p) => [p.name, p] as const))('maps the %s key to its phrase and back', async (_name, p) => {
    const key = fromHex(p.private_key_hex, 32);
    expect(generateRecoveryPhrase(key)).toBe(p.phrase);
    expect(phraseFromPrivateKey(key)).toBe(p.phrase);
    expect(toHex(privateKeyFromPhrase(p.phrase))).toBe(p.private_key_hex);
    expect(toHex(await privateKeyFromPhraseFor(p.phrase, p.public_key))).toBe(p.private_key_hex);
  });

  it('accepts the "artifact" spelling shown by builds after the spelling sweep', () => {
    const v = vectors.phrase.find((p) => p.name === 'word-103')!;
    expect(v.phrase.split(' ')[0]).toBe('artefact');
    expect(toHex(privateKeyFromPhrase(v.phrase.replace('artefact', 'artifact')))).toBe(v.private_key_hex);
  });

  it('applies the KDF policy cases', () => {
    for (const kdf of vectors.kdf_policy.accept) expect(() => assertKdfPolicy(kdf)).not.toThrow();
    for (const kdf of vectors.kdf_policy.refuse_weaker) expect(() => assertKdfPolicy(kdf)).toThrow(expect.objectContaining({ code: 'weak_kdf' }));
    for (const kdf of vectors.kdf_policy.refuse_heavier) expect(() => assertKdfPolicy(kdf)).toThrow(expect.objectContaining({ code: 'heavy_kdf' }));
  });
});
