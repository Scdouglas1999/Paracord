import { describe, expect, it } from 'vitest';
import { assessNewPassword, isCommonPassword, loadCommonPasswords, PASSWORD_HELP, passwordBytes, score } from './password';

/** The prototype's `score()` (output/design-reference/setup/paracord-first-run.html), verbatim, for ASCII parity. */
function prototypeScore(p: string) {
  if (!p) return 0;
  let s = p.length >= 10 ? 1 : 0;
  if (p.length >= 14) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/[\d\W ]/.test(p)) s++;
  return Math.max(1, Math.min(4, s));
}

describe('password meter', () => {
  it('matches the prototype on ASCII', () => {
    for (const p of ['', 'a', 'abcdefghi', 'abcdefghij', 'Abcdefghij', 'abcdefghij1', 'Abcdefghijklmn', 'Abcdefghijklm 4', 'ABCDEFGHIJKLMNOP']) {
      expect(score(p)).toBe(prototypeScore(p));
    }
  });

  it('counts UTF-8 bytes of the NFKC form', () => {
    expect(passwordBytes('café')).toBe(5);
    expect(passwordBytes('café')).toBe(5);
    expect(passwordBytes('ﬁ')).toBe(2);
  });

  it('gives the spec help lines', async () => {
    expect((await assessNewPassword('')).help).toBe(PASSWORD_HELP.empty);
    expect((await assessNewPassword('abcdefg')).help).toBe('3 more characters');
    expect((await assessNewPassword('abcdefghi')).help).toBe('1 more character');
    expect((await assessNewPassword('zebralanternquiet')).help).toBe('Good.');
    expect((await assessNewPassword('zebra lantern quiet')).help).toBe('Strong.');
    expect((await assessNewPassword('Zebra lantern quiet')).help).toBe('Very strong.');
    expect((await assessNewPassword('zebralanter')).help).toBe('Okay. A longer phrase is stronger.');
  });
});

describe('common passwords', () => {
  it('lazy-loads exactly 10,000 entries of 10 or more bytes', async () => {
    const list = await loadCommonPasswords();
    expect(list.size).toBe(10_000);
    for (const entry of list) {
      expect(entry).toBe(entry.toLowerCase());
      expect(passwordBytes(entry)).toBeGreaterThanOrEqual(10);
    }
    expect(await loadCommonPasswords()).toBe(list);
  });

  it('blocks common passwords regardless of case and spacing', async () => {
    expect(await isCommonPassword('qwertyuiop')).toBe(true);
    expect(await isCommonPassword('QwertyUIOP')).toBe(true);
    expect(await isCommonPassword('password 123')).toBe(true);
    expect(await isCommonPassword('zebra lantern quiet')).toBe(false);
    const result = await assessNewPassword('Password123');
    expect(result).toMatchObject({ tooEasy: true, acceptable: false, help: 'That one is too easy to guess.' });
  });

  it('blocks the username or display name', async () => {
    expect(await assessNewPassword('samwise1234', { username: '@SamWise1234' })).toMatchObject({ tooEasy: true, acceptable: false });
    expect(await assessNewPassword('Sam the Brave', { displayName: 'sam the brave' })).toMatchObject({ tooEasy: true });
    expect(await assessNewPassword('zebra lantern quiet', { username: 'sam' })).toMatchObject({ tooEasy: false, acceptable: true });
  });

  it('enforces the length bounds', async () => {
    expect(await assessNewPassword('short')).toMatchObject({ acceptable: false, missing: 5 });
    expect(await assessNewPassword('x'.repeat(129))).toMatchObject({ acceptable: false, tooLong: true });
    expect(await assessNewPassword('é'.repeat(64) + 'a')).toMatchObject({ tooLong: true });
  });
});
