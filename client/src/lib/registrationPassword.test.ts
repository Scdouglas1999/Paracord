import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  passwordByteLength,
  registrationPasswordError,
} from './registrationPassword';

describe('passwordByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(passwordByteLength('A')).toBe(1);
    expect(passwordByteLength('é')).toBe(2);
    expect(passwordByteLength('𐀀')).toBe(4);
  });
});

describe('registrationPasswordError', () => {
  it('accepts a password meeting every requirement', () => {
    expect(registrationPasswordError('ValidPass1!')).toBeNull();
  });

  it('accepts a space as the non-alphanumeric character', () => {
    expect(registrationPasswordError('Aa1 bcdefg')).toBeNull();
  });

  it('enforces the exact UTF-8 byte minimum', () => {
    expect(registrationPasswordError('Aa1!bcdef')).toMatch(/at least 10 bytes/);
    expect(registrationPasswordError('Aa1!bcdefg')).toBeNull();
    // Eight ASCII characters are also eight bytes.
    expect(registrationPasswordError('Aa1!bcde')).toMatch(/at least 10 bytes/);
    // Seven characters, ten UTF-8 bytes: accepted by the server.
    expect(registrationPasswordError('Aa1!ééé')).toBeNull();
  });

  it('enforces the exact UTF-8 byte maximum', () => {
    const base = 'Aa1!';
    expect(registrationPasswordError(base + 'b'.repeat(124))).toBeNull();
    expect(registrationPasswordError(base + 'b'.repeat(125))).toMatch(/at most 128 bytes/);
  });

  it('measures the limit in bytes even when the string is shorter in characters', () => {
    // 4-byte emoji: 66 UTF-16 code units but 128 bytes — accepted.
    expect(registrationPasswordError('Aa1!' + '😀'.repeat(31))).toBeNull();
    // 68 UTF-16 code units but 132 bytes — rejected.
    expect(registrationPasswordError('Aa1!' + '😀'.repeat(32))).toMatch(/at most 128 bytes/);
  });

  it.each(['\uD800', '\uDC00'])('rejects an incomplete Unicode scalar instead of encoding a different password', surrogate => {
    expect(registrationPasswordError(`ValidPass1!${surrogate}`)).toMatch(/incomplete Unicode/);
  });

  it.each([
    ['an uppercase letter', 'aa1!bcdefg', /uppercase/i],
    ['a lowercase letter', 'AA1!BCDEFG', /lowercase/i],
    ['a digit', 'Aa!!bcdefg', /digit/i],
    ['a symbol or space', 'Aa1bcdefgh', /symbol or space/i],
  ])('rejects a password missing %s', (_label, password, message) => {
    expect(registrationPasswordError(password)).toMatch(message);
  });

  it.each([
    ['É', 'Éa1!bcdefg', /uppercase/i], // U+00C9, not ASCII uppercase
    ['ñ', 'Añ1!BCDEFG', /lowercase/i], // U+00F1, not ASCII lowercase
    ['４', 'Aa４!bcdef', /digit/i], // U+FF14 fullwidth digit
    ['！', 'Aa1！bcdef', /symbol or space/i], // U+FF01 fullwidth exclamation
  ])('does not count Unicode lookalike %s as its ASCII class', (_char, password, message) => {
    expect(registrationPasswordError(password)).toMatch(message);
  });

  it('lists multiple missing classes together', () => {
    expect(registrationPasswordError('aa!!bcdefg')).toBe(
      'Password must include an uppercase letter (A–Z) and a digit (0–9).',
    );
  });

  it('reports the byte count for overlong passwords', () => {
    const message = registrationPasswordError('Aa1!' + 'b'.repeat(200));
    expect(message).toContain(`${PASSWORD_MAX_BYTES}`);
    expect(message).toContain('204');
    expect(PASSWORD_MIN_BYTES).toBe(10);
  });
});
