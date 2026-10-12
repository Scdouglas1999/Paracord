import { describe, expect, it } from 'vitest';

import vectors from './trustWords.vectors.json';
import { formatTrustWords, TRUST_WORDS_DOMAIN, trustWords, trustWordsText } from './trustWords';

describe('trust words (docs/setup-spec.md §7.1)', () => {
  it('uses the spec domain the vectors were computed with', () => {
    expect(vectors.domain).toBe(TRUST_WORDS_DOMAIN);
  });

  it.each(vectors.vectors)('matches the independent vector for $fingerprint', async ({ fingerprint, words }) => {
    await expect(trustWords(fingerprint)).resolves.toEqual(words);
    await expect(trustWords(fingerprint.toUpperCase())).resolves.toEqual(words);
  });

  it('shows the words joined with a middle dot', async () => {
    const [first] = vectors.vectors;
    expect(formatTrustWords(first.words)).toBe(first.words.join(' · '));
    await expect(trustWordsText(first.fingerprint)).resolves.toBe(first.words.join(' · '));
  });

  it('refuses anything that is not a 32-byte fingerprint', async () => {
    await expect(trustWords('abc')).rejects.toThrow('64 hex digits');
    await expect(trustWords('zz'.repeat(32))).rejects.toThrow('64 hex digits');
  });
});
