import { describe, expect, it } from 'vitest';
import {
  EMOJI_SHORTCODES,
  applyCompletion,
  completionAt,
  isLinkableChannel,
  matchShortcodes,
  slowModeLabel,
} from './composerCompletion';

describe('completion at the caret', () => {
  it('finds @ anywhere, # and : only at the start of a word', () => {
    expect(completionAt('hey @ma', 7)).toEqual({ kind: 'mention', query: 'ma', start: 4 });
    expect(completionAt('(@ma', 4)).toEqual({ kind: 'mention', query: 'ma', start: 1 });
    expect(completionAt('see #lo', 7)).toEqual({ kind: 'channel', query: 'lo', start: 4 });
    expect(completionAt('#', 1)).toEqual({ kind: 'channel', query: '', start: 0 });
    expect(completionAt('so :fi', 6)).toEqual({ kind: 'emoji', query: 'fi', start: 3 });
    // A URL fragment and a time never open a list.
    expect(completionAt('example.com/#top', 16)).toBeNull();
    expect(completionAt('at 9:30', 7)).toBeNull();
    // ":" waits for two letters.
    expect(completionAt('ok :f', 5)).toBeNull();
    expect(completionAt('plain words', 11)).toBeNull();
  });

  it('reads only what is before the caret', () => {
    expect(completionAt('hey @ma and more', 7)).toEqual({ kind: 'mention', query: 'ma', start: 4 });
    expect(completionAt('hey @ma and more', 16)).toBeNull();
  });

  it('replaces the trigger and query with the token and a space, keeping what follows', () => {
    expect(applyCompletion('hey @ma', 7, 4, '<@42>')).toEqual({ text: 'hey <@42> ', caret: 10 });
    expect(applyCompletion('see #lo then', 7, 4, '<#9>')).toEqual({ text: 'see <#9>  then', caret: 9 });
  });
});

describe('emoji shortcodes', () => {
  it('puts names that start with the query first', () => {
    const names = matchShortcodes('fi').map((entry) => entry.name);
    expect(names[0]).toBe('fire');
    expect(names).toContain('crossed_fingers');
    expect(names.indexOf('fire')).toBeLessThan(names.indexOf('crossed_fingers'));
    expect(matchShortcodes('')).toEqual([]);
    expect(matchShortcodes('heart').length).toBeGreaterThan(3);
  });

  it('has one entry per name, each an emoji', () => {
    const names = EMOJI_SHORTCODES.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const [, emoji] of EMOJI_SHORTCODES) expect(emoji).toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('the rest of the box', () => {
  it('links text, announcement and forum channels, never voice', () => {
    expect(isLinkableChannel({ type: 0 })).toBe(true);
    expect(isLinkableChannel({ channel_type: 5 })).toBe(true);
    expect(isLinkableChannel({ type: 7 })).toBe(true);
    expect(isLinkableChannel({ type: 2 })).toBe(false);
    expect(isLinkableChannel({ type: 4 })).toBe(false);
  });

  it('says slow mode in the largest whole unit', () => {
    expect(slowModeLabel(0)).toBeNull();
    expect(slowModeLabel(undefined)).toBeNull();
    expect(slowModeLabel(12)).toBe('Slow mode: 12s');
    expect(slowModeLabel(300)).toBe('Slow mode: 5m');
    expect(slowModeLabel(7200)).toBe('Slow mode: 2h');
  });
});
