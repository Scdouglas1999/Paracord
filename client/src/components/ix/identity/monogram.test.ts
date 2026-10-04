import { describe, expect, it } from 'vitest';

import { graphemes, monogramFontSize, monogramOf } from './monogram';

describe('monogramOf', () => {
  it('is one uppercase letter', () => {
    expect(monogramOf('Jeremy')).toBe('J');
    expect(monogramOf('vincent')).toBe('V');
    expect(monogramOf('Game Night')).toBe('G');
    expect(monogramOf('Nick Vincent Brendan')).toBe('N');
  });

  it('never returns two characters for a letter that uppercases to two', () => {
    expect(monogramOf('ßeta')).toBe('S');
  });

  it('keeps a letter with its accent and a non-Latin letter whole', () => {
    expect(monogramOf('élan')).toBe('É');
    expect(monogramOf('李雷')).toBe('李');
    expect(monogramOf('Ωmega')).toBe('Ω');
    expect(monogramOf('привет')).toBe('П');
  });

  it('takes a digit when the name starts with one', () => {
    expect(monogramOf('3am club')).toBe('3');
  });

  it('skips leading symbols and emoji for the first letter or digit', () => {
    expect(monogramOf('@jeremy')).toBe('J');
    expect(monogramOf('[Fuel] games')).toBe('F');
    expect(monogramOf('🔥 Fire pit')).toBe('F');
    expect(monogramOf('👨‍👩‍👧 family')).toBe('F');
  });

  it('falls back to the first whole grapheme when the name has no letter or digit', () => {
    expect(monogramOf('🔥')).toBe('🔥');
    expect(monogramOf('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(monogramOf('***')).toBe('*');
  });

  it('answers ? for an empty or blank name', () => {
    expect(monogramOf('')).toBe('?');
    expect(monogramOf('   ')).toBe('?');
    expect(monogramOf(null)).toBe('?');
    expect(monogramOf(undefined)).toBe('?');
  });
});

describe('graphemes', () => {
  it('splits by user-perceived character', () => {
    expect(graphemes('ab')).toEqual(['a', 'b']);
    expect(graphemes('👨‍👩‍👧x')).toEqual(['👨‍👩‍👧', 'x']);
    expect(graphemes('')).toEqual([]);
  });
});

describe('monogramFontSize', () => {
  it('is 44% of the size, rounded, for a person', () => {
    expect(monogramFontSize(24, 'person')).toBe(11);
    expect(monogramFontSize(30, 'person')).toBe(13);
    expect(monogramFontSize(32, 'person')).toBe(14);
    expect(monogramFontSize(38, 'person')).toBe(17);
    expect(monogramFontSize(40, 'person')).toBe(18);
    expect(monogramFontSize(76, 'person')).toBe(33);
  });

  it('is 36% from 88px up for a person (a large face carries a smaller letter)', () => {
    expect(monogramFontSize(87, 'person')).toBe(38);
    expect(monogramFontSize(88, 'person')).toBe(32);
    expect(monogramFontSize(120, 'person')).toBe(43);
  });

  it('is 44% at every size for a server mark', () => {
    expect(monogramFontSize(34, 'server')).toBe(15);
    expect(monogramFontSize(40, 'server')).toBe(18);
    expect(monogramFontSize(76, 'server')).toBe(33);
    expect(monogramFontSize(88, 'server')).toBe(39);
  });
});
