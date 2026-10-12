import { getPublicKeyAsync } from '@noble/ed25519';

import { toHex } from '../../lib/credential/encoding';
import { CredentialError } from '../../lib/credential/errors';
import { privateKeyFromPhrase } from '../../lib/credential/phrase';
import type { BackupFile, SetupRow } from '../../stores/firstRunStore';

/**
 * "Restore from a backup instead" (docs/setup-spec.md §1.4, §4.8): what is
 * checked on this computer before anything runs, and the words for it.
 *
 * A backup the desktop host made carries `key_escrow`: the storage key sealed
 * under a key derived from the owner's recovery phrase and the instance id
 * (§4.7), plus the owner's public key. So the phrase is checked here, against
 * that public key, before Paracord installs anything: a wrong phrase is named
 * as such, not reported later as a restore that didn't finish.
 */

export const RESTORE_COPY = {
  title: 'Restore from a backup',
  sub: 'Paracord puts your server back on this computer from a backup file. Your recovery phrase unlocks it.',
  pick: 'Choose a backup file',
  pickHelp: "Paracord's backups end in .tar.gz. They're in the backups folder of the computer that ran the server.",
  phraseLabel: 'Recovery phrase',
  phraseHelp: 'The 24 words you saved when you set up the server.',
  notEncrypted:
    "This backup isn't encrypted, so a recovery phrase has nothing to unlock and Paracord on this computer can't restore it. Restore it with the server's restore-backup command instead.",
  noEscrow:
    "This backup was made before your recovery phrase protected its storage key, so no phrase can unlock it. Choose a newer backup.",
  wrongPhrase: "That recovery phrase doesn't unlock this backup. It needs the phrase of the account that set up the server.",
  databaseExists: "This computer already has a Paracord server's data, and Paracord never restores over it.",
  setupTitle: 'Restoring your server',
  row: 'Restoring from your backup',
  rowPending: 'Unlocking its storage key with your recovery phrase and checking everything in it.',
  escrowTitle: 'Protecting its key with your recovery phrase',
  escrowPending: 'So the same phrase can restore it again.',
  signInSub: 'Your server is back. Sign in with your username and password.',
} as const;

/** The restore row is numbered 0: it comes before the host rows 1-5 (§1.7). */
export const RESTORE_ROW = 0;

export function restoreRow(state: SetupRow['state'], detail?: string, chips?: SetupRow['chips']): SetupRow {
  return { row: RESTORE_ROW, title: RESTORE_COPY.row, pending: RESTORE_COPY.rowPending, state, detail, chips };
}

/** Why a picked backup can't be restored with a phrase, or null. */
export function backupProblem(file: BackupFile): string | null {
  if (!file.encrypted) return RESTORE_COPY.notEncrypted;
  if (!file.escrow) return RESTORE_COPY.noEscrow;
  return null;
}

/** "Made Oct 3, 2026 · 4.1 MB · Paracord 3.4.0". */
export function describeBackup(file: BackupFile, locale?: string): string {
  const made = new Date(file.created_at);
  const date = Number.isNaN(made.getTime()) ? file.created_at : made.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  return `Made ${date} · ${formatSize(file.size_bytes)} · Paracord ${file.server_version}`;
}

export function backupDate(file: BackupFile, locale?: string): string {
  const made = new Date(file.created_at);
  return Number.isNaN(made.getTime()) ? file.created_at : made.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Words typed so far, for enabling Restore (numbering from the saved file is ignored). */
export function phraseWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^\d+[.)]?$/.test(token));
}

/**
 * The phrase's identity private key, checked against the backup's owner.
 * The caller zeroes it. Rejects with a sentence for under the phrase field.
 */
export async function keyForBackup(phrase: string, file: BackupFile): Promise<Uint8Array> {
  const owner = file.escrow?.owner_public_key;
  if (!owner) throw new CredentialError('invalid', backupProblem(file) ?? RESTORE_COPY.noEscrow);
  const privateKey = privateKeyFromPhrase(phraseWords(phrase).join(' '));
  try {
    if (toHex(await getPublicKeyAsync(privateKey)) !== owner.toLowerCase()) {
      throw new CredentialError('identity_mismatch', RESTORE_COPY.wrongPhrase);
    }
    return privateKey;
  } catch (error) {
    privateKey.fill(0);
    throw error;
  }
}

/** A failed `host_restore`, in the restore row's words. */
export function restoreFailure(message: string): { detail: string; retry: boolean } {
  if (message.includes('already has a server database')) return { detail: RESTORE_COPY.databaseExists, retry: false };
  return { detail: message, retry: true };
}
