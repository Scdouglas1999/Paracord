import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop shell is told what the ground came out as on every appearance
// change. In jsdom the real one returns immediately (there is no Tauri), so it
// is mocked to be *observable* rather than to be made safe.
vi.mock('../lib/nativeGround', () => ({
  reportGroundColor: vi.fn(() => Promise.resolve()),
}));

import { DEFAULT_THEME, type ThemeId } from '../lib/themes';
import { useTheme } from './useTheme';
import { reportGroundColor } from '../lib/nativeGround';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import type { UserSettings } from '../types/user.types';

const root = () => document.documentElement;
const inline = (name: string) => root().style.getPropertyValue(name);

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return {
    user_id: '1',
    theme: 'glass',
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

function setTransparency(value: 'system' | 'standard' | 'reduced') {
  act(() => {
    useUIStore.getState().setTransparency(value);
  });
}

/** A `matchMedia` that answers for one query and lets a test flip the answer. */
function stubSystemTransparency(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initial;
  const original = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    get matches() {
      return query.includes('prefers-reduced-transparency') ? matches : false;
    },
    media: query,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent);
    },
    listeners,
    restore() {
      window.matchMedia = original;
    },
  };
}

beforeEach(() => {
  useUIStore.setState({
    theme: 'glass',
    transparency: 'system',
    customCss: '',
    lowBandwidthMode: false,
    motion: 'system',
  });
  useAuthStore.setState({ settings: null });
  root().removeAttribute('style');
  root().removeAttribute('data-theme');
  root().removeAttribute('data-reduced-transparency');
  vi.mocked(reportGroundColor).mockClear();
});

afterEach(() => {
  root().removeAttribute('style');
});

describe('useTheme', () => {
  it('publishes the theme', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('glass');
    expect(root().getAttribute('data-theme')).toBe('glass');
  });

  it('writes no color and no message shape of its own', () => {
    renderHook(() => useTheme());

    // The accent, base color and message-style controls are gone: nothing is
    // written inline, and nothing but the theme attribute carries a look.
    expect(root().getAttribute('style') ?? '').toBe('');
    expect(root().hasAttribute('data-message-style')).toBe(false);
  });

  it('narrows a stored theme it does not recognize to the default', () => {
    // Persisted state outlives the build that wrote it.
    useUIStore.setState({ theme: 'sepia' as ThemeId });
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe(DEFAULT_THEME);
    expect(root().getAttribute('data-theme')).toBe(DEFAULT_THEME);
  });

  it.each(['dark', 'light', 'amoled', 'dusk', 'paper', 'slate', 'voices'])(
    'shows Glass, not nothing, if a retired look %s is still in the store',
    (retired) => {
      useUIStore.setState({ theme: retired as ThemeId });
      const { result } = renderHook(() => useTheme());

      expect(result.current.theme).toBe('glass');
      expect(root().getAttribute('data-theme')).toBe('glass');
    },
  );

  it('shows High contrast if the retired high-contrast id is still in the store', () => {
    useUIStore.setState({ theme: 'high-contrast' as ThemeId });
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('glass-contrast');
    expect(root().getAttribute('data-theme')).toBe('glass-contrast');
  });

  it('follows the theme when it is changed', () => {
    renderHook(() => useTheme());

    setTheme('glass-contrast');
    expect(root().getAttribute('data-theme')).toBe('glass-contrast');

    setTheme('glass');
    expect(root().getAttribute('data-theme')).toBe('glass');
  });

  it('hydrates the theme from the server settings', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      useAuthStore.setState({ settings: settings({ theme: 'glass-contrast' }) });
    });

    expect(useUIStore.getState().theme).toBe('glass-contrast');
    expect(result.current.theme).toBe('glass-contrast');
    expect(root().getAttribute('data-theme')).toBe('glass-contrast');
  });

  it.each(['dark', 'slate', 'paper', 'voices', 'light', 'amoled', 'dusk'])(
    'takes a server theme of %s, which an older build stored, as Glass',
    (stored) => {
      setTheme('glass-contrast');
      const { result } = renderHook(() => useTheme());

      act(() => {
        useAuthStore.setState({ settings: settings({ theme: stored }) });
      });

      expect(useUIStore.getState().theme).toBe('glass');
      expect(result.current.theme).toBe('glass');
      expect(root().getAttribute('data-theme')).toBe('glass');
    },
  );

  it('takes a server theme of high-contrast as High contrast', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      useAuthStore.setState({ settings: settings({ theme: 'high-contrast' }) });
    });

    expect(useUIStore.getState().theme).toBe('glass-contrast');
    expect(result.current.theme).toBe('glass-contrast');
  });

  it('leaves the local choice alone when the server holds a value that is not a theme', () => {
    renderHook(() => useTheme());
    setTheme('glass-contrast');

    act(() => {
      useAuthStore.setState({ settings: settings({ theme: 'chartreuse-mist' }) });
    });

    expect(useUIStore.getState().theme).toBe('glass-contrast');
  });

  it('reports the ground to the desktop shell when the theme changes', () => {
    renderHook(() => useTheme());
    const before = vi.mocked(reportGroundColor).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    setTheme('glass-contrast');

    expect(vi.mocked(reportGroundColor).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('useTheme: reduced transparency', () => {
  let system: ReturnType<typeof stubSystemTransparency> | null = null;

  afterEach(() => {
    system?.restore();
    system = null;
  });

  it('is on when it is chosen, and off when it is not', () => {
    system = stubSystemTransparency(false);
    renderHook(() => useTheme());
    expect(root().getAttribute('data-reduced-transparency')).toBe('false');

    setTransparency('reduced');
    expect(root().getAttribute('data-reduced-transparency')).toBe('true');

    setTransparency('standard');
    expect(root().getAttribute('data-reduced-transparency')).toBe('false');
  });

  it('follows the device when it is set to match the system, and keeps following', () => {
    system = stubSystemTransparency(true);
    renderHook(() => useTheme());
    expect(root().getAttribute('data-reduced-transparency')).toBe('true');

    act(() => system!.flip(false));
    expect(root().getAttribute('data-reduced-transparency')).toBe('false');

    act(() => system!.flip(true));
    expect(root().getAttribute('data-reduced-transparency')).toBe('true');
  });

  it('ignores the device once a choice is made', () => {
    system = stubSystemTransparency(true);
    renderHook(() => useTheme());

    setTransparency('standard');
    expect(root().getAttribute('data-reduced-transparency')).toBe('false');
    // The system listener is gone, so a device change cannot override the choice.
    expect(system.listeners.size).toBe(0);
    act(() => system!.flip(true));
    expect(root().getAttribute('data-reduced-transparency')).toBe('false');
  });

  it('stops listening when the hook goes away', () => {
    system = stubSystemTransparency(false);
    const { unmount } = renderHook(() => useTheme());
    expect(system.listeners.size).toBe(1);

    unmount();

    expect(system.listeners.size).toBe(0);
  });

  it('is off, not missing, on a device that cannot say', () => {
    // jsdom has no `prefers-reduced-transparency`: the query never matches.
    renderHook(() => useTheme());

    expect(root().getAttribute('data-reduced-transparency')).toBe('false');
  });

  it('is independent of the theme', () => {
    system = stubSystemTransparency(false);
    renderHook(() => useTheme());
    setTransparency('reduced');

    setTheme('glass-contrast');

    expect(root().getAttribute('data-reduced-transparency')).toBe('true');
    expect(inline('--pane')).toBe('');
  });
});
