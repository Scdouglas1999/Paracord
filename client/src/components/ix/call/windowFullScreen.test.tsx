import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore } from '../../../stores/glassStore';
import { useWindowFullScreen } from './windowFullScreen';

/**
 * The desktop app's full screen (docs/index-spec.md §7.7): the Tauri window
 * goes full screen, comes back as it was (maximized, or its size and
 * position) whatever the window manager did, follows an exit it did not ask
 * for, and covers native video while the window changes size.
 */

vi.mock('../../../lib/tauriEnv', () => ({ isTauri: () => true }));

const win = vi.hoisted(() => {
  const state = {
    full: false,
    maximized: true,
    size: { width: 1440, height: 900 },
    position: { x: 0, y: 0 },
    /** What the window manager does when full screen ends. */
    onExit: null as null | (() => void),
  };
  let resized: (() => void) | null = null;
  const api = {
    isFullscreen: vi.fn(async () => state.full),
    isMaximized: vi.fn(async () => state.maximized),
    innerSize: vi.fn(async () => ({ ...state.size })),
    outerPosition: vi.fn(async () => ({ ...state.position })),
    setFullscreen: vi.fn(async (on: boolean) => {
      state.full = on;
      if (!on) state.onExit?.();
      window.dispatchEvent(new Event('resize'));
      resized?.();
    }),
    maximize: vi.fn(async () => {
      state.maximized = true;
    }),
    unmaximize: vi.fn(async () => {
      state.maximized = false;
    }),
    setSize: vi.fn(async (size: { width: number; height: number }) => {
      state.size = { width: size.width, height: size.height };
    }),
    setPosition: vi.fn(async (position: { x: number; y: number }) => {
      state.position = { x: position.x, y: position.y };
    }),
    onResized: vi.fn(async (listener: () => void) => {
      resized = listener;
      return () => {
        resized = null;
      };
    }),
  };
  return { state, api, resize: () => resized?.() };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win.api }));
vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));

function FullScreen() {
  useWindowFullScreen(useGlassStore((state) => state.stage.fullscreen));
  return null;
}

const STREAM = { serverId: 's', guildId: 'g', channelId: 'c', streamerId: 'vincent' };

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

beforeEach(() => {
  Object.assign(win.state, { full: false, maximized: true, size: { width: 1440, height: 900 }, position: { x: 0, y: 0 }, onExit: null });
  vi.clearAllMocks();
  useGlassStore.getState().reset();
  useGlassStore.getState().openStage(STREAM);
});

afterEach(() => {
  useGlassStore.getState().reset();
  document.querySelectorAll('[data-native-shield]').forEach((node) => node.remove());
});

describe('useWindowFullScreen (desktop)', () => {
  it('goes full screen, covering native video until the window has its new size, and comes back maximized', async () => {
    render(<FullScreen />);
    act(() => useGlassStore.getState().setStageFullscreen(true));
    // Covered from the first frame.
    expect(document.querySelector('[data-native-shield]')).not.toBeNull();
    expect(document.documentElement).toHaveAttribute('data-native-moving');
    await waitFor(() => expect(win.api.setFullscreen).toHaveBeenCalledWith(true));
    await waitFor(() => expect(document.querySelector('[data-native-shield]')).toBeNull());
    expect(document.documentElement).not.toHaveAttribute('data-native-moving');

    // The window manager forgets the maximized state on the way out: it is put back.
    win.state.onExit = () => {
      win.state.maximized = false;
      win.state.size = { width: 1280, height: 800 };
    };
    act(() => useGlassStore.getState().setStageFullscreen(false));
    await waitFor(() => expect(win.api.maximize).toHaveBeenCalledTimes(1));
    expect(win.state).toMatchObject({ full: false, maximized: true });
    expect(win.api.setSize).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('[data-native-shield]')).toBeNull());
  });

  it('maximized again at the full-screen size (a screen-sized surface held it): maximized anew to its own size', async () => {
    win.api.maximize.mockImplementation(async () => {
      win.state.maximized = true;
      win.state.size = { width: 1440, height: 900 };
    });
    win.state.onExit = () => {
      win.state.size = { width: 1440, height: 928 };
    };
    render(<FullScreen />);
    act(() => useGlassStore.getState().setStageFullscreen(true));
    await waitFor(() => expect(win.state.full).toBe(true));
    await settle();
    act(() => useGlassStore.getState().setStageFullscreen(false));
    await waitFor(() => expect(win.api.maximize).toHaveBeenCalledTimes(1));
    expect(win.api.unmaximize).toHaveBeenCalledTimes(1);
    expect(win.state).toMatchObject({ full: false, maximized: true, size: { width: 1440, height: 900 } });
  });

  it('a window that was not maximized gets its size and position back', async () => {
    Object.assign(win.state, { maximized: false, size: { width: 1100, height: 720 }, position: { x: 40, y: 60 } });
    win.state.onExit = () => {
      win.state.size = { width: 1440, height: 900 };
      win.state.position = { x: 0, y: 0 };
    };
    render(<FullScreen />);
    act(() => useGlassStore.getState().setStageFullscreen(true));
    await waitFor(() => expect(win.state.full).toBe(true));
    await settle();
    act(() => useGlassStore.getState().setStageFullscreen(false));
    await waitFor(() => expect(win.api.setPosition).toHaveBeenCalledTimes(1));
    expect(win.state).toMatchObject({ maximized: false, size: { width: 1100, height: 720 }, position: { x: 40, y: 60 } });
    expect(win.api.maximize).not.toHaveBeenCalled();
  });

  it('follows a full screen ended from outside (the compositor), and closing the view ends it', async () => {
    render(<FullScreen />);
    act(() => useGlassStore.getState().setStageFullscreen(true));
    await waitFor(() => expect(win.api.onResized).toHaveBeenCalled());
    await settle();
    win.state.full = false;
    await act(async () => {
      win.resize();
      await Promise.resolve();
    });
    await waitFor(() => expect(useGlassStore.getState().stage.fullscreen).toBe(false));
    // The view stays where it was.
    expect(useGlassStore.getState().stage.mode).toBe('main');

    act(() => useGlassStore.getState().setStageFullscreen(true));
    await waitFor(() => expect(win.state.full).toBe(true));
    await settle();
    act(() => useGlassStore.getState().closeStage());
    await waitFor(() => expect(win.state.full).toBe(false));
  });
});
