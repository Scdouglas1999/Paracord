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
  it('is the four themes and the four looks, in the order Settings shows them', () => {
    expect([...THEME_IDS]).toEqual([
      'dark',
      'light',
      'amoled',
      'high-contrast',
      'dusk',
      'paper',
      'slate',
      'voices',
    ]);
  });

  it('names Slate as the default', () => {
    expect(DEFAULT_THEME).toBe('slate');
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
    expect(asThemeId('sepia')).toBe('slate');
    expect(asThemeId(undefined)).toBe('slate');
    expect(asThemeId(null)).toBe('slate');
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
    for (const id of ['dark', 'amoled', 'high-contrast', 'dusk', 'slate', 'voices'] as ThemeId[]) {
      expect(LIGHT_THEMES.has(id)).toBe(false);
    }
  });

  it('holds nothing that is not a theme id', () => {
    for (const id of LIGHT_THEMES) expect(isThemeId(id)).toBe(true);
  });
});

describe('LOOK_THEMES', () => {
  it('is the four looks', () => {
    expect([...LOOK_THEMES].sort()).toEqual(['dusk', 'paper', 'slate', 'voices']);
  });

  it('leaves the four themes out — they keep the accent and base-color controls', () => {
    for (const id of ['dark', 'light', 'amoled', 'high-contrast'] as ThemeId[]) {
      expect(LOOK_THEMES.has(id)).toBe(false);
    }
  });

  it('holds nothing that is not a theme id', () => {
    for (const id of LOOK_THEMES) expect(isThemeId(id)).toBe(true);
  });
});

describe('messageStyleFor', () => {
  it('gives Slate and Aubergine bubbles', () => {
    expect(messageStyleFor('slate')).toBe('bubbles');
    expect(messageStyleFor('voices')).toBe('bubbles');
  });

  it('gives every other theme and look rows', () => {
    for (const id of THEME_IDS) {
      if (id === 'voices' || id === 'slate') continue;
      expect(messageStyleFor(id)).toBe('rows');
    }
  });
});
