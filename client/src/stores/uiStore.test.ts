import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useUIStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
} from './uiStore';
import { THEME_IDS } from '../lib/themes';

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store to defaults
    useUIStore.setState({
      theme: 'glass',
      transparency: 'system',
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
    expect(state.theme).toBe('glass');
    expect(state.transparency).toBe('system');
    expect(state.customCss).toBe('');
    expect(state.contextPanelMode).toBeNull();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('sets theme', () => {
    useUIStore.getState().setTheme('glass-contrast');
    expect(useUIStore.getState().theme).toBe('glass-contrast');
    useUIStore.getState().setTheme('glass');
    expect(useUIStore.getState().theme).toBe('glass');
  });

  it('has no accent preset, base color or message style left', () => {
    const state = useUIStore.getState() as unknown as Record<string, unknown>;
    for (const gone of ['accentPreset', 'baseHue', 'baseTint', 'setAccentPreset', 'setBaseHue', 'setBaseTint']) {
      expect(state[gone], gone).toBeUndefined();
    }
  });

  it('sets the transparency preference and persists it', () => {
    for (const value of ['reduced', 'standard', 'system'] as const) {
      useUIStore.getState().setTransparency(value);
      expect(useUIStore.getState().transparency).toBe(value);
      expect(JSON.parse(localStorage.getItem('ui-storage') as string).state.transparency).toBe(value);
    }
  });

  it('accepts every id in THEME_IDS and persists it', () => {
    for (const id of THEME_IDS) {
      useUIStore.getState().setTheme(id);
      expect(useUIStore.getState().theme).toBe(id);
      const persisted = JSON.parse(localStorage.getItem('ui-storage') as string).state;
      expect(persisted.theme).toBe(id);
    }
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
    useUIStore.getState().setContextPanelMode('pins');
    expect(useUIStore.getState().contextPanelMode).toBe('pins');

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
    useUIStore.getState().toggleContextPanelMode('pins');
    expect(useUIStore.getState().contextPanelMode).toBe('pins');
    useUIStore.getState().toggleContextPanelMode('search');
    expect(useUIStore.getState().contextPanelMode).toBe('search');
  });

  it('only one panel is ever open (single source of truth)', () => {
    useUIStore.getState().setContextPanelMode('pins');
    expect(useUIStore.getState().contextPanelMode).toBe('pins');
    // Opening economy must replace pins — never coexist
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
    useUIStore.getState().setContextPanelMode('pins');
    useUIStore.getState().setSidebarWidth(360);
    useUIStore.getState().setSidebarCollapsed(true);
    const raw = localStorage.getItem('ui-storage');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string).state;
    expect(persisted.contextPanelMode).toBeUndefined();
    expect(persisted.sidebarWidth).toBe(360);
    expect(persisted.sidebarCollapsed).toBe(true);
  });

  // --- persisted state from a build that still had the looks ---

  describe('persisted state from before Glass', () => {
    const store = () => JSON.parse(localStorage.getItem('ui-storage') as string) as {
      state: Record<string, unknown>;
      version: number;
    };

    /** Write what an older build left behind, then load it the way startup does. */
    async function load(state: Record<string, unknown>, version: number | undefined = 0) {
      localStorage.setItem('ui-storage', JSON.stringify(version === undefined ? { state } : { state, version }));
      await useUIStore.persist.rehydrate();
    }

    afterEach(() => {
      localStorage.removeItem('ui-storage');
    });

    it('opens Glass for every look an account may have chosen', async () => {
      for (const old of ['dark', 'light', 'amoled', 'dusk', 'paper', 'slate', 'voices']) {
        await load({ theme: old, motion: 'system' });
        expect(useUIStore.getState().theme, old).toBe('glass');
      }
    });

    it('keeps High contrast as High contrast', async () => {
      await load({ theme: 'high-contrast' });
      expect(useUIStore.getState().theme).toBe('glass-contrast');
    });

    it('drops the accent, the base color and the tint, and keeps what else was stored', async () => {
      await load({
        theme: 'voices',
        accentPreset: 'rose',
        baseHue: 200,
        baseTint: 0.4,
        motion: 'reduced',
        customCss: '.mine { display: block; }',
        sidebarWidth: 360,
        sidebarCollapsed: true,
        lowBandwidthMode: true,
      });

      const state = useUIStore.getState() as unknown as Record<string, unknown>;
      expect(state.theme).toBe('glass');
      expect(state.transparency).toBe('system');
      expect(state.motion).toBe('reduced');
      expect(state.customCss).toBe('.mine { display: block; }');
      expect(state.sidebarWidth).toBe(360);
      expect(state.sidebarCollapsed).toBe(true);
      expect(state.lowBandwidthMode).toBe(true);
      for (const gone of ['accentPreset', 'baseHue', 'baseTint']) expect(state[gone], gone).toBeUndefined();
    });

    it('rewrites the stored blob at the new version, without the retired fields', async () => {
      await load({ theme: 'paper', accentPreset: 'lime', baseHue: 10, baseTint: 1, motion: 'full' });
      // A change writes the blob; the migrated one is what lands.
      useUIStore.getState().setSidebarCollapsed(true);

      const written = store();
      expect(written.version).toBe(1);
      expect(written.state.theme).toBe('glass');
      expect(written.state.motion).toBe('full');
      for (const gone of ['accentPreset', 'baseHue', 'baseTint']) expect(written.state[gone], gone).toBeUndefined();
    });

    it('does not throw on values nobody understands', async () => {
      await load({ theme: 42, transparency: 'sparkly', accentPreset: {}, baseHue: 'blue' });
      expect(useUIStore.getState().theme).toBe('glass');
      expect(useUIStore.getState().transparency).toBe('system');
    });

    it('narrows a blob that carries no version number too', async () => {
      await load({ theme: 'slate', accentPreset: 'red', baseHue: 5, sidebarWidth: 333 }, undefined);
      const state = useUIStore.getState() as unknown as Record<string, unknown>;
      expect(state.theme).toBe('glass');
      expect(state.accentPreset).toBeUndefined();
      expect(state.sidebarWidth).toBe(333);
    });

    it('leaves a current blob as it is', async () => {
      await load({ theme: 'glass-contrast', transparency: 'reduced', motion: 'reduced' }, 1);
      expect(useUIStore.getState().theme).toBe('glass-contrast');
      expect(useUIStore.getState().transparency).toBe('reduced');
      expect(useUIStore.getState().motion).toBe('reduced');
    });

    it('starts on Glass when nothing was stored', async () => {
      localStorage.removeItem('ui-storage');
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().theme).toBe('glass');
      expect(useUIStore.getState().transparency).toBe('system');
    });
  });
});
