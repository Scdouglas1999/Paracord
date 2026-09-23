import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop shell is told what the ground came out as on every appearance
// change. In jsdom the real one returns immediately (there is no Tauri), so it
// is mocked to be *observable* rather than to be made safe.
vi.mock('../lib/nativeGround', () => ({
  reportGroundColor: vi.fn(() => Promise.resolve()),
}));

import { DEFAULT_THEME } from '../lib/themes';
import { useTheme } from './useTheme';
import { reportGroundColor } from '../lib/nativeGround';
import { useAuthStore } from '../stores/authStore';
import { BASE_HUE_DEFAULT, BASE_TINT_DEFAULT, useUIStore } from '../stores/uiStore';
import { LOOK_THEMES, type ThemeId } from '../lib/themes';
import type { UserSettings } from '../types/user.types';

/** Every inline property a look must hand back to `tokens.css`. */
const ACCENT_PROPERTIES = [
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-primary-active',
  '--accent',
  '--text-link',
  '--accent-primary-rgb',
  '--sidebar-active-indicator',
] as const;

const root = () => document.documentElement;
const inline = (name: string) => root().style.getPropertyValue(name);

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return {
    user_id: '1',
    theme: 'dark',
    locale: 'en-US',
    message_display_compact: false,
    status: 'online',
    crypto_auth_enabled: false,
    ...over,
  } as UserSettings;
}

function setTheme(theme: ThemeId) {
  act(() => {
    useUIStore.getState().setTheme(theme);
  });
}

beforeEach(() => {
  useUIStore.setState({
    theme: 'dark',
    accentPreset: 'emerald',
    baseHue: BASE_HUE_DEFAULT,
    baseTint: BASE_TINT_DEFAULT,
    customCss: '',
    lowBandwidthMode: false,
    motion: 'system',
  });
  useAuthStore.setState({ settings: null });
  root().removeAttribute('style');
  root().removeAttribute('data-theme');
  root().removeAttribute('data-message-style');
  vi.mocked(reportGroundColor).mockClear();
});

afterEach(() => {
  root().removeAttribute('style');
});

describe('useTheme', () => {
  it('publishes the theme, the colour scheme and the message shape', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().style.colorScheme).toBe('dark');
    expect(root().getAttribute('data-message-style')).toBe('rows');
  });

  it('narrows a stored theme it does not recognise to the default', () => {
    // Persisted state outlives the build that wrote it.
    useUIStore.setState({ theme: 'sepia' as ThemeId });
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe(DEFAULT_THEME);
    expect(root().getAttribute('data-theme')).toBe(DEFAULT_THEME);
  });

  it('gives a light theme color-scheme light', () => {
    renderHook(() => useTheme());
    setTheme('light');

    expect(root().style.colorScheme).toBe('light');
    expect(root().getAttribute('data-theme')).toBe('light');
  });

  it('writes the accent preset and the base colour for a theme that is not a look', () => {
    renderHook(() => useTheme());

    for (const name of ACCENT_PROPERTIES) expect(inline(name)).not.toBe('');
    expect(inline('--ui-hue')).toBe(String(BASE_HUE_DEFAULT));
    expect(inline('--ui-chroma')).toBe(String(BASE_TINT_DEFAULT));
  });

  it.each(['dusk', 'paper', 'slate', 'voices'] as ThemeId[])(
    'removes the accent and base-colour properties for the %s look',
    (look) => {
      renderHook(() => useTheme());
      // Written first, so the assertion proves a removal rather than an absence.
      for (const name of ACCENT_PROPERTIES) expect(inline(name)).not.toBe('');

      setTheme(look);

      expect(LOOK_THEMES.has(look)).toBe(true);
      expect(root().getAttribute('data-theme')).toBe(look);
      for (const name of ACCENT_PROPERTIES) expect(inline(name)).toBe('');
      expect(inline('--ui-hue')).toBe('');
      expect(inline('--ui-chroma')).toBe('');
    },
  );

  it('keeps a look out of the base-colour control even when the hue is moved', () => {
    renderHook(() => useTheme());
    setTheme('dusk');

    act(() => {
      useUIStore.getState().setBaseHue(200);
      useUIStore.getState().setBaseTint(1);
    });

    expect(inline('--ui-hue')).toBe('');
    expect(inline('--ui-chroma')).toBe('');
  });

  it('gives Voices bubbles and every other look rows', () => {
    renderHook(() => useTheme());

    setTheme('voices');
    expect(root().getAttribute('data-message-style')).toBe('bubbles');
    expect(root().style.colorScheme).toBe('dark');

    setTheme('paper');
    expect(root().getAttribute('data-message-style')).toBe('rows');
    expect(root().style.colorScheme).toBe('light');
  });

  it('writes the accent and base colour again when a look is left', () => {
    renderHook(() => useTheme());
    setTheme('voices');
    for (const name of ACCENT_PROPERTIES) expect(inline(name)).toBe('');

    setTheme('dark');

    for (const name of ACCENT_PROPERTIES) expect(inline(name)).not.toBe('');
    expect(inline('--ui-hue')).toBe(String(BASE_HUE_DEFAULT));
    expect(inline('--ui-chroma')).toBe(String(BASE_TINT_DEFAULT));
    expect(root().getAttribute('data-message-style')).toBe('rows');
  });

  it('hydrates a look from the server settings', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      useAuthStore.setState({ settings: settings({ theme: 'paper' }) });
    });

    expect(useUIStore.getState().theme).toBe('paper');
    expect(result.current.theme).toBe('paper');
    expect(root().getAttribute('data-theme')).toBe('paper');
  });

  it('leaves the local choice alone when the server holds a theme it does not know', () => {
    renderHook(() => useTheme());
    setTheme('dusk');

    act(() => {
      useAuthStore.setState({ settings: settings({ theme: 'chartreuse-mist' }) });
    });

    expect(useUIStore.getState().theme).toBe('dusk');
  });

  it('reports the ground to the desktop shell when the theme changes', () => {
    renderHook(() => useTheme());
    const before = vi.mocked(reportGroundColor).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    setTheme('dusk');

    expect(vi.mocked(reportGroundColor).mock.calls.length).toBeGreaterThan(before);
  });
});
