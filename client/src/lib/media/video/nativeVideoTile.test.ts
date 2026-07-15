import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeVideoTile,
  isUnderlayOccluder,
  sampleTileVisibility,
  type NativeVideoTileOptions,
} from './nativeVideoTile';

const RECT = { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 };

describe('sampleTileVisibility', () => {
  it('is visible when the tile itself is topmost at every sample point', () => {
    const tile = document.createElement('div');
    const fromPoint = vi.fn(() => tile);
    expect(sampleTileVisibility(tile, RECT, fromPoint)).toBe(true);
    // centre + 4 inset corners = 5 samples.
    expect(fromPoint).toHaveBeenCalledTimes(5);
  });

  it('is visible when a descendant of the tile is topmost', () => {
    const tile = document.createElement('div');
    const child = document.createElement('span');
    tile.appendChild(child);
    expect(sampleTileVisibility(tile, RECT, () => child)).toBe(true);
  });

  it('is visible when an ancestor is topmost (pointer-events:none tile falls through)', () => {
    // The production tile is a `pointer-events: none` <canvas>: a clear-point hit
    // falls THROUGH it to its own container, so `elementFromPoint` returns an
    // ancestor, never the canvas. That must read as visible, not occluded.
    const stage = document.createElement('div');
    const tile = document.createElement('canvas');
    stage.appendChild(tile);
    expect(sampleTileVisibility(tile, RECT, () => stage)).toBe(true);
  });

  it('is occluded when a portal sibling covers the ancestor-topmost tile', () => {
    // A foreign portal (modal) over the same container is neither the tile, a
    // descendant, nor an ancestor of it — it hides the surface.
    const stage = document.createElement('div');
    const tile = document.createElement('canvas');
    stage.appendChild(tile);
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    let call = 0;
    const fromPoint = () => (call++ === 0 ? overlay : stage);
    expect(sampleTileVisibility(tile, RECT, fromPoint)).toBe(false);
    document.body.removeChild(overlay);
  });

  it('skips off-viewport sample points instead of blanking the whole tile', () => {
    // Tile partially scrolled above the top: its inset top corners fall at
    // negative Y. With a viewport, those points are skipped (null there is not
    // treated as occlusion); the in-viewport samples still see the tile.
    const tile = document.createElement('div');
    const partiallyScrolled = { left: 100, top: -40, right: 300, bottom: 60, width: 200, height: 100 };
    const fromPoint = (_x: number, y: number) => (y < 0 ? null : tile);
    expect(
      sampleTileVisibility(tile, partiallyScrolled, fromPoint, 4, { width: 1024, height: 768 }),
    ).toBe(true);
  });

  it('is occluded when a non-descendant element is topmost at any sample', () => {
    const tile = document.createElement('div');
    const overlay = document.createElement('div');
    let call = 0;
    // Centre is covered by an unrelated overlay (e.g. a modal); corners are clear.
    const fromPoint = () => (call++ === 0 ? overlay : tile);
    expect(sampleTileVisibility(tile, RECT, fromPoint)).toBe(false);
  });

  it('is occluded when a corner is covered even if the centre is clear', () => {
    const tile = document.createElement('div');
    const overlay = document.createElement('div');
    const fromPoint = (x: number, y: number) =>
      // Top-left inset corner (near left/top) is covered by a context menu.
      x < 150 && y < 150 ? overlay : tile;
    expect(sampleTileVisibility(tile, RECT, fromPoint)).toBe(false);
  });

  it('treats a null hit (off-screen / detached) as occluded', () => {
    const tile = document.createElement('div');
    expect(sampleTileVisibility(tile, RECT, () => null)).toBe(false);
  });

  it('treats in-boundary tile chrome (sibling badge / hover bar) as non-occluding', () => {
    // The 2026-07-07 black-screen bug: StreamViewer's always-mounted,
    // hit-testable opacity-0 gradient bar sat over the top corner samples and
    // permanently reported the surface occluded. Chrome inside the declared
    // boundary must never hide the video.
    const boundary = document.createElement('div');
    const tile = document.createElement('canvas');
    const hoverBar = document.createElement('div');
    boundary.appendChild(tile);
    boundary.appendChild(hoverBar);
    const fromPoint = (_x: number, y: number) => (y < 150 ? hoverBar : boundary);
    expect(sampleTileVisibility(tile, RECT, fromPoint, 4, undefined, boundary)).toBe(true);
  });

  it('still occludes for a portal outside the boundary', () => {
    const boundary = document.createElement('div');
    const tile = document.createElement('canvas');
    boundary.appendChild(tile);
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    const fromPoint = (_x: number, y: number) => (y < 150 ? modal : boundary);
    expect(sampleTileVisibility(tile, RECT, fromPoint, 4, undefined, boundary)).toBe(false);
    document.body.removeChild(modal);
  });

  it('underlay mode ignores stage chrome and corner-only menus', () => {
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    const boundary = document.createElement('div');
    const tile = document.createElement('canvas');
    boundary.appendChild(tile);
    stage.appendChild(boundary);
    // Voice control bar: foreign, outside boundary, but NOT a portal/dialog.
    const controlBar = document.createElement('div');
    stage.appendChild(controlBar);
    const fromControlBar = (_x: number, y: number) => (y > 150 ? controlBar : boundary);
    expect(
      sampleTileVisibility(
        tile,
        RECT,
        fromControlBar,
        4,
        undefined,
        boundary,
        (el) => isUnderlayOccluder(el, boundary),
        true,
      ),
    ).toBe(true);

    // Body-portaled menu covering only a corner: must NOT blank the whole tile.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.style.position = 'fixed';
    document.body.appendChild(menu);
    const fromMenu = (_x: number, y: number) => (y < 150 ? menu : boundary);
    expect(
      sampleTileVisibility(
        tile,
        RECT,
        fromMenu,
        4,
        undefined,
        boundary,
        (el) => isUnderlayOccluder(el, boundary),
        true,
      ),
    ).toBe(true);

    // Same menu covering the centre: hide the surface (fullscreen-style occluder).
    const fromCenterMenu = (x: number, y: number) => {
      const centerX = (RECT.left + RECT.right) / 2;
      const centerY = (RECT.top + RECT.bottom) / 2;
      return x === centerX && y === centerY ? menu : boundary;
    };
    expect(
      sampleTileVisibility(
        tile,
        RECT,
        fromCenterMenu,
        4,
        undefined,
        boundary,
        (el) => isUnderlayOccluder(el, boundary),
        true,
      ),
    ).toBe(false);
    document.body.removeChild(menu);
    document.body.removeChild(stage);
  });

  it('is not visible for a zero-area rect', () => {
    const tile = document.createElement('div');
    const empty = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const fromPoint = vi.fn(() => tile);
    expect(sampleTileVisibility(tile, empty, fromPoint)).toBe(false);
    expect(fromPoint).not.toHaveBeenCalled();
  });
});

