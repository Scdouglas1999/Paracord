import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store to defaults
    useUIStore.setState({
      sidebarOpen: true,
      theme: 'dark',
      customCss: '',
      compactMode: false,
      serverRestarting: false,
      commandPaletteOpen: false,
      memberPanelOpen: true,
      sidebarCollapsed: false,
      searchPanelOpen: false,
    });
  });

  it('has correct initial state', () => {
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.theme).toBe('dark');
    expect(state.customCss).toBe('');
    expect(state.compactMode).toBe(false);
    expect(state.searchPanelOpen).toBe(false);
  });

  it('toggles sidebar', () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('sets theme', () => {
    useUIStore.getState().setTheme('light');
    expect(useUIStore.getState().theme).toBe('light');
    useUIStore.getState().setTheme('amoled');
    expect(useUIStore.getState().theme).toBe('amoled');
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });

  it('sets custom CSS', () => {
    useUIStore.getState().setCustomCss('.test { color: red; }');
    expect(useUIStore.getState().customCss).toBe('.test { color: red; }');
  });

  it('sets compact mode', () => {
    useUIStore.getState().setCompactMode(true);
    expect(useUIStore.getState().compactMode).toBe(true);
    useUIStore.getState().setCompactMode(false);
    expect(useUIStore.getState().compactMode).toBe(false);
  });

  it('sets server restarting', () => {
    useUIStore.getState().setServerRestarting(true);
    expect(useUIStore.getState().serverRestarting).toBe(true);
    useUIStore.getState().setServerRestarting(false);
    expect(useUIStore.getState().serverRestarting).toBe(false);
  });

  it('toggles command palette', () => {
    useUIStore.getState().toggleCommandPalette();
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
    useUIStore.getState().toggleCommandPalette();
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it('sets command palette open', () => {
    useUIStore.getState().setCommandPaletteOpen(true);
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
    useUIStore.getState().setCommandPaletteOpen(false);
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it('toggles member panel', () => {
    useUIStore.getState().toggleMemberPanel();
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
    useUIStore.getState().toggleMemberPanel();
    expect(useUIStore.getState().memberPanelOpen).toBe(true);
  });

  it('toggles sidebar collapsed', () => {
    useUIStore.getState().toggleSidebarCollapsed();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebarCollapsed();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('sets sidebar collapsed', () => {
    useUIStore.getState().setSidebarCollapsed(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().setSidebarCollapsed(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggles search panel', () => {
    useUIStore.getState().toggleSearchPanel();
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
    useUIStore.getState().toggleSearchPanel();
    expect(useUIStore.getState().searchPanelOpen).toBe(false);
  });

  it('sets search panel open', () => {
    useUIStore.getState().setSearchPanelOpen(true);
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
    useUIStore.getState().setSearchPanelOpen(false);
    expect(useUIStore.getState().searchPanelOpen).toBe(false);
  });
});
