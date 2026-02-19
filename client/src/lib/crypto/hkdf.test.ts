import { describe, it, expect } from 'vitest';
import { x3dhKDF, kdfRK, kdfCK } from './hkdf';

describe('crypto/hkdf', () => {
  describe('x3dhKDF', () => {
    it('produces a 32-byte output', () => {
      const input = crypto.getRandomValues(new Uint8Array(128));
      const result = x3dhKDF(input);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it('is deterministic for the same input', () => {
      const input = new Uint8Array(96);
      input.fill(0x42);
      const r1 = x3dhKDF(input);
      const r2 = x3dhKDF(input);
      expect(r1).toEqual(r2);
    });

    it('produces different outputs for different inputs', () => {
      const a = new Uint8Array(96);
      a.fill(0x01);
      const b = new Uint8Array(96);
      b.fill(0x02);
      const r1 = x3dhKDF(a);
      const r2 = x3dhKDF(b);
      expect(r1).not.toEqual(r2);
    });

    it('does not produce all-zero output', () => {
      const input = crypto.getRandomValues(new Uint8Array(64));
      const result = x3dhKDF(input);
      expect(result.some((b) => b !== 0)).toBe(true);
    });
  });

  describe('kdfRK', () => {
    it('produces rootKey and chainKey each 32 bytes', () => {
      const rk = crypto.getRandomValues(new Uint8Array(32));
      const dhOut = crypto.getRandomValues(new Uint8Array(32));
      const { rootKey, chainKey } = kdfRK(rk, dhOut);
      expect(rootKey.length).toBe(32);
      expect(chainKey.length).toBe(32);
    });

    it('rootKey and chainKey are different', () => {
      const rk = crypto.getRandomValues(new Uint8Array(32));
      const dhOut = crypto.getRandomValues(new Uint8Array(32));
      const { rootKey, chainKey } = kdfRK(rk, dhOut);
      expect(rootKey).not.toEqual(chainKey);
    });

    it('is deterministic', () => {
      const rk = new Uint8Array(32);
      rk.fill(0xAA);
      const dhOut = new Uint8Array(32);
      dhOut.fill(0xBB);
      const r1 = kdfRK(rk, dhOut);
      const r2 = kdfRK(rk, dhOut);
      expect(r1.rootKey).toEqual(r2.rootKey);
      expect(r1.chainKey).toEqual(r2.chainKey);
    });

    it('changes output when root key changes', () => {
      const dhOut = new Uint8Array(32);
      dhOut.fill(0xCC);
      const rk1 = new Uint8Array(32);
      rk1.fill(0x01);
      const rk2 = new Uint8Array(32);
      rk2.fill(0x02);
      const r1 = kdfRK(rk1, dhOut);
      const r2 = kdfRK(rk2, dhOut);
      expect(r1.rootKey).not.toEqual(r2.rootKey);
    });
  });

  describe('kdfCK', () => {
    it('produces chainKey and messageKey each 32 bytes', () => {
      const ck = crypto.getRandomValues(new Uint8Array(32));
      const { chainKey, messageKey } = kdfCK(ck);
      expect(chainKey.length).toBe(32);
      expect(messageKey.length).toBe(32);
    });

    it('chainKey and messageKey are different', () => {
      const ck = crypto.getRandomValues(new Uint8Array(32));
      const { chainKey, messageKey } = kdfCK(ck);
      expect(chainKey).not.toEqual(messageKey);
    });

    it('is deterministic', () => {
      const ck = new Uint8Array(32);
      ck.fill(0xDD);
      const r1 = kdfCK(ck);
      const r2 = kdfCK(ck);
      expect(r1.chainKey).toEqual(r2.chainKey);
      expect(r1.messageKey).toEqual(r2.messageKey);
    });

    it('chain advances produce different message keys', () => {
      const ck0 = crypto.getRandomValues(new Uint8Array(32));
      const step1 = kdfCK(ck0);
      const step2 = kdfCK(step1.chainKey);
      const step3 = kdfCK(step2.chainKey);
      // Each step must produce a unique message key
      expect(step1.messageKey).not.toEqual(step2.messageKey);
      expect(step2.messageKey).not.toEqual(step3.messageKey);
      expect(step1.messageKey).not.toEqual(step3.messageKey);
    });
  });
});
