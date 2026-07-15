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
      theme: 'dark',
      customCss: '',
      serverRestarting: false,
      commandPaletteOpen: false,
      contextPanelMode: null,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      sidebarCollapsed: false,
    });
  });

  it('has correct initial state', () => {
    const state = useUIStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.customCss).toBe('');
    expect(state.contextPanelMode).toBeNull();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
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

  // --- contextPanelMode: single source of truth ---

  it('setContextPanelMode drives the active mode', () => {
    useUIStore.getState().setContextPanelMode('members');
    expect(useUIStore.getState().contextPanelMode).toBe('members');

    useUIStore.getState().setContextPanelMode('threads');
    expect(useUIStore.getState().contextPanelMode).toBe('threads');

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
  });

  it('only one panel is ever open (single source of truth)', () => {
    useUIStore.getState().setContextPanelMode('members');
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    // Opening economy must replace members — never coexist
    useUIStore.getState().setContextPanelMode('economy');
    expect(useUIStore.getState().contextPanelMode).toBe('economy');
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

  it('persists sidebar geometry but not transient contextPanelMode', () => {
    useUIStore.getState().setContextPanelMode('members');
    useUIStore.getState().setSidebarWidth(360);
    useUIStore.getState().setSidebarCollapsed(true);
    const raw = localStorage.getItem('ui-storage');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string).state;
    expect(persisted.contextPanelMode).toBeUndefined();
    expect(persisted.sidebarWidth).toBe(360);
    expect(persisted.sidebarCollapsed).toBe(true);
  });
});
