import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BIP39_WORD_ALIASES, wordlist } from './bip39-wordlist';

// The official BIP39 English list (bitcoin/bips bip-0039/english.txt, one word
// per line, trailing newline) hashes to this. Recovery phrases depend on it.
const OFFICIAL_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';

describe('BIP39 English wordlist', () => {
  it('is byte-for-byte the official list, whatever the house spelling', () => {
    expect(wordlist).toHaveLength(2048);
    expect(wordlist.indexOf('artefact')).toBe(103);
    expect(wordlist).not.toContain('artifact');
    expect(createHash('sha256').update(wordlist.join('\n') + '\n').digest('hex')).toBe(OFFICIAL_SHA256);
  });

  it('maps the spelling some phrases were shown with back to the official word', () => {
    expect(BIP39_WORD_ALIASES.artifact).toBe('artefact');
    for (const official of Object.values(BIP39_WORD_ALIASES)) expect(wordlist).toContain(official);
  });
});
