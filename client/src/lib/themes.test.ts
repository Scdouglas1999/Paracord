import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  LIGHT_THEMES,
  LOOK_THEMES,
  THEME_IDS,
  asThemeId,
  isThemeId,
  messageStyleFor,
  type ThemeId,
} from './themes';

describe('THEME_IDS', () => {
  it('is the four themes and the three looks, in the order Settings shows them', () => {
    expect([...THEME_IDS]).toEqual([
      'dark',
      'light',
      'amoled',
      'high-contrast',
      'dusk',
      'paper',
      'voices',
    ]);
  });

  it('names Night as the default', () => {
    expect(DEFAULT_THEME).toBe('voices');
    expect(THEME_IDS).toContain(DEFAULT_THEME);
  });
});

describe('isThemeId', () => {
  it('accepts every id in the list', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true);
  });

  it('rejects anything else, including the shapes stored state arrives in', () => {
    for (const value of ['', 'Dark', 'midnight', 'looks', null, undefined, 0, 1, {}, ['dark']]) {
      expect(isThemeId(value)).toBe(false);
    }
  });
});

describe('asThemeId', () => {
  it('passes a known id through', () => {
    expect(asThemeId('paper')).toBe('paper');
    expect(asThemeId('high-contrast')).toBe('high-contrast');
  });

  it('collapses an unknown value to Night', () => {
    expect(asThemeId('sepia')).toBe('voices');
    expect(asThemeId(undefined)).toBe('voices');
    expect(asThemeId(null)).toBe('voices');
  });

  it('takes an explicit fallback', () => {
    expect(asThemeId('sepia', 'paper')).toBe('paper');
  });
});

describe('LIGHT_THEMES', () => {
  it('is Daylight and Paper & ink', () => {
    expect([...LIGHT_THEMES].sort()).toEqual(['light', 'paper']);
  });

  it('leaves every dark theme and dark look out', () => {
    for (const id of ['dark', 'amoled', 'high-contrast', 'dusk', 'voices'] as ThemeId[]) {
      expect(LIGHT_THEMES.has(id)).toBe(false);
    }
  });

  it('holds nothing that is not a theme id', () => {
    for (const id of LIGHT_THEMES) expect(isThemeId(id)).toBe(true);
  });
});

describe('LOOK_THEMES', () => {
  it('is the three looks', () => {
    expect([...LOOK_THEMES].sort()).toEqual(['dusk', 'paper', 'voices']);
  });

  it('leaves the four themes out — they keep the accent and base-colour controls', () => {
    for (const id of ['dark', 'light', 'amoled', 'high-contrast'] as ThemeId[]) {
      expect(LOOK_THEMES.has(id)).toBe(false);
    }
  });

  it('holds nothing that is not a theme id', () => {
    for (const id of LOOK_THEMES) expect(isThemeId(id)).toBe(true);
  });
});

describe('messageStyleFor', () => {
  it('gives Voices bubbles', () => {
    expect(messageStyleFor('voices')).toBe('bubbles');
  });

  it('gives every other theme and look rows', () => {
    for (const id of THEME_IDS) {
      if (id === 'voices') continue;
      expect(messageStyleFor(id)).toBe('rows');
    }
  });
});
