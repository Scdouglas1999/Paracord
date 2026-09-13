import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { generateRecoveryPhrase } from './account';
import { wordlist } from './bip39-wordlist';

/**
 * The recovery phrase is the ONLY way back to an identity whose device is
 * gone, so the 11-bit packing it rides on is load-bearing: it has to carry all
 * 256 bits of the key plus its checksum and come back byte for byte.
 *
 * The encoder used to read its 11-bit window out of a 16-bit value, which
 * cannot hold a window starting 6 or 7 bits into a byte. The shift that needed
 * went negative, JavaScript masked the count to 5 bits, and the read returned
 * 0 — so words 3, 6, 11, 14, 19 and 22 of EVERY phrase were `wordlist[0]`
 * ("abandon"), 66 bits of the key were destroyed, and no phrase the product
 * ever printed could pass its own checksum on the way back in.
 */

/** The inverse of the shipped packing, written out independently here. */
function unpack(phrase: string): Uint8Array {
  const indices = phrase.split(' ').map((word) => {
    const index = wordlist.indexOf(word);
    if (index === -1) throw new Error(`not a wordlist word: ${word}`);
    return index;
  });
  expect(indices).toHaveLength(24);
  const bytes = new Uint8Array(33);
  let bits = 0;
  let accumulator = 0;
  let written = 0;
  for (const index of indices) {
    accumulator = (accumulator << 11) | index;
    bits += 11;
    while (bits >= 8) {
      bits -= 8;
      bytes[written++] = (accumulator >> bits) & 0xff;
    }
  }
  expect(written).toBe(33);
  return bytes;
}

function key(fill: (i: number) => number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => fill(i) & 0xff);
}

describe('recovery phrase packing', () => {
  it('carries every byte of the key and its checksum back out of the words', () => {
    const keys = [
      key(() => 0xff),
      key(() => 0x00),
      key((i) => i * 7 + 1),
      key((i) => 255 - i * 3),
      ...Array.from({ length: 16 }, () => key(() => Math.floor(Math.random() * 256))),
    ];
    for (const privateKey of keys) {
      const phrase = generateRecoveryPhrase(privateKey);
      expect(phrase.split(' ')).toHaveLength(24);
      const bytes = unpack(phrase);
      expect([...bytes.slice(0, 32)]).toEqual([...privateKey]);
      expect(bytes[32]).toBe(sha256(privateKey)[0]);
    }
  });

  // The signature of the negative-shift bug: six fixed positions collapsing to
  // wordlist[0] no matter what key went in.
  it('does not collapse the words that straddle a byte boundary', () => {
    const phrase = generateRecoveryPhrase(key(() => 0xff)).split(' ');
    for (const position of [3, 6, 11, 14, 19, 22]) {
      expect(phrase[position - 1], `word ${position}`).not.toBe(wordlist[0]);
    }
    // An all-ones key packs to all-ones indices, the last word excepted, which
    // carries the checksum.
    expect(new Set(phrase.slice(0, 23))).toEqual(new Set([wordlist[2047]]));
  });

  it('spreads word indices across the wordlist instead of pinning any position', () => {
    const seen = new Map<number, Set<string>>();
    for (let run = 0; run < 24; run++) {
      const phrase = generateRecoveryPhrase(key(() => Math.floor(Math.random() * 256))).split(' ');
      phrase.forEach((word, position) => {
        const bucket = seen.get(position) ?? new Set<string>();
        bucket.add(word);
        seen.set(position, bucket);
      });
    }
    for (const [position, words] of seen) {
      expect(words.size, `position ${position + 1} never varies`).toBeGreaterThan(1);
    }
  });
});
