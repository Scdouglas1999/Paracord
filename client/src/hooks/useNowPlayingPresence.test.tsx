import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    native.handlers.set(name, handler);
    return native.unlisten;
  }),
}));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => true }));
const sources = vi.hoisted(() => ({ setActivitySource: vi.fn() }));
vi.mock('../lib/presenceActivities', () => sources);
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../stores/toastStore', () => ({ toast: toasts }));

import { useNowPlayingPresence } from './useNowPlayingPresence';
import { useAuthStore } from '../stores/authStore';
import { useNowPlayingStore } from '../stores/nowPlayingStore';
import { NOW_PLAYING_DEBOUNCE_MS } from '../lib/nowPlaying';
import type { UserSettings } from '../types';

function signIn(sharing: boolean) {
  useAuthStore.setState({
    token: 'token',
    settings: { status: 'online', notifications: { nowPlayingSharingEnabled: sharing } } as unknown as UserSettings,
  });
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('useNowPlayingPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.invoke.mockReset();
    native.invoke.mockImplementation(async (command: string) =>
      command === 'now_playing_support' ? { supported: true, reason: null } : undefined,
    );
    native.handlers.clear();
    native.unlisten.mockReset();
    sources.setActivitySource.mockReset();
    toasts.error.mockReset();
    useNowPlayingStore.getState().reset();
  });
  afterEach(() => vi.useRealTimers());

  it('does not start the reader while the setting is off', async () => {
    signIn(false);
    renderHook(() => useNowPlayingPresence());
    await act(flush);
    expect(native.invoke).not.toHaveBeenCalledWith('now_playing_start');
    expect(sources.setActivitySource).toHaveBeenCalledWith('listening', null);
  });

  it('starts the reader, turns what it reads into a listening activity, and stops when turned off', async () => {
    signIn(true);
    const { rerender } = renderHook(() => useNowPlayingPresence());
    await act(flush);
    expect(native.invoke).toHaveBeenCalledWith('now_playing_start');

    act(() => {
      native.handlers.get('now_playing_changed')!({
        payload: {
          player: 'Spotify',
          title: 'Windowlicker',
          artist: 'Aphex Twin',
          status: 'playing',
          position_ms: 0,
          duration_ms: 367_000,
        },
      });
    });
    expect(useNowPlayingStore.getState().current?.title).toBe('Windowlicker');
    act(() => {
      vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    });
    expect(sources.setActivitySource).toHaveBeenLastCalledWith(
      'listening',
      expect.objectContaining({ type: 2, name: 'Spotify', details: 'Windowlicker', state: 'Aphex Twin' }),
    );

    act(() => signIn(false));
    rerender();
    await act(flush);
    expect(native.invoke).toHaveBeenCalledWith('now_playing_stop');
    expect(native.unlisten).toHaveBeenCalled();
    expect(sources.setActivitySource).toHaveBeenLastCalledWith('listening', null);
  });

  it('says so loudly when the system media controls cannot be reached', async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'now_playing_support') return { supported: true, reason: null };
      if (command === 'now_playing_start') throw 'Could not reach the desktop\'s media controls (D-Bus session bus): no bus';
      return undefined;
    });
    signIn(true);
    renderHook(() => useNowPlayingPresence());
    await act(flush);
    expect(useNowPlayingStore.getState().error).toMatch(/D-Bus session bus/);
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/Stopped sharing what you're listening to/));
  });

  it('a reader that dies later clears the activity and reports why', async () => {
    signIn(true);
    renderHook(() => useNowPlayingPresence());
    await act(flush);
    act(() => {
      native.handlers.get('now_playing_failed')!({ payload: 'Lost the desktop\'s media controls: bus closed' });
    });
    expect(sources.setActivitySource).toHaveBeenLastCalledWith('listening', null);
    expect(useNowPlayingStore.getState().error).toMatch(/bus closed/);
    expect(toasts.error).toHaveBeenCalled();
  });

  it('does not start where the platform has no reader', async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === 'now_playing_support' ? { supported: false, reason: 'Not available on macOS yet.' } : undefined,
    );
    signIn(true);
    renderHook(() => useNowPlayingPresence());
    await act(flush);
    expect(native.invoke).not.toHaveBeenCalledWith('now_playing_start');
    expect(useNowPlayingStore.getState().support?.reason).toBe('Not available on macOS yet.');
  });
});
