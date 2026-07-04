import { describe, it, expect, beforeEach } from 'vitest';
import {
  useUIStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
} from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store to defaults
    useUIStore.setState({
      sidebarOpen: true,
      theme: 'dark',
      customCss: '',
      serverRestarting: false,
      commandPaletteOpen: false,
      contextPanelMode: null,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      memberPanelOpen: false,
      economyPanelOpen: false,
      sidebarCollapsed: false,
      searchPanelOpen: false,
    });
  });

  it('has correct initial state', () => {
    const state = useUIStore.getState();
    expect(state.sidebarOpen).toBe(true);
    expect(state.theme).toBe('dark');
    expect(state.customCss).toBe('');
    expect(state.searchPanelOpen).toBe(false);
    expect(state.contextPanelMode).toBeNull();
    expect(state.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
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

  it('toggles member panel (open from closed default, then close)', () => {
    useUIStore.getState().toggleMemberPanel();
    expect(useUIStore.getState().memberPanelOpen).toBe(true);
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    useUIStore.getState().toggleMemberPanel();
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('toggles economy panel', () => {
    useUIStore.getState().toggleEconomyPanel();
    expect(useUIStore.getState().economyPanelOpen).toBe(true);
    expect(useUIStore.getState().contextPanelMode).toBe('economy');
    useUIStore.getState().toggleEconomyPanel();
    expect(useUIStore.getState().economyPanelOpen).toBe(false);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
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
    expect(useUIStore.getState().contextPanelMode).toBe('search');
    useUIStore.getState().toggleSearchPanel();
    expect(useUIStore.getState().searchPanelOpen).toBe(false);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('sets search panel open', () => {
    useUIStore.getState().setSearchPanelOpen(true);
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
    expect(useUIStore.getState().contextPanelMode).toBe('search');
    useUIStore.getState().setSearchPanelOpen(false);
    expect(useUIStore.getState().searchPanelOpen).toBe(false);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  // --- contextPanelMode: single source of truth ---

  it('setContextPanelMode drives the mode and mirrored booleans', () => {
    useUIStore.getState().setContextPanelMode('members');
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    expect(useUIStore.getState().memberPanelOpen).toBe(true);
    expect(useUIStore.getState().economyPanelOpen).toBe(false);
    expect(useUIStore.getState().searchPanelOpen).toBe(false);

    useUIStore.getState().setContextPanelMode('threads');
    expect(useUIStore.getState().contextPanelMode).toBe('threads');
    // threads/pins have no mirrored boolean; all three stay false
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
    expect(useUIStore.getState().economyPanelOpen).toBe(false);
    expect(useUIStore.getState().searchPanelOpen).toBe(false);

    useUIStore.getState().setContextPanelMode(null);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('toggleContextPanelMode closes when re-toggling the same mode', () => {
    useUIStore.getState().toggleContextPanelMode('pins');
    expect(useUIStore.getState().contextPanelMode).toBe('pins');
    useUIStore.getState().toggleContextPanelMode('pins');
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('toggleContextPanelMode switches directly between modes', () => {
    useUIStore.getState().toggleContextPanelMode('members');
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    useUIStore.getState().toggleContextPanelMode('search');
    expect(useUIStore.getState().contextPanelMode).toBe('search');
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
  });

  it('only one panel is ever open (single source of truth)', () => {
    useUIStore.getState().setMemberPanelOpen(true);
    expect(useUIStore.getState().memberPanelOpen).toBe(true);
    // Opening economy via the legacy adapter must close members
    useUIStore.getState().setEconomyPanelOpen(true);
    expect(useUIStore.getState().economyPanelOpen).toBe(true);
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
    expect(useUIStore.getState().contextPanelMode).toBe('economy');
  });

  it('legacy setMemberPanelOpen adapter drives contextPanelMode', () => {
    useUIStore.getState().setMemberPanelOpen(true);
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    useUIStore.getState().setMemberPanelOpen(false);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
    expect(useUIStore.getState().memberPanelOpen).toBe(false);
  });

  // --- sidebarWidth: clamp + persist ---

  it('sets sidebar width within bounds', () => {
    useUIStore.getState().setSidebarWidth(320);
    expect(useUIStore.getState().sidebarWidth).toBe(320);
  });

  it('clamps sidebar width to the token range', () => {
    useUIStore.getState().setSidebarWidth(9999);
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    useUIStore.getState().setSidebarWidth(0);
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    useUIStore.getState().setSidebarWidth(Number.NaN);
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('persists contextPanelMode, sidebarWidth and sidebarCollapsed', () => {
    useUIStore.getState().setContextPanelMode('members');
    useUIStore.getState().setSidebarWidth(360);
    useUIStore.getState().setSidebarCollapsed(true);
    const raw = localStorage.getItem('ui-storage');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string).state;
    expect(persisted.contextPanelMode).toBe('members');
    expect(persisted.sidebarWidth).toBe(360);
    expect(persisted.sidebarCollapsed).toBe(true);
  });
});
