import { describe, expect, it } from 'vitest';

import vectors from '../../lib/credential/vectors.json';
import { fromHex } from '../../lib/credential/encoding';
import type { BackupFile } from '../../stores/firstRunStore';
import { escrowWrappingKey } from './escrow';
import { backupProblem, describeBackup, keyForBackup, phraseWords, RESTORE_COPY, restoreFailure } from './restore';

// The shared vectors (vectors.reference.mjs): the phrase vector's identity is the escrow vector's.
const PHRASE = vectors.phrase[0];
const ESCROW = vectors.escrow[0];

const file = (patch: Partial<BackupFile> = {}): BackupFile => ({
  path: '/home/sam/Backups/paracord_backup_20261003_040000.tar.gz',
  file_name: 'paracord_backup_20261003_040000.tar.gz',
  size_bytes: 4_300_000,
  created_at: '2026-10-03T04:00:00Z',
  server_version: '3.4.0',
  encrypted: true,
  escrow: { instance_id: ESCROW.instance_id, owner_public_key: PHRASE.public_key },
  ...patch,
});

describe('restore from a backup', () => {
  it('unlocks the escrow vector with the phrase vector', async () => {
    expect(ESCROW.private_key_hex).toBe(PHRASE.private_key_hex);
    const key = await keyForBackup(PHRASE.phrase, file());
    expect(escrowWrappingKey(key, ESCROW.instance_id)).toBe(ESCROW.wrapping_key);
    expect(Array.from(key)).toEqual(Array.from(fromHex(PHRASE.private_key_hex)));
  });

  it('accepts the numbered words of the saved file', async () => {
    const numbered = PHRASE.phrase
      .split(' ')
      .map((word, i) => `${i + 1}. ${word}`)
      .join('\n');
    expect(phraseWords(numbered)).toHaveLength(24);
    await expect(keyForBackup(numbered, file())).resolves.toBeInstanceOf(Uint8Array);
  });

  it("names a phrase that isn't the owner's before anything runs", async () => {
    const other = file({ escrow: { instance_id: ESCROW.instance_id, owner_public_key: '00'.repeat(32) } });
    await expect(keyForBackup(PHRASE.phrase, other)).rejects.toThrow(RESTORE_COPY.wrongPhrase);
    await expect(keyForBackup('spot flush pizza', file())).rejects.toThrow('exactly 24 words');
    await expect(keyForBackup(PHRASE.phrase.replace('pizza', 'pizzza'), file())).rejects.toThrow('"pizzza" isn\'t a recovery phrase word.');
  });

  it('refuses a backup no phrase can unlock', () => {
    expect(backupProblem(file())).toBeNull();
    expect(backupProblem(file({ escrow: null }))).toBe(RESTORE_COPY.noEscrow);
    expect(backupProblem(file({ encrypted: false, escrow: null }))).toBe(RESTORE_COPY.notEncrypted);
  });

  it('says when this computer already has data, without a Try again', () => {
    expect(restoreFailure("This computer already has a server database; restoring over it is refused.")).toEqual({ detail: RESTORE_COPY.databaseExists, retry: false });
    expect(restoreFailure("The restore didn't finish: archive digest mismatch")).toEqual({ detail: "The restore didn't finish: archive digest mismatch", retry: true });
  });

  it('describes the file', () => {
    expect(describeBackup(file(), 'en-US')).toBe('Made Oct 3, 2026 · 4.1 MB · Paracord 3.4.0');
  });
});