describe('isUnderlayOccluder', () => {
  it('treats stream overlay portals and dialogs as occluders', () => {
    const boundary = document.createElement('div');
    document.body.appendChild(boundary);
    const portal = document.createElement('div');
    portal.setAttribute('data-stream-overlay-portal', '');
    document.body.appendChild(portal);
    const child = document.createElement('button');
    portal.appendChild(child);
    expect(isUnderlayOccluder(child, boundary)).toBe(true);
    document.body.removeChild(portal);
    document.body.removeChild(boundary);
  });

  it('does not treat in-stage chrome as an occluder', () => {
    const stage = document.createElement('div');
    const boundary = document.createElement('div');
    const bar = document.createElement('div');
    stage.appendChild(boundary);
    stage.appendChild(bar);
    document.body.appendChild(stage);
    expect(isUnderlayOccluder(bar, boundary)).toBe(false);
    document.body.removeChild(stage);
  });

  it('does not treat tooltips or unmarked fixed body portals as occluders', () => {
    const boundary = document.createElement('div');
    document.body.appendChild(boundary);

    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.style.position = 'fixed';
    document.body.appendChild(tip);
    expect(isUnderlayOccluder(tip, boundary)).toBe(false);

    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    document.body.appendChild(toast);
    expect(isUnderlayOccluder(toast, boundary)).toBe(false);

    document.body.removeChild(tip);
    document.body.removeChild(toast);
    document.body.removeChild(boundary);
  });
});

