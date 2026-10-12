import { wordlist } from './bip39-wordlist';

/**
 * A server's identity as four words a person can compare with a friend
 * (docs/setup-spec.md §7.1). The one implementation: Rust only exposes
 * fingerprints.
 *
 *   fp    = SHA-256(leaf certificate DER)            the pin, 32 bytes
 *   h     = SHA-256(UTF-8("paracord/trust-words/v1") || fp)
 *   words = BIP39 English[h bits 0-10], [11-21], [22-32], [33-43]   (big-endian)
 *
 * 44 bits are for a person comparing words; the pin itself is the full 256-bit
 * fingerprint (§10).
 */

export const TRUST_WORDS_DOMAIN = 'paracord/trust-words/v1';

/** What joins the words when they are shown. */
export const TRUST_WORDS_SEPARATOR = ' · ';

const FINGERPRINT_HEX = /^[0-9a-f]{64}$/i;

function fingerprintBytes(fingerprintHex: string): Uint8Array {
  const hex = fingerprintHex.trim();
  if (!FINGERPRINT_HEX.test(hex)) {
    throw new Error('A server fingerprint is 64 hex digits.');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The four words for a fingerprint (lowercase hex SHA-256 of the leaf certificate, as Rust reports it). */
export async function trustWords(fingerprintHex: string): Promise<string[]> {
  const fp = fingerprintBytes(fingerprintHex);
  const domain = new TextEncoder().encode(TRUST_WORDS_DOMAIN);
  const input = new Uint8Array(domain.length + fp.length);
  input.set(domain, 0);
  input.set(fp, domain.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  // The first 48 bits as one number (exact in a double: below 2^53).
  let bits = 0;
  for (let i = 0; i < 6; i += 1) bits = bits * 256 + h[i];
  const words: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const index = Math.floor(bits / 2 ** (48 - 11 * (i + 1))) % 2048;
    words.push(wordlist[index]);
  }
  return words;
}

/** The words as shown: "ember · quarry · lantern · osprey". */
export function formatTrustWords(words: readonly string[]): string {
  return words.join(TRUST_WORDS_SEPARATOR);
}

/** `formatTrustWords(await trustWords(fp))`. */
export async function trustWordsText(fingerprintHex: string): Promise<string> {
  return formatTrustWords(await trustWords(fingerprintHex));
}
