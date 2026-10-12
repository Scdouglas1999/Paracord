import { createHash } from 'node:crypto';
import { wordlist } from '../../../src/lib/bip39-wordlist';

/**
 * Spec 7.1, written out again on purpose: the fixture must not share code with
 * `client/src/lib/trustWords.ts`, so a spec can hold the app's words against
 * these.
 *
 *   h     = SHA-256(UTF-8("paracord/trust-words/v1") || fp)
 *   words = BIP39 English[ h bits 0-10 ], [11-21], [22-32], [33-43]   (big-endian)
 *   shown = words joined with " · "
 */
export function trustWords(fingerprintHex: string): string[] {
  const fp = Buffer.from(fingerprintHex, 'hex');
  if (fp.length !== 32) throw new Error(`a fingerprint is 32 bytes, got ${fp.length}`);
  const h = createHash('sha256').update(Buffer.concat([Buffer.from('paracord/trust-words/v1', 'utf8'), fp])).digest();
  let bits = 0n;
  for (const byte of h.subarray(0, 6)) bits = (bits << 8n) | BigInt(byte);
  // 48 bits read; the first 44 are the words.
  bits >>= 4n;
  const out: string[] = [];
  for (let i = 3; i >= 0; i -= 1) out.push(wordlist[Number((bits >> BigInt(i * 11)) & 0x7ffn)]);
  return out;
}

export const showWords = (fingerprintHex: string): string => trustWords(fingerprintHex).join(' · ');
