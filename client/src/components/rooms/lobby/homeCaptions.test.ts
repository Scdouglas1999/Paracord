import { describe, expect, it } from 'vitest';

import { joinedLine, namesLine, presenceLine, repliesLine, shortAgo } from './homeCaptions';

describe('home captions', () => {
  it('counts who is online among the members', () => {
    expect(presenceLine(8, 10)).toBe('10 members · 8 here now');
    expect(presenceLine(1, 1)).toBe('1 member · 1 here now');
    expect(presenceLine(0, 1)).toBe('1 member');
  });

  it('names people briefly', () => {
    expect(namesLine(['Priya'])).toBe('Priya');
    expect(namesLine(['Priya', 'Ren'])).toBe('Priya and Ren');
    expect(namesLine(['Priya', 'Ren', 'Mara', 'Ken'])).toBe('Priya, Ren and 2 others');
  });

  it('groups new members into one line', () => {
    expect(joinedLine(['Yara'], 1)).toBe('Yara joined');
    expect(joinedLine(['Yara', 'Ken'], 2)).toBe('Yara and Ken joined');
    expect(joinedLine(['Yara', 'Ken', 'Lena'], 3)).toBe('Yara and 2 others joined');
    expect(joinedLine(['Yara'], 14)).toBe('Yara and 13 others joined');
  });

  it('counts replies', () => {
    expect(repliesLine(0)).toBe('No replies yet');
    expect(repliesLine(1)).toBe('1 reply');
    expect(repliesLine(12)).toBe('12 replies');
  });

  it('stamps a card briefly', () => {
    const now = Date.parse('2026-09-22T18:00:00Z');
    expect(shortAgo('2026-09-22T17:59:40Z', now)).toBe('now');
    expect(shortAgo('2026-09-22T17:48:00Z', now)).toBe('12m');
    expect(shortAgo('2026-09-22T15:00:00Z', now)).toBe('3h');
    expect(shortAgo('not a date', now)).toBe('');
    expect(shortAgo(null, now)).toBe('');
  });

  it('never uses the retired light words', () => {
    const lines = [
      presenceLine(3, 9),
      joinedLine(['Ada', 'Bo'], 2),
    ].join(' ');
    expect(lines).not.toMatch(/lights on|reading|\blit\b|dark/i);
  });
});
