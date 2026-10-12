/**
 * Every refusal in the credential library is a `CredentialError` with a
 * stable `code` (for flow logic) and a `message` written for the person
 * (spec §3.2, §3.13). Nothing here degrades silently: a refusal always throws.
 */
export type CredentialErrorCode =
  /** Server-supplied KDF parameters below the floor (§3.2). */
  | 'weak_kdf'
  /** Server-supplied KDF parameters above what this device will run. */
  | 'heavy_kdf'
  /** A pinned account was offered version 1 or weaker parameters (§3.13). */
  | 'downgrade'
  /** The wrap key did not open the wrapped identity: wrong password, or a newer epoch elsewhere (§3.5). */
  | 'unwrap_failed'
  /** The unwrapped key or the backup does not belong to the expected/pinned identity. */
  | 'identity_mismatch'
  /** A malformed value: bad encoding, wrong length, bad keystore shape. */
  | 'invalid'
  /** The background worker could not run or failed. */
  | 'worker_failed'
  /** The challenge was issued for a different server origin. */
  | 'origin_mismatch'
  /** A recovery phrase whose key no account on the server holds. */
  | 'no_account';

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export const isCredentialError = (value: unknown, code?: CredentialErrorCode): value is CredentialError =>
  value instanceof CredentialError && (code === undefined || value.code === code);

/** Recovery with a phrase the server knows no account for (owner decision, M1). */
export const NO_ACCOUNT_FOR_PHRASE_MESSAGE = 'No account on this server uses that recovery phrase.';
/** Spec §3.2. */
export const WEAK_KDF_MESSAGE = 'This server asked for weaker protection than Paracord allows.';
/** Not in the spec's copy table; the ceiling's counterpart of `WEAK_KDF_MESSAGE`. */
export const HEAVY_KDF_MESSAGE = 'This server asked for password settings heavier than Paracord can run on this device.';
/** Spec §3.13. */
export const DOWNGRADE_MESSAGE =
  "This server is asking for an older, weaker sign-in for an account that already uses one password. Paracord won't send it.";
export const UNWRAP_FAILED_MESSAGE = "That password doesn't open your keys.";
export const IDENTITY_MISMATCH_MESSAGE =
  "The keys this server returned don't belong to your account. Paracord won't use them.";
