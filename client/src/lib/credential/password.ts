/**
 * Password rules and the strength meter for the one password (spec §1.6,
 * §3.4). The server cannot see the password any more, so these rules are
 * enforced here (`PasswordRequirements.enforced_by: "client"`).
 *
 * Lengths count UTF-8 bytes of the NFKC form — what the KDF hashes and what
 * the server's requirements call `length_unit: "utf8_bytes"`. For ASCII that
 * is the character count the prototype's `score()` used.
 *
 * `common-passwords.txt` is the 10,000 most frequent passwords of 10 to 128
 * characters from SecLists' `xato-net-10-million-passwords-1000000.txt`
 * (MIT license), lowercased, printable ASCII, in frequency order. Shorter
 * entries are left out because the 10-byte minimum already refuses them.
 * It is loaded only when first needed.
 */

export const PASSWORD_MIN_BYTES = 10;
export const PASSWORD_MAX_BYTES = 128;
const STRONG_BYTES = 14;

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export const passwordBytes = (password: string): number => new TextEncoder().encode(password.normalize('NFKC')).length;

/** The prototype's meter: 0 when empty, otherwise 1..4. */
export function score(password: string): PasswordScore {
  if (!password) return 0;
  const bytes = passwordBytes(password);
  let points = 0;
  if (bytes >= PASSWORD_MIN_BYTES) points += 1;
  if (bytes >= STRONG_BYTES) points += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) points += 1;
  if (/[\d\W ]/.test(password)) points += 1;
  return Math.max(1, Math.min(4, points)) as PasswordScore;
}

export const PASSWORD_HELP = {
  empty: "Use a phrase you'll remember, like three or four unrelated words.",
  tooEasy: 'That one is too easy to guess.',
  tooLong: `Use at most ${PASSWORD_MAX_BYTES} characters.`,
  byScore: ['Okay. A longer phrase is stronger.', 'Good.', 'Strong.', 'Very strong.'] as const,
  more: (n: number) => `${n} more character${n === 1 ? '' : 's'}`,
};

let commonPasswords: Promise<ReadonlySet<string>> | null = null;

/** The bundled list, fetched once on first use (a separate chunk). */
export function loadCommonPasswords(): Promise<ReadonlySet<string>> {
  commonPasswords ??= import('./common-passwords.txt?raw')
    .then(({ default: text }) => new Set(text.split('\n').filter(Boolean)) as ReadonlySet<string>)
    .catch((error: unknown) => {
      commonPasswords = null;
      throw error;
    });
  return commonPasswords;
}

const fold = (value: string) => value.normalize('NFKC').trim().toLowerCase();

/** In the common list, compared case-insensitively and with or without spaces. */
export async function isCommonPassword(password: string): Promise<boolean> {
  const list = await loadCommonPasswords();
  const folded = fold(password);
  return list.has(folded) || list.has(folded.replace(/\s+/g, ''));
}

export interface PasswordAssessment {
  score: PasswordScore;
  bytes: number;
  /** Bytes still missing to reach the minimum (0 when long enough). */
  missing: number;
  tooLong: boolean;
  /** In the common list, or the same as the username or display name. */
  tooEasy: boolean;
  /** Continue may be enabled (the password half of §1.6's rule). */
  acceptable: boolean;
  /** The help line under the field. */
  help: string;
}

/**
 * Everything the Account step needs for a new password. `tooEasy` blocks
 * Continue like a short password does.
 */
export async function assessNewPassword(
  password: string,
  names: { username?: string; displayName?: string } = {},
): Promise<PasswordAssessment> {
  const bytes = passwordBytes(password);
  const missing = Math.max(0, PASSWORD_MIN_BYTES - bytes);
  const tooLong = bytes > PASSWORD_MAX_BYTES;
  const folded = fold(password);
  const sameAsName = folded.length > 0 && [names.username, names.displayName]
    .some((name) => typeof name === 'string' && fold(name.replace(/^@/, '')) === folded);
  const tooEasy = password.length > 0 && missing === 0 && (sameAsName || await isCommonPassword(password));
  const s = score(password);
  let help: string;
  if (!password) help = PASSWORD_HELP.empty;
  else if (missing > 0) help = PASSWORD_HELP.more(missing);
  else if (tooLong) help = PASSWORD_HELP.tooLong;
  else if (tooEasy) help = PASSWORD_HELP.tooEasy;
  else help = PASSWORD_HELP.byScore[s - 1];
  return { score: s, bytes, missing, tooLong, tooEasy, acceptable: missing === 0 && !tooLong && !tooEasy, help };
}
