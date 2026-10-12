import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialParams } from '@/api/generated/CredentialParams';
import vectors from './vectors.json';
import { setKdfWorkerFactory } from './derive';
import { DOWNGRADE_MESSAGE } from './errors';
import { toHex } from './encoding';
import {
  checkCredentialParams, checkPinnedIdentity, CREDENTIAL_PINS_STORAGE_KEY, deleteKeystoreV2, findCredentialPin,
  forgetCredentialPin, IDENTITY_KEYSTORE_V2_STORAGE_KEY, keystoreFromBackup, readKeystoreV2, recordCredentialPin,
  unlockKeystoreV2, writeKeystoreV2, type AccountKeystoreV2,
} from './keystoreV2';
import { InlineKdfWorker, installTestLocks } from './testWorker';

const kdf = { alg: 'scrypt', log_n: 17, r: 8, p: 1 };
const origin = 'https://paracord.example:8443';
const v2Params = { version: 2, kdf, salt: vectors.register.credential.salt, epoch: 3 } as const satisfies CredentialParams;
const backup = {
  public_key: vectors.register.identity.public_key,
  wrapped_key: vectors.register.identity.wrapped_key,
  wrap_alg: 'aes256gcm-v2',
  epoch: 3,
  recovery_confirmed: false,
};
const account = { homeOrigin: 'https://Paracord.Example:8443/some/path', userId: '1234567890', username: 'sam' };

beforeEach(() => {
  localStorage.clear();
  installTestLocks();
  InlineKdfWorker.created = [];
  setKdfWorkerFactory(() => new InlineKdfWorker());
});
afterEach(() => setKdfWorkerFactory(null));

describe('keystore v2', () => {
  it('builds from the server backup and round-trips through storage', async () => {
    const keystore = keystoreFromBackup(account, v2Params, backup);
    expect(keystore).toEqual({
      version: 2, homeOrigin: origin, userId: '1234567890', username: 'sam',
      publicKey: backup.public_key, wrappedKey: backup.wrapped_key, kdf, salt: v2Params.salt, epoch: 3,
    });
    await writeKeystoreV2(keystore);
    expect(JSON.parse(localStorage.getItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY)!)).toEqual(keystore);
    expect(await readKeystoreV2()).toEqual(keystore);
    await deleteKeystoreV2();
    expect(await readKeystoreV2()).toBeNull();
  });

  it('unlocks offline with the password and refuses a wrong one', async () => {
    const keystore = keystoreFromBackup(account, v2Params, backup);
    const password = vectors.derivation.find((d) => d.name === vectors.wrap[0].wrap_key_from)!.password;
    expect(toHex(await unlockKeystoreV2(keystore, password))).toBe(vectors.wrap[0].private_key_hex);
    await expect(unlockKeystoreV2(keystore, password + '!')).rejects.toMatchObject({ code: 'unwrap_failed' });
    expect(InlineKdfWorker.created.every((worker) => worker.terminated)).toBe(true);
  });

  it('refuses a backup from another epoch or format', () => {
    expect(() => keystoreFromBackup(account, v2Params, { ...backup, epoch: 2 })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => keystoreFromBackup(account, v2Params, { ...backup, wrap_alg: 'aes256gcm-v1' })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => keystoreFromBackup(account, v2Params, { ...backup, wrapped_key: backup.wrapped_key.slice(4) })).toThrow();
  });

  it('refuses a malformed stored keystore instead of treating it as absent', async () => {
    const keystore = keystoreFromBackup(account, v2Params, backup);
    for (const broken of [
      { ...keystore, extra: 1 },
      { ...keystore, version: 1 },
      { ...keystore, kdf: { ...kdf, log_n: 16 } },
      { ...keystore, salt: keystore.salt + '=' },
      { ...keystore, publicKey: keystore.publicKey.toUpperCase() },
      { ...keystore, epoch: 0 },
      { ...keystore, homeOrigin: 'https://paracord.example:8443/' },
    ]) {
      localStorage.setItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY, JSON.stringify(broken));
      await expect(readKeystoreV2()).rejects.toThrow();
    }
  });

  it('updates the same account in place but will not silently replace another identity', async () => {
    const keystore = keystoreFromBackup(account, v2Params, backup);
    await writeKeystoreV2(keystore);
    await writeKeystoreV2({ ...keystore, epoch: 4 });
    expect((await readKeystoreV2())!.epoch).toBe(4);
    const other: AccountKeystoreV2 = { ...keystore, userId: '99', publicKey: vectors.phrase[1].public_key };
    await expect(writeKeystoreV2(other)).rejects.toMatchObject({ code: 'identity_mismatch' });
    await writeKeystoreV2(other, { replace: true });
    expect((await readKeystoreV2())!.userId).toBe('99');
  });
});

