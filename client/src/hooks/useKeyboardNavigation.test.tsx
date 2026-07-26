import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useKeyboardNavigation } from './useKeyboardNavigation';
import { useUIStore } from '../stores/uiStore';
import { useChannelStore } from '../stores/channelStore';

/**
 * useKeyboardNavigation owns two flagship new-IA behaviors (layout-spec §5):
 *   (a) roving-tabindex movement across the flat sidebar row list
 *       (ArrowUp/Down/Home/End over [data-nav-index] inside [data-roving-container]),
 *   (b) the Escape precedence Command Palette → ContextPanel → narrow sidebar overlay.
 * These tests exercise the actual key handling so a regression (off-by-one,
 * container-selector drift, precedence reorder) fails loudly instead of shipping green.
 */

function Harness() {
  useKeyboardNavigation();
  return (
    <div data-roving-container="">
      <button type="button" data-nav-index={0}>
        row-0
      </button>
      <button type="button" data-nav-index={1}>
        row-1
      </button>
      <button type="button" data-nav-index={2}>
        row-2
      </button>
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

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-nav-index]'));
}

beforeEach(() => {
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

describe('useKeyboardNavigation — roving-tabindex sidebar movement', () => {
  it('ArrowDown / ArrowUp move focus to the adjacent row', () => {
    renderHarness();
    const [r0, r1] = rows();
    r0.focus();

    fireEvent.keyDown(r0, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r1);

    fireEvent.keyDown(r1, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(r0);
  });

  it('wraps around at both ends', () => {
    renderHarness();
    const [r0, , r2] = rows();
    r0.focus();

    // Up from the first row wraps to the last.
    fireEvent.keyDown(r0, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(r2);

    // Down from the last row wraps to the first.
    fireEvent.keyDown(r2, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r0);
  });

  it('Home / End jump to the first / last row', () => {
    renderHarness();
    const [r0, r1, r2] = rows();
    r1.focus();

    fireEvent.keyDown(r1, { key: 'End' });
    expect(document.activeElement).toBe(r2);

    fireEvent.keyDown(r2, { key: 'Home' });
    expect(document.activeElement).toBe(r0);
  });

  it('does not move focus when it is outside the roving container', () => {
    renderHarness();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.keyDown(outside, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('useKeyboardNavigation — Mod+F search', () => {
  it('opens the search context panel when a channel is selected', () => {
    useChannelStore.setState({ selectedChannelId: 'ch1' });
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBe('search');
  });

  it('does nothing when no channel is selected', () => {
    useChannelStore.setState({ selectedChannelId: null });
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });
});

describe('useKeyboardNavigation — Escape precedence (§5)', () => {
  it('closes the Command Palette first, leaving the ContextPanel open', () => {
    useUIStore.setState({ commandPaletteOpen: true, contextPanelMode: 'members' });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const ui = useUIStore.getState();
    expect(ui.commandPaletteOpen).toBe(false);
    // Precedence: the panel is NOT also closed in the same keystroke.
    expect(ui.contextPanelMode).toBe('members');
  });

  it('closes the ContextPanel next when the palette is already closed', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'members' });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('leaves the ContextPanel open while a modal dialog owns Escape', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'members' });
    renderHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBe('members');
    dialog.remove();
  });

  it('leaves the ContextPanel open while a transient menu owns Escape', () => {
    useUIStore.setState({ commandPaletteOpen: false, contextPanelMode: 'members' });
    renderHarness();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(useUIStore.getState().contextPanelMode).toBe('members');
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
    useChannelStore.setState({ selectedChannelId: 'ch-1' });
    useUIStore.setState({ contextPanelMode: null });
    renderHarness();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(useUIStore.getState().contextPanelMode).toBe('search');
  });
});
