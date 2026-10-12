import { getPublicKeyAsync } from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateRecoveryPhrase } from '../account';
import { BIP39_WORD_ALIASES, wordlist } from '../bip39-wordlist';
import { CredentialError } from './errors';
import { toHex } from './encoding';

/**
 * The recovery phrase (spec §3.6): the identity private key itself, 256 bits
 * + the first 8 bits of its SHA-256 → 24 BIP39 words. Encoding is
 * `account.ts`'s `generateRecoveryPhrase`, unchanged. Parsing lives here
 * without the v1 keystore write `recoverFromPhrase` does, for the v2
 * recover (§3.8) and v1 move (§3.11) flows. The legacy XOR checksum is
 * still accepted, as it is there.
 */

export const phraseFromPrivateKey = (privateKey: Uint8Array): string => generateRecoveryPhrase(privateKey);

export function privateKeyFromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 24) throw new CredentialError('invalid', 'A recovery phrase is exactly 24 words.');
  const bytes = new Uint8Array(33);
  let bits = 0;
  let accumulator = 0;
  let written = 0;
  for (const word of words) {
    const index = wordlist.indexOf(BIP39_WORD_ALIASES[word] ?? word);
    if (index === -1) throw new CredentialError('invalid', `"${word}" isn't a recovery phrase word.`);
    accumulator = ((accumulator << 11) | index) & 0xffffff;
    bits += 11;
    while (bits >= 8) {
      bits -= 8;
      bytes[written++] = (accumulator >> bits) & 0xff;
    }
  }
  const privateKey = bytes.slice(0, 32);
  const checksum = bytes[32];
  let legacy = 0;
  for (const byte of privateKey) legacy ^= byte;
  if (sha256(privateKey)[0] !== checksum && legacy !== checksum) {
    privateKey.fill(0);
    throw new CredentialError('invalid', "That recovery phrase doesn't check out. Look for a mistyped word.");
  }
  return privateKey;
}

/** Parse and check the phrase belongs to `expectedPublicKey` (the account's `public_key`). */
export async function privateKeyFromPhraseFor(phrase: string, expectedPublicKey: string): Promise<Uint8Array> {
  const privateKey = privateKeyFromPhrase(phrase);
  if (toHex(await getPublicKeyAsync(privateKey)) !== expectedPublicKey) {
    privateKey.fill(0);
    throw new CredentialError('identity_mismatch', "That recovery phrase belongs to a different account.");
  }
  return privateKey;
}
