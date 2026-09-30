import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  HIGH_CONTRAST_THEME,
  THEME_IDS,
  TRANSPARENCY_PREFERENCES,
  asThemeId,
  asTransparencyPreference,
  isThemeId,
  migrateThemeId,
} from './themes';

/** Every id a build before Glass could have written, to `localStorage` or the server. */
const RETIRED = ['dark', 'light', 'amoled', 'high-contrast', 'dusk', 'paper', 'slate', 'voices'];

describe('THEME_IDS', () => {
  it('is Glass and High contrast, and nothing else', () => {
    expect([...THEME_IDS]).toEqual(['glass', 'glass-contrast']);
  });

  it('names Glass as the default, and High contrast as the other', () => {
    expect(DEFAULT_THEME).toBe('glass');
    expect(HIGH_CONTRAST_THEME).toBe('glass-contrast');
    expect(THEME_IDS).toContain(DEFAULT_THEME);
    expect(THEME_IDS).toContain(HIGH_CONTRAST_THEME);
  });
});

describe('isThemeId', () => {
  it('accepts every id in the list', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true);
  });

  it('rejects the retired ids and the shapes stored state arrives in', () => {
    for (const value of [...RETIRED, '', 'Glass', 'midnight', null, undefined, 0, 1, {}, ['glass']]) {
      expect(isThemeId(value)).toBe(false);
    }
  });
});

describe('migrateThemeId', () => {
  it('passes a current id through', () => {
    expect(migrateThemeId('glass')).toBe('glass');
    expect(migrateThemeId('glass-contrast')).toBe('glass-contrast');
  });

  it('keeps a High contrast choice as High contrast', () => {
    expect(migrateThemeId('high-contrast')).toBe('glass-contrast');
  });

  it('turns every other retired id into Glass', () => {
    for (const id of RETIRED.filter((value) => value !== 'high-contrast')) {
      expect(migrateThemeId(id), id).toBe('glass');
    }
  });

  it('says null, not Glass, for a value that was never a theme', () => {
    for (const value of ['sepia', '', 'GLASS', 'chartreuse-mist', null, undefined, 3, {}, ['dark']]) {
      expect(migrateThemeId(value)).toBeNull();
    }
  });
});

describe('asThemeId', () => {
  it('passes a current id through', () => {
    expect(asThemeId('glass-contrast')).toBe('glass-contrast');
  });

  it('collapses every retired id to Glass, or High contrast for high-contrast', () => {
    for (const id of RETIRED) {
      expect(asThemeId(id), id).toBe(id === 'high-contrast' ? 'glass-contrast' : 'glass');
    }
  });

  it('collapses an unknown value to the default', () => {
    expect(asThemeId('sepia')).toBe('glass');
    expect(asThemeId(undefined)).toBe('glass');
    expect(asThemeId(null)).toBe('glass');
  });

  it('takes an explicit fallback for an unknown value only', () => {
    expect(asThemeId('sepia', 'glass-contrast')).toBe('glass-contrast');
    // A retired id is recognized, so the fallback does not apply to it.
    expect(asThemeId('paper', 'glass-contrast')).toBe('glass');
  });
});

describe('asTransparencyPreference', () => {
  it('keeps the three preferences', () => {
    expect([...TRANSPARENCY_PREFERENCES]).toEqual(['system', 'standard', 'reduced']);
    for (const value of TRANSPARENCY_PREFERENCES) expect(asTransparencyPreference(value)).toBe(value);
  });

  it('follows the system for anything else', () => {
    for (const value of ['', 'on', 'full', null, undefined, true, 1]) {
      expect(asTransparencyPreference(value)).toBe('system');
    }
  });
});
