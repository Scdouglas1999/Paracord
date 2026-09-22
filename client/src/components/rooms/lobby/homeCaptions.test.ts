import { describe, expect, it } from 'vitest';

import { callLength, joinedLine, namesLine, presenceLine, repliesLine, shortAgo, voiceLine } from './homeCaptions';

describe('home captions', () => {
  it('counts who is online among the members', () => {
    expect(presenceLine(8, 10)).toBe('8 online · 10 members');
    expect(presenceLine(0, 1)).toBe('1 member');
  });

  it('names people briefly', () => {
    expect(namesLine(['Priya'])).toBe('Priya');
    expect(namesLine(['Priya', 'Ren'])).toBe('Priya and Ren');
    expect(namesLine(['Priya', 'Ren', 'Mara', 'Ken'])).toBe('Priya, Ren and 2 others');
  });

  it('says how long a call has been going', () => {
    expect(callLength(null)).toBeNull();
    expect(callLength(20_000)).toBe('just started');
    expect(callLength(42 * 60_000)).toBe('42 min');
    expect(callLength(65 * 60_000)).toBe('1 h 5 min');
    expect(callLength(120 * 60_000)).toBe('2 h');
  });

  it('says who is talking in a live call, or how many are in it', () => {
    expect(voiceLine(['Priya'], 3, 42 * 60_000)).toBe('Priya is talking · 42 min');
    expect(voiceLine(['Priya', 'Ren'], 3, null)).toBe('Priya and Ren are talking');
    expect(voiceLine([], 1, 5 * 60_000)).toBe('1 person in voice · 5 min');
    expect(voiceLine([], 4, null)).toBe('4 people in voice');
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
      voiceLine([], 2, 60_000),
      voiceLine(['Ada'], 2, null),
      joinedLine(['Ada', 'Bo'], 2),
    ].join(' ');
    expect(lines).not.toMatch(/lights on|reading|\blit\b|dark/i);
  });
});
