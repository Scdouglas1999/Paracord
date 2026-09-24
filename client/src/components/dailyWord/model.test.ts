import { describe, expect, it } from 'vitest';
import type { DailyWordGuess } from '../../api/dailyWord';
import {
  describeGuess,
  effectivePalette,
  isDailyWordPath,
  keyboardStates,
  resultPhrase,
  shareText,
  solvedCaption,
  timeUntil,
} from './model';

const guess = (word: string, states: DailyWordGuess['states']): DailyWordGuess => ({ word, states });

describe('keyboardStates', () => {
  it('is empty before any guess', () => {
    expect(keyboardStates([])).toEqual({});
  });

  it('keeps the best state a letter has earned', () => {
    const states = keyboardStates([
      guess('crane', ['absent', 'present', 'absent', 'absent', 'correct']),
      // r lands in place later; e is guessed elsewhere and stays in place.
      guess('ruder', ['correct', 'absent', 'absent', 'present', 'absent']),
    ]);
    expect(states.c).toBe('absent');
    expect(states.r).toBe('correct');
    expect(states.e).toBe('correct');
    expect(states.u).toBe('absent');
    expect(states.d).toBe('absent');
    expect(states.z).toBeUndefined();
  });

  it('marks a doubled letter by its better copy', () => {
    // The first e is absent (its only copy is used in place by the second).
    const states = keyboardStates([guess('geese', ['absent', 'absent', 'absent', 'absent', 'correct'])]);
    expect(states.e).toBe('correct');
  });

  it('never lowers a present letter to absent', () => {
    const states = keyboardStates([
      guess('slate', ['present', 'absent', 'absent', 'absent', 'absent']),
      guess('bless', ['absent', 'absent', 'absent', 'absent', 'absent']),
    ]);
    expect(states.s).toBe('present');
  });
});

describe('shareText', () => {
  const rows = [
    guess('crane', ['absent', 'present', 'absent', 'absent', 'correct']),
    guess('ruder', ['correct', 'absent', 'absent', 'present', 'absent']),
    guess('rinse', ['correct', 'correct', 'correct', 'correct', 'correct']),
  ];

  it('is the puzzle, the score and one row of squares per guess, with no letters', () => {
    const text = shareText(267, rows, true);
    expect(text).toBe(
      'Daily word 267 · 3/6\n\n'
      + '⬛\u{1F7E8}⬛⬛\u{1F7E9}\n'
      + '\u{1F7E9}⬛⬛\u{1F7E8}⬛\n'
      + '\u{1F7E9}\u{1F7E9}\u{1F7E9}\u{1F7E9}\u{1F7E9}',
    );
    for (const word of ['crane', 'ruder', 'rinse']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('says X for a miss', () => {
    const six = Array.from({ length: 6 }, () => guess('crane', ['absent', 'absent', 'absent', 'absent', 'absent']));
    expect(shareText(12, six, false).split('\n')[0]).toBe('Daily word 12 · X/6');
    expect(shareText(12, six, false).split('\n')).toHaveLength(8);
  });

  it('uses orange and blue squares in the contrast palette', () => {
    const text = shareText(3, rows.slice(0, 1), false, 'contrast');
    expect(text.split('\n')[2]).toBe('⬛\u{1F7E6}⬛⬛\u{1F7E7}');
  });
});

describe('small helpers', () => {
  it('counts down to the next word', () => {
    const now = Date.parse('2026-09-24T18:48:00Z');
    expect(timeUntil('2026-09-25T00:00:00Z', now)).toBe('5 h 12 min');
    expect(timeUntil('2026-09-24T19:00:00Z', now)).toBe('12 min');
    expect(timeUntil('2026-09-24T20:48:00Z', now)).toBe('2 h');
    expect(timeUntil('2026-09-24T18:48:30Z', now)).toBe('less than a minute');
  });

  it('phrases results and counts', () => {
    expect(resultPhrase(true, 3)).toBe('Solved in 3');
    expect(resultPhrase(false, 6)).toBe('Missed');
    expect(solvedCaption(0)).toBe('No one has solved it yet');
    expect(solvedCaption(1)).toBe('1 person solved it');
    expect(solvedCaption(6)).toBe('6 of you solved it');
  });

  it('follows the high contrast theme unless the player chose', () => {
    expect(effectivePalette(null, 'high-contrast')).toBe('contrast');
    expect(effectivePalette(null, 'slate')).toBe('standard');
    expect(effectivePalette('standard', 'high-contrast')).toBe('standard');
    expect(effectivePalette('contrast', 'slate')).toBe('contrast');
  });

  it('describes a guess for screen readers', () => {
    expect(describeGuess(guess('crane', ['absent', 'present', 'absent', 'absent', 'correct']))).toBe(
      'CRANE: C not in the word, R in the word, A not in the word, N not in the word, E in place',
    );
  });

  it('knows its own page', () => {
    expect(isDailyWordPath('7', '/app/guilds/7/daily-word')).toBe(true);
    expect(isDailyWordPath('7', '/app/guilds/7/sports')).toBe(false);
    expect(isDailyWordPath('7', '/app/guilds/70/daily-word')).toBe(false);
  });
});
