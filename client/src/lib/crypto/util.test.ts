import { describe, it, expect } from 'vitest';
import { toBase64, fromBase64, toArrayBuffer, bytesToHex, hexToBytes } from './util';

describe('crypto/util', () => {
  describe('toBase64 / fromBase64 round-trip', () => {
    it('round-trips a known byte array', () => {
      const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const b64 = toBase64(original);
      const decoded = fromBase64(b64);
      expect(decoded).toEqual(original);
    });

    it('round-trips an empty array', () => {
      const empty = new Uint8Array(0);
      expect(fromBase64(toBase64(empty))).toEqual(empty);
    });

    it('round-trips 32 random bytes (key-sized)', () => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      expect(fromBase64(toBase64(key))).toEqual(key);
    });

    it('produces standard base64 characters', () => {
      const bytes = new Uint8Array(48); // 48 bytes → 64 base64 chars, no padding
      crypto.getRandomValues(bytes);
      const b64 = toBase64(bytes);
      expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('produces correct base64 for a known input', () => {
      // "Hello" in UTF-8 = [72, 101, 108, 108, 111]
      const hello = new Uint8Array([72, 101, 108, 108, 111]);
      expect(toBase64(hello)).toBe('SGVsbG8=');
    });
  });

  describe('bytesToHex / hexToBytes round-trip', () => {
    it('round-trips a known byte array', () => {
      const original = new Uint8Array([0x00, 0x0f, 0xf0, 0xff, 0xab]);
      const hex = bytesToHex(original);
      expect(hex).toBe('000ff0ffab');
      expect(hexToBytes(hex)).toEqual(original);
    });

    it('round-trips 32 random bytes', () => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      expect(hexToBytes(bytesToHex(key))).toEqual(key);
    });

    it('produces lowercase hex', () => {
      const bytes = new Uint8Array([0xAB, 0xCD, 0xEF]);
      expect(bytesToHex(bytes)).toBe('abcdef');
    });
  });

  describe('toArrayBuffer', () => {
    it('returns an ArrayBuffer from Uint8Array', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const buf = toArrayBuffer(bytes);
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(buf)).toEqual(bytes);
    });
  });
});