describe('downgrade pins', () => {
  const pinInput = { homeOrigin: origin, userId: '1234567890', identifiers: ['Sam', 'sam@example.com'], publicKey: backup.public_key, kdf };

  it('finds a pin by identifier before sign-in and by user id after', async () => {
    await recordCredentialPin(pinInput);
    expect(findCredentialPin(`${origin}/`, { identifier: '  SAM ' })?.userId).toBe('1234567890');
    expect(findCredentialPin(origin, { identifier: 'SAM@example.com' })?.userId).toBe('1234567890');
    expect(findCredentialPin(origin, { userId: '1234567890' })?.publicKey).toBe(backup.public_key);
    expect(findCredentialPin('https://other.example', { identifier: 'sam' })).toBeNull();
  });

  it('refuses version 1 or weaker parameters for a pinned account with the spec text', async () => {
    const pin = await recordCredentialPin({ ...pinInput, kdf: { ...kdf, log_n: 18 } });
    expect(() => checkCredentialParams({ version: 1 }, pin)).toThrow(DOWNGRADE_MESSAGE);
    expect(() => checkCredentialParams({ ...v2Params, kdf }, pin)).toThrow(expect.objectContaining({ code: 'downgrade' }));
    expect(checkCredentialParams({ ...v2Params, kdf: { ...kdf, log_n: 18 } }, pin).version).toBe(2);
    expect(checkCredentialParams({ ...v2Params, kdf: { ...kdf, log_n: 19 } }, pin).version).toBe(2);
  });

  it('lets an unpinned account through to the legacy screen but still enforces the floor', () => {
    expect(checkCredentialParams({ version: 1 }, null)).toEqual({ version: 1 });
    expect(() => checkCredentialParams({ ...v2Params, kdf: { ...kdf, log_n: 16 } }, null)).toThrow(expect.objectContaining({ code: 'weak_kdf' }));
    expect(() => checkCredentialParams({ ...v2Params, salt: 'short' }, null)).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => checkCredentialParams({ ...v2Params, epoch: 0 }, null)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('pins never weaken and refuse a swapped identity', async () => {
    await recordCredentialPin({ ...pinInput, kdf: { ...kdf, log_n: 18 } });
    const pin = await recordCredentialPin({ ...pinInput, identifiers: ['samuel'] });
    expect(pin.kdf.log_n).toBe(18);
    expect(pin.identifiers).toEqual(['sam', 'sam@example.com', 'samuel']);
    await expect(recordCredentialPin({ ...pinInput, publicKey: vectors.phrase[1].public_key })).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(() => checkPinnedIdentity(vectors.phrase[1].public_key, pin)).toThrow(expect.objectContaining({ code: 'identity_mismatch' }));
    expect(() => checkPinnedIdentity(backup.public_key, pin)).not.toThrow();
    const replaced = await recordCredentialPin({ ...pinInput, publicKey: vectors.phrase[1].public_key }, { replaceIdentity: true });
    expect(replaced.publicKey).toBe(vectors.phrase[1].public_key);
  });

  it('moves an identifier to the account that now uses it', async () => {
    await recordCredentialPin(pinInput);
    await recordCredentialPin({ ...pinInput, userId: '42', identifiers: ['sam'], publicKey: vectors.phrase[1].public_key });
    expect(findCredentialPin(origin, { identifier: 'sam' })?.userId).toBe('42');
    expect(findCredentialPin(origin, { identifier: 'sam@example.com' })?.userId).toBe('1234567890');
  });

  it('survives deleting the keystore (sign-out) and goes only when forgotten', async () => {
    await recordCredentialPin(pinInput);
    await deleteKeystoreV2();
    expect(findCredentialPin(origin, { userId: '1234567890' })).not.toBeNull();
    await forgetCredentialPin(origin, '1234567890');
    expect(findCredentialPin(origin, { userId: '1234567890' })).toBeNull();
    expect(JSON.parse(localStorage.getItem(CREDENTIAL_PINS_STORAGE_KEY)!)).toEqual({ version: 1, pins: [] });
  });

  it('refuses a corrupted pin record instead of forgetting the pins', () => {
    localStorage.setItem(CREDENTIAL_PINS_STORAGE_KEY, '{"version":1,"pins":[{"credentialVersion":1}]}');
    expect(() => findCredentialPin(origin, { identifier: 'sam' })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
