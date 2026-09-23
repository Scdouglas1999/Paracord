import { describe, expect, it } from 'vitest';
import { reactionTitle } from './reactionPeople';

describe('reactionTitle', () => {
  it('names one person, two people, and the rest', () => {
    expect(reactionTitle(['Jonas'], 1, '🌙')).toBe('Jonas reacted with 🌙');
    expect(reactionTitle(['Jonas', 'Lena'], 2, '🌙')).toBe('Jonas and Lena reacted with 🌙');
    expect(reactionTitle(['Jonas', 'Lena'], 3, '🌙')).toBe('Jonas, Lena and 1 other reacted with 🌙');
    expect(reactionTitle(['Jonas', 'Lena'], 4, '🌙')).toBe('Jonas, Lena and 2 others reacted with 🌙');
  });

  it('counts people before their names have loaded', () => {
    expect(reactionTitle([], 1, '🌙')).toBe('1 person reacted with 🌙');
    expect(reactionTitle([], 3, '🌙')).toBe('3 people reacted with 🌙');
  });
});
