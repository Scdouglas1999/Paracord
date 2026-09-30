import { useAuthStore } from '../stores/authStore';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useKeyboardNavigation } from './useKeyboardNavigation';
import { useUIStore } from '../stores/uiStore';
import { useChannelStore } from '../stores/channelStore';

/**
 * useKeyboardNavigation owns the Escape precedence Command palette → the
 * sheet request (contextPanelMode) → narrow places overlay, and Mod+F search.
 * (The Lantern sidebar's arrow-key roving went with the sidebar in WP-G22; the
 * places panel has its own, in components/glass/places.)
 * These tests exercise the actual key handling so a regression (off-by-one,
 * container-selector drift, precedence reorder) fails loudly instead of shipping green.
 */

function Harness() {
  useKeyboardNavigation();
  return (
    <div>
      <button type="button">row-0</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ token: 'token', user: { id: 'me' } as never });
  useUIStore.setState({
    commandPaletteOpen: false,
    contextPanelMode: null,
    sidebarCollapsed: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useKeyboardNavigation — Mod+F search', () => {
  it('opens the search context panel when a channel is selected', () => {
    useChannelStore.getState().selectChannel({ id: 'ch1', scope: { serverId: '__local__', userId: 'me' } });
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBe('search');
  });

  it('does nothing when no channel is selected', () => {
    useChannelStore.getState().selectChannel(null);
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });
});

describe('useKeyboardNavigation — Escape precedence (§5)', () => {
  it('closes the Command palette first, leaving the ContextPanel open', () => {
    useUIStore.setState({ commandPaletteOpen: true, contextPanelMode: 'pins' });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const ui = useUIStore.getState();
    expect(ui.commandPaletteOpen).toBe(false);
    // Precedence: the panel is NOT also closed in the same keystroke.
    expect(ui.contextPanelMode).toBe('pins');
  });

  it('closes the ContextPanel next when the palette is already closed', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'pins' });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('leaves the ContextPanel open while a modal dialog owns Escape', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'pins' });
    renderHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBe('pins');
    dialog.remove();
  });

  it('leaves the ContextPanel open while a transient menu owns Escape', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'pins' });
    renderHarness();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBe('pins');
    menu.remove();
  });

  it('closes the narrow sidebar overlay last, only once palette + panel are closed', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    );
    useUIStore.setState({
      commandPaletteOpen: false,
      contextPanelMode: null,
      sidebarCollapsed: false,
    });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });
});

describe('useKeyboardNavigation — Mod+F search', () => {
  it('opens contextPanelMode search when a channel is selected', async () => {
    const { useChannelStore } = await import('../stores/channelStore');
    useChannelStore.getState().selectChannel({ id: 'ch-1', scope: { serverId: '__local__', userId: 'me' } });
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBe('search');
  });
});