describe('NativeVideoTile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTile(overrides: Partial<NativeVideoTileOptions> = {}) {
    const element = document.createElement('div');
    document.body.appendChild(element);
    element.getBoundingClientRect = () =>
      ({ ...RECT, x: RECT.left, y: RECT.top, toJSON: () => ({}) }) as DOMRect;
    const invoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
      if (cmd === 'native_render_attach') return { surfaceId: 7 };
      return undefined;
    });
    // Deterministic geometry + synchronous rAF via an injected window stub.
    const view = {
      devicePixelRatio: 2,
      getComputedStyle: () => ({ borderTopLeftRadius: '8px' }) as CSSStyleDeclaration,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const tile = new NativeVideoTile({
      element,
      streamId: 's1',
      trackId: 'screen',
      invoke,
      window: view,
      ...overrides,
    });
    return { tile, element, invoke, view };
  }

  it('attaches, reports physical-pixel geometry with dpr/cornerRadius, then detaches', async () => {
    const onVisibilityChange = vi.fn();
    const { tile, element, invoke } = makeTile({ onVisibilityChange });
    // jsdom does not implement elementFromPoint, so assign a stub directly
    // (vi.spyOn would throw on the missing property). Force the tile as topmost
    // so occlusion sampling reads the surface as fully visible.
    document.elementFromPoint = vi.fn(() => element) as typeof document.elementFromPoint;

    const surfaceId = await tile.attach();
    expect(surfaceId).toBe(7);

    const geomCall = invoke.mock.calls.find((c) => c[0] === 'native_render_update_geometry');
    expect(geomCall).toBeTruthy();
    const payload = geomCall?.[1] as Record<string, number | boolean>;
    // 200x100 logical @ dpr 2 => 400x200 physical, offset 200,200.
    expect(payload.width).toBe(400);
    expect(payload.height).toBe(200);
    expect(payload.x).toBe(200);
    expect(payload.y).toBe(200);
    expect(payload.dpr).toBe(2);
    expect(payload.cornerRadius).toBe(8);
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);

    tile.destroy();
    expect(invoke).toHaveBeenCalledWith('native_render_detach', { surfaceId: 7 });
  });

  it('skips a no-op geometry report', async () => {
    const { tile, element, invoke } = makeTile();
    document.elementFromPoint = vi.fn(() => element) as typeof document.elementFromPoint;
    await tile.attach();
    const geomCalls = () =>
      invoke.mock.calls.filter((c) => c[0] === 'native_render_update_geometry').length;
    const afterAttach = geomCalls();
    // A second report with identical geometry must not re-invoke the command.
    (tile as unknown as { report: () => void }).report();
    expect(geomCalls()).toBe(afterAttach);
    tile.destroy();
  });

  it('detaches immediately if destroyed before attach resolves', async () => {
    const { tile, invoke } = makeTile();
    const attachPromise = tile.attach();
    tile.destroy();
    await expect(attachPromise).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith('native_render_detach', { surfaceId: 7 });
  });

  it('reports visible despite covering stage chrome in underlay occlusion mode', async () => {
    // Underlay platforms (Linux GTK): stage chrome composites ABOVE the video
    // by design and must not hide the surface — only true overlays do.
    const { tile, element, invoke } = makeTile({ occlusion: 'underlay' });
    const stage = document.createElement('div');
    const stageChrome = document.createElement('div');
    // Re-parent the tile element under a stage sibling to the control bar.
    element.remove();
    stage.appendChild(element);
    stage.appendChild(stageChrome);
    document.body.appendChild(stage);
    document.elementFromPoint = vi.fn(() => stageChrome) as typeof document.elementFromPoint;

    await tile.attach();
    const geomCall = invoke.mock.calls.find((c) => c[0] === 'native_render_update_geometry');
    expect((geomCall?.[1] as { visible?: boolean }).visible).toBe(true);
    expect(document.elementFromPoint).toHaveBeenCalled();
    tile.destroy();
    document.body.removeChild(stage);
  });

  it('reports hidden when a body-portaled menu covers the tile centre in underlay mode', async () => {
    const onVisibilityChange = vi.fn();
    const { tile, element, invoke } = makeTile({
      occlusion: 'underlay',
      onVisibilityChange,
    });
    document.elementFromPoint = vi.fn(() => element) as typeof document.elementFromPoint;
    await tile.attach();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    const menu = document.createElement('div');
    menu.setAttribute('data-native-overlay-occlude', '');
    menu.style.position = 'fixed';
    document.body.appendChild(menu);
    // Cover every sample including centre — fullscreen-style occluder.
    document.elementFromPoint = vi.fn(() => menu) as typeof document.elementFromPoint;
    (tile as unknown as { report: () => void }).report();

    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    const lastGeom = [...invoke.mock.calls]
      .reverse()
      .find((c) => c[0] === 'native_render_update_geometry');
    expect((lastGeom?.[1] as { visible?: boolean }).visible).toBe(false);
    tile.destroy();
    document.body.removeChild(menu);
  });

  it('keeps the underlay surface live when a menu only covers a tile corner', async () => {
    const onVisibilityChange = vi.fn();
    const { tile, element, invoke } = makeTile({
      occlusion: 'underlay',
      onVisibilityChange,
    });
    document.elementFromPoint = vi.fn(() => element) as typeof document.elementFromPoint;
    await tile.attach();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    const menu = document.createElement('div');
    menu.setAttribute('data-native-overlay-occlude', '');
    menu.style.position = 'fixed';
    document.body.appendChild(menu);
    // Device picker / quality menu: only the bottom corners sit under the panel.
    document.elementFromPoint = vi.fn((x: number, y: number) => {
      const centerX = (RECT.left + RECT.right) / 2;
      const centerY = (RECT.top + RECT.bottom) / 2;
      if (x === centerX && y === centerY) return element;
      if (y > centerY) return menu;
      return element;
    }) as typeof document.elementFromPoint;
    (tile as unknown as { report: () => void }).report();

    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    const lastGeom = [...invoke.mock.calls]
      .reverse()
      .find((c) => c[0] === 'native_render_update_geometry');
    expect((lastGeom?.[1] as { visible?: boolean }).visible).toBe(true);
    tile.destroy();
    document.body.removeChild(menu);
  });

  it('reports visible despite covering DOM chrome when occlusion is disabled', async () => {
    const { tile, invoke } = makeTile({ occlusion: false });
    const foreignOverlay = document.createElement('div');
    document.body.appendChild(foreignOverlay);
    document.elementFromPoint = vi.fn(() => foreignOverlay) as typeof document.elementFromPoint;

    await tile.attach();
    const geomCall = invoke.mock.calls.find((c) => c[0] === 'native_render_update_geometry');
    expect((geomCall?.[1] as { visible?: boolean }).visible).toBe(true);
    // And the sampler was never consulted.
    expect(document.elementFromPoint).not.toHaveBeenCalled();
    tile.destroy();
    document.body.removeChild(foreignOverlay);
  });
});
