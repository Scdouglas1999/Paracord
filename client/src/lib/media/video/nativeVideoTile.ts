/**
 * NativeVideoTile — the page's half of the desktop app's video route (spec §3.6,
 * docs/glass-spec.md §2).
 *
 * In the desktop app every remote video, and the self-view, is decoded natively
 * and drawn on a platform surface UNDER the transparent webview; the page shows
 * it through a hole. This class binds one tile's DOM box (its `<canvas>`) to its
 * surface:
 *
 * - `attach()` invokes `native_render_attach { streamId, trackId, fit, anchor? }`,
 *   creating the surface hidden at a zero rect.
 * - A single rAF-throttled reporter — fed by a ResizeObserver, an
 *   IntersectionObserver, window scroll/resize, finished CSS transitions and
 *   animations, overlay insertion, and a slow safety poll — calls
 *   `native_render_update_geometry` with the tile's physical-pixel rect, device
 *   pixel ratio, corner radius, visibility and reveal generation. No-op updates
 *   are skipped.
 * - Revealing is confirmed, never assumed. When a hidden surface is to be shown
 *   the tile raises its generation and keeps the page opaque over it until the
 *   native side reports `native_render_shown` for that generation: a frame is
 *   drawn exactly where the tile is. Only then does `onVisibilityChange(true)`
 *   open the hole. Hiding goes the other way round: the hole closes first, and
 *   the surface is hidden once the page has painted the closed tile.
 * - Covered is not paused. A tile under a dialog or a stage move hides its
 *   surface but keeps decoding (`onActiveChange` stays true), so it comes back
 *   current. Only a tile off screen or in a hidden window pauses its decoder.
 * - While its hole is closed the tile shows a poster: the latest still of the
 *   track (`readStill`, at most once a second while it is on screen, and at once
 *   when the hole closes), drawn into its own canvas with the surface's fit.
 * - `destroy()` tears the observers down and invokes `native_render_detach`.
 *
 * No frame crosses IPC on this route. The only things this file sends are
 * geometry and visibility; it reads stills (spec §0, §2).
 */

import { CENTER_ANCHOR, resolveAnchor, type ResolvedAnchor, type VideoAnchor } from './canvasRenderer';

/** Geometry payload for `native_render_update_geometry` (spec §3.6). x/y/width/
 * height are physical pixels relative to the window's client area; cornerRadius
 * stays in logical (CSS) px; visible folds intersection, document visibility and
 * occlusion together. */
export interface NativeRenderGeometry {
  surfaceId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  cornerRadius: number;
  visible: boolean;
  /** The tile shows its picture flipped left to right (the self-view camera,
   * mirrored with a CSS `scaleX(-1)` on the tile's canvas). */
  mirrored: boolean;
}

/** Minimal invoke shape so the tile is unit-testable without the Tauri runtime. */
export type TileInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface NativeVideoTileOptions {
  /** The DOM box whose geometry the native surface mirrors. */
  element: HTMLElement;
  streamId: string;
  trackId: string;
  invoke: TileInvoke;
  /** The hole over the surface may open (true: a frame is drawn in place) or
   * must close (false). Fired on changes only, starting closed. */
  onVisibilityChange?: (visible: boolean) => void;
  /** The track should be decoding (true) or may pause (false: off screen, or
   * the window is hidden). Covered tiles stay active. Fired on changes only,
   * starting from the first report. */
  onActiveChange?: (active: boolean) => void;
  /** Fired once the surface has been created on the native side. */
  onAttached?: (surfaceId: number) => void;
  /**
   * Listen for the native side's reveal confirmations of this surface
   * (`native_render_shown`). Returns the unlisten function. Without it a reveal
   * is taken as confirmed at once (tests only).
   */
  listenShown?: (surfaceId: number, onShown: (generation: number) => void) => () => void;
  /**
   * The latest still of the track, at most `maxWidth`x`maxHeight` (proportions
   * kept), or null when there is none yet. The poster is drawn from it.
   */
  readStill?: (maxWidth: number, maxHeight: number) => Promise<ImageBitmap | null>;
  /**
   * DOM-occlusion sampling (default `'underlay'`). Every backend is an
   * underlay: DOM chrome composites ABOVE the video by design, so stage chrome
   * and small body portals (tooltips, device menus covering only a corner) do
   * not hide the surface. Only a marked occluder or a dialog/menu over the
   * tile's center hides it (a stage move's shield, a sheet, a modal). `false`
   * never samples (tests).
   */
  occlusion?: false | 'underlay';
  /**
   * How the frame sits in the surface, as the canvas route's `CanvasRenderer`
   * `fit`: `contain` (the default) letterboxes, `cover` fills and crops. Fixed
   * at attach.
   */
  fit?: 'contain' | 'cover';
  /**
   * Where a `cover` crop falls, as the canvas route's `anchor` (0 keeps the
   * start of the axis, 1 the end, 0.5 the middle). Sent only with `cover`; the
   * native side refuses it for `contain`. Fixed at attach.
   */
  anchor?: VideoAnchor;
  /** Injectable window for tests; defaults to the element's own view. */
  window?: Window;
}

/** Inset (logical px) from each corner at which occlusion is sampled, so a 1-px
 * anti-aliased border never reads as an occluder. */
const OCCLUSION_INSET = 4;

/**
 * True when `el` is a floating overlay that may hide a Linux underlay surface
 * (only when it also covers the tile center — see {@link sampleTileVisibility}).
 *
 * Stage chrome (voice control bar, side panels) is excluded — underlay
 * composites that ABOVE the video. Ephemeral hover chrome (`role="tooltip"`)
 * is also excluded: treating every fixed body portal as an occluder caused
 * tooltip hover to flip GL visibility, and the visibility-flip underlay
 * repaint glued Mute/Deafen/… labels into the live stream.
 *
 * Only explicitly marked overlays and dialog/menu roles count. Arbitrary
 * fixed/absolute body children (tooltips, toasts) do not. A stage move's
 * shield is marked `data-native-shield` (not `data-native-overlay-occlude`,
 * which layout.css paints solid).
 */
export function isUnderlayOccluder(el: Element, boundary: Element): boolean {
  if (boundary.contains(el)) {
    return false;
  }
  // Hover labels must never participate in underlay blanking.
  if (el.closest('[role="tooltip"]')) {
    return false;
  }
  const marked = el.closest(
    [
      '[data-native-shield]',
      '[data-stream-overlay-portal]',
      '[data-native-overlay-occlude]',
      '[aria-modal="true"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="tree"]',
    ].join(', '),
  );
  return Boolean(marked && !boundary.contains(marked));
}

/**
 * Occlusion test (spec §3.6): sample `elementFromPoint` at the tile center and
 * four inset corners. If a FOREIGN element is topmost at any sample, the tile is
 * occluded — return `false` (not visible). This deterministically hides the
 * native surface behind any modal, popover, or context menu drawn over the video
 * (accepted, documented UX).
 *
 * The tile binds to a `pointer-events: none` <canvas> in production, so a hit at
 * a clear sample point falls THROUGH the tile to an ancestor (its own stage
 * container) — `elementFromPoint` never returns the pointer-transparent canvas
 * itself. That ancestor hit is NOT occlusion: the tile itself, any descendant of
 * it, and any ancestor that contains it are all treated as non-occluding. Only a
 * sibling/portal element that is none of these reports the surface hidden.
 *
 * `boundary` widens the non-occluding set to the tile's OWN chrome: everything
 * inside the boundary subtree (the stream-tile root marked with
 * `data-native-surface-boundary`) is part of the tile — name badges, hover
 * control bars, posters — and must never hide the video (the 2026-07-07
 * black-screen bug: a hit-testable opacity-0 gradient bar and a corner badge
 * permanently reported the surface occluded). Only elements OUTSIDE the
 * boundary — true modals, popovers, context menus, panels portalled over the
 * tile — count as occluders. Note the z-order consequence (spec §3.3): in-tile
 * chrome does not hide the surface, so it renders BEHIND the native video;
 * interactive chrome stays clickable via input passthrough.
 *
 * `isOccluder` (optional) further restricts which foreign elements count —
 * underlay backends pass {@link isUnderlayOccluder} so the voice control bar
 * does not blank the stream.
 *
 * `centerOnlyOcclusion` (underlay): a foreign occluder only hides the surface
 * when it covers the tile *center*. Corner-only hits from a device picker /
 * quality menu / tooltip must keep the GL surface live — blanking the whole
 * tile for a small bottom menu was the 2026-07-12 black-stream regression.
 *
 * `viewport` (optional) bounds the hit-testable area: a sample point scrolled
 * past a window edge has no pixel to hit (`elementFromPoint` returns null there),
 * so such points are skipped rather than blanking the whole surface — the
 * IntersectionObserver owns the fully-off-screen case.
 *
 * Pure and side-effect-free so it can be unit-tested with jsdom mocks.
 */
export function sampleTileVisibility(
  element: Element,
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  elementFromPoint: (x: number, y: number) => Element | null,
  inset: number = OCCLUSION_INSET,
  viewport?: { width: number; height: number },
  boundary: Element = element,
  isOccluder?: (topmost: Element) => boolean,
  centerOnlyOcclusion = false,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const clampInset = Math.min(inset, rect.width / 2, rect.height / 2);
  const left = rect.left + clampInset;
  const right = rect.right - clampInset;
  const top = rect.top + clampInset;
  const bottom = rect.bottom - clampInset;
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const samples: Array<[number, number]> = [
    [centerX, centerY],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
  for (const [x, y] of samples) {
    // A sample point scrolled past the viewport edge has no hit-testable pixel;
    // skip it so a tile partially scrolled off-screen still renders its visible
    // portion, and let the IntersectionObserver own the fully-off-screen case.
    if (viewport && (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)) {
      continue;
    }
    const topmost = elementFromPoint(x, y);
    // Nothing at an in-viewport point (a hole / detached) counts as occluded:
    // there is no visible tile pixel there to render onto.
    if (!topmost) {
      return false;
    }
    // Occluded only when a foreign element sits on top: not the tile, not a
    // descendant of it, not an ancestor that contains it (a fall-through hit on
    // the pointer-transparent tile's own container), and not tile chrome inside
    // the boundary subtree.
    if (
      topmost !== element &&
      !element.contains(topmost) &&
      !topmost.contains(element) &&
      !boundary.contains(topmost)
    ) {
      if (isOccluder && !isOccluder(topmost)) {
        continue;
      }
      if (centerOnlyOcclusion) {
        const isCenter = x === centerX && y === centerY;
        if (!isCenter) {
          // Small menu covering only a corner — keep the stream live.
          continue;
        }
      }
      return false;
    }
  }
  return true;
}

function parseCornerRadius(element: HTMLElement, view: Window | null): number {
  if (!view || typeof view.getComputedStyle !== 'function') {
    return 0;
  }
  const raw = view.getComputedStyle(element).borderTopLeftRadius;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Whether the element's own transform flips it left to right (`scaleX(-1)`,
 * read from the computed `matrix(a, b, c, d, e, f)`: a < 0). */
export function isMirrored(element: HTMLElement, view: Window | null): boolean {
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  const transform = view.getComputedStyle(element).transform;
  if (!transform || transform === 'none') return false;
  const match = /^matrix(?:3d)?\(([^,]+)/.exec(transform);
  if (!match) return false;
  const a = Number.parseFloat(match[1]);
  return Number.isFinite(a) && a < 0;
}

/** How often a tile on screen refreshes its poster, ms. */
export const POSTER_REFRESH_MS = 1000;
/** How often a tile re-measures itself with nothing else telling it to, ms. */
const SAFETY_POLL_MS = 1000;
/** The biggest poster a tile asks for, each way, physical px. */
const POSTER_MAX_WIDTH = 1280;
const POSTER_MAX_HEIGHT = 720;

/**
 * Where a still of `srcW`x`srcH` goes in a `dstW`x`dstH` box under `fit`, as
 * the surface draws it (`SurfaceFit::uv_window` on the native side): contain
 * fits it whole and centered, cover fills the box and crops around `anchor`.
 */
export function posterPlacement(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  fit: 'contain' | 'cover',
  anchor: ResolvedAnchor,
): { x: number; y: number; width: number; height: number } {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { x: 0, y: 0, width: dstW, height: dstH };
  const scale = fit === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  const ax = fit === 'cover' ? anchor.x : 0.5;
  const ay = fit === 'cover' ? anchor.y : 0.5;
  return { x: (dstW - width) * ax, y: (dstH - height) * ay, width, height };
}

export class NativeVideoTile {
  private readonly element: HTMLElement;
  private readonly streamId: string;
  private readonly trackId: string;
  private readonly invoke: TileInvoke;
  private readonly onVisibilityChange?: (visible: boolean) => void;
  private readonly onActiveChange?: (active: boolean) => void;
  private readonly onAttached?: (surfaceId: number) => void;
  private readonly listenShown?: (surfaceId: number, onShown: (generation: number) => void) => () => void;
  private readonly readStill?: (maxWidth: number, maxHeight: number) => Promise<ImageBitmap | null>;
  private readonly occlusion: false | 'underlay';
  private readonly fit: 'contain' | 'cover';
  private readonly anchor: ResolvedAnchor | null;
  private readonly view: Window | null;
  /** The occlusion boundary: the nearest ancestor marked
   * `data-native-surface-boundary` (the stream-tile root wrapping the canvas
   * AND its chrome), or the tile element itself when unmarked. */
  private readonly boundary: Element;

  private surfaceId: number | null = null;
  private destroyed = false;
  private intersecting = true;
  private rafHandle: number | null = null;
  private lastReported: NativeRenderGeometry | null = null;
  /** What the native side was last told: the surface is shown. */
  private surfaceShown = false;
  /** The hole is open (the page was told `onVisibilityChange(true)`). */
  private holeOpen = false;
  private generation = 0;
  /** The reveal generation waiting for its confirmation, if any. */
  private awaiting: number | null = null;
  private active: boolean | null = null;
  /** A pending hide of the surface, after the page painted the closed hole:
   * the rAF handles it is waiting on. */
  private pendingHide: { handles: number[] } | null = null;
  private unlistenShown: (() => void) | null = null;
  private posterTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private posterInFlight = false;
  private hasPoster = false;

  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly onScrollOrResize = () => this.scheduleReport();
  private readonly onDocVisibility = () => this.scheduleReport();
  private readonly onLayoutSettled = () => this.scheduleReport();
  private readonly onUnderlayHoleReady = () => {
    this.lastReported = null;
    this.scheduleReport();
  };
  private readonly onUnderlayRepaint = () => {
    this.lastReported = null;
    this.scheduleReport();
  };

  constructor(options: NativeVideoTileOptions) {
    this.element = options.element;
    this.streamId = options.streamId;
    this.trackId = options.trackId;
    this.invoke = options.invoke;
    this.onVisibilityChange = options.onVisibilityChange;
    this.onActiveChange = options.onActiveChange;
    this.onAttached = options.onAttached;
    this.listenShown = options.listenShown;
    this.readStill = options.readStill;
    this.occlusion = options.occlusion ?? 'underlay';
    this.fit = options.fit ?? 'contain';
    // Read here, so a bad anchor fails at construction and not in the native
    // command; and only for a fit that crops (the canvas route ignores it too).
    this.anchor = this.fit === 'cover' && options.anchor ? resolveAnchor(options.anchor) : null;
    this.view =
      options.window ?? this.element.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    this.boundary =
      (typeof this.element.closest === 'function'
        ? this.element.closest('[data-native-surface-boundary]')
        : null) ?? this.element;
  }

  /**
   * Create the native surface and start reporting geometry. Rejects (and does not
   * leave observers wired) if the native side cannot create a surface — the
   * caller surfaces that as a loud subscription error (spec §3.7). There is no
   * other route.
   */
  async attach(): Promise<number> {
    const result = (await this.invoke('native_render_attach', {
      streamId: this.streamId,
      trackId: this.trackId,
      fit: this.fit,
      ...(this.anchor ? { anchor: this.anchor } : {}),
    })) as { surfaceId?: number } | null;
    const surfaceId = Number(result?.surfaceId);
    if (!Number.isFinite(surfaceId)) {
      throw new Error('native_render_attach did not return a surfaceId');
    }
    if (this.destroyed) {
      // Torn down while the attach was in flight — detach immediately and bail.
      void this.invoke('native_render_detach', { surfaceId }).catch(() => {});
      throw new Error('native video tile destroyed before attach completed');
    }
    this.surfaceId = surfaceId;
    this.unlistenShown = this.listenShown?.(surfaceId, (generation) => this.confirmShown(generation)) ?? null;
    this.onAttached?.(surfaceId);
    this.startObservers();
    this.scheduleReport();
    return surfaceId;
  }

  /** Whether the hole over the surface is open (for tests and diagnostics). */
  get revealed(): boolean {
    return this.holeOpen;
  }

  /** Fetch a poster now (the first frame was presented, for one). */
  refreshPoster(): void {
    void this.drawPoster();
  }

  private startObservers(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleReport());
      this.resizeObserver.observe(this.element);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          this.intersecting = entries.some(
            (entry) => entry.isIntersecting && entry.intersectionRatio > 0,
          );
          this.scheduleReport();
        },
        { threshold: 0 },
      );
      this.intersectionObserver.observe(this.element);
    }
    // Capture-phase scroll catches scrolling in any ancestor, not just window.
    this.view?.addEventListener('scroll', this.onScrollOrResize, true);
    this.view?.addEventListener('resize', this.onScrollOrResize);
    // A box can move without resizing (a pane sliding in beside it, a banner
    // above it): CSS transitions and animations say when they are done.
    this.view?.addEventListener('transitionend', this.onLayoutSettled, true);
    this.view?.addEventListener('animationend', this.onLayoutSettled, true);
    const doc = this.element.ownerDocument;
    doc?.addEventListener('visibilitychange', this.onDocVisibility);
    this.element.addEventListener('paracord:native-underlay-hole-ready', this.onUnderlayHoleReady);
    this.view?.addEventListener('paracord:native-underlay-repaint', this.onUnderlayRepaint);
    // Pure z-order occlusion (a modal / popover / context menu portalled over the
    // tile, a stage move's shield) changes none of the above signals: the tile
    // does not resize, its viewport intersection is unchanged, and nothing
    // scrolls. Watch for overlay insertion/removal at the document body — where
    // such portals mount — and re-sample occlusion (spec §3.6).
    if (typeof MutationObserver !== 'undefined' && doc?.body && this.occlusion !== false) {
      this.mutationObserver = new MutationObserver(() => this.scheduleReport());
      this.mutationObserver.observe(doc.body, { childList: true, subtree: true });
    }
    // Whatever moved the box without any of the above noticing is caught here,
    // within a second; it costs one measurement.
    this.pollTimer = setInterval(() => this.scheduleReport(), SAFETY_POLL_MS);
    if (this.readStill) {
      this.posterTimer = setInterval(() => {
        if (this.active !== false) void this.drawPoster();
      }, POSTER_REFRESH_MS);
    }
  }

  private scheduleReport(): void {
    if (this.destroyed || this.surfaceId == null) {
      return;
    }
    if (this.rafHandle != null) {
      return;
    }
    const raf = this.view?.requestAnimationFrame?.bind(this.view);
    if (raf) {
      this.rafHandle = raf(() => {
        this.rafHandle = null;
        this.report();
      });
    } else {
      // No rAF (e.g. headless): report synchronously so state never stalls.
      this.report();
    }
  }

  private measure(surfaceId: number): { geometry: NativeRenderGeometry; onScreen: boolean; uncovered: boolean } {
    const rect = this.element.getBoundingClientRect();
    const dpr = Math.max(1, this.view?.devicePixelRatio || 1);
    const width = Math.max(0, Math.round(rect.width * dpr));
    const height = Math.max(0, Math.round(rect.height * dpr));
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    // The canvas fills its tile, whose rounded box clips it in the page; the
    // surface has to round itself the same way.
    const cornerRadius =
      parseCornerRadius(this.element, this.view) ||
      (this.boundary instanceof HTMLElement ? parseCornerRadius(this.boundary, this.view) : 0);
    const mirrored = isMirrored(this.element, this.view);
    const doc = this.element.ownerDocument;
    const docVisible = !doc || doc.visibilityState !== 'hidden';
    const viewport =
      this.view &&
      typeof this.view.innerWidth === 'number' &&
      typeof this.view.innerHeight === 'number'
        ? { width: this.view.innerWidth, height: this.view.innerHeight }
        : undefined;
    const uncovered =
      this.occlusion !== false && doc && typeof doc.elementFromPoint === 'function'
        ? sampleTileVisibility(
            this.element,
            rect,
            (px, py) => doc.elementFromPoint(px, py),
            OCCLUSION_INSET,
            viewport,
            this.boundary,
            (topmost) => isUnderlayOccluder(topmost, this.boundary),
            true,
          )
        : true;
    const onScreen = this.intersecting && docVisible && width > 0 && height > 0;
    return {
      geometry: { surfaceId, x, y, width, height, dpr, cornerRadius, visible: onScreen && uncovered, mirrored },
      onScreen,
      uncovered,
    };
  }

  private geometryEquals(a: NativeRenderGeometry | null, b: NativeRenderGeometry): boolean {
    return (
      a != null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height &&
      a.dpr === b.dpr &&
      a.cornerRadius === b.cornerRadius &&
      a.visible === b.visible &&
      a.mirrored === b.mirrored
    );
  }

  private send(geometry: NativeRenderGeometry): void {
    this.lastReported = geometry;
    void this.invoke('native_render_update_geometry', {
      surfaceId: geometry.surfaceId,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      dpr: geometry.dpr,
      cornerRadius: geometry.cornerRadius,
      visible: geometry.visible,
      generation: this.generation,
      mirrored: geometry.mirrored,
    }).catch(() => {});
  }

  private setHole(open: boolean): void {
    if (this.holeOpen === open) return;
    this.holeOpen = open;
    this.onVisibilityChange?.(open);
    if (!open) void this.drawPoster();
  }

  private cancelPendingHide(): void {
    const pending = this.pendingHide;
    this.pendingHide = null;
    for (const handle of pending?.handles ?? []) this.view?.cancelAnimationFrame?.(handle);
  }

  private report(): void {
    if (this.destroyed || this.surfaceId == null) {
      return;
    }
    const { geometry, onScreen } = this.measure(this.surfaceId);
    if (this.active !== onScreen) {
      this.active = onScreen;
      this.onActiveChange?.(onScreen);
    }

    if (geometry.visible) {
      this.cancelPendingHide();
      if (!this.surfaceShown) {
        // A reveal: a new generation, confirmed by the native side once it has
        // drawn a frame here. The hole stays closed (the poster up) until then.
        this.surfaceShown = true;
        this.generation += 1;
        this.awaiting = this.generation;
        this.send(geometry);
        if (!this.listenShown) this.confirmShown(this.generation);
        return;
      }
      if (!this.geometryEquals(this.lastReported, geometry)) this.send(geometry);
      return;
    }

    // Hidden: close the hole first, and hide the surface only once the page has
    // painted the closed tile (two frames), so nothing ever shows through a
    // hole with no video under it.
    this.awaiting = null;
    this.setHole(false);
    if (!this.surfaceShown) {
      this.lastReported = geometry;
      return;
    }
    if (this.pendingHide) return;
    const raf = this.view?.requestAnimationFrame?.bind(this.view);
    const pending: { handles: number[] } = { handles: [] };
    this.pendingHide = pending;
    const hide = () => {
      if (this.pendingHide !== pending) return;
      this.pendingHide = null;
      if (this.destroyed || this.surfaceId == null) return;
      const now = this.measure(this.surfaceId).geometry;
      if (now.visible) {
        // Shown again before it went: reveal it afresh (the hole closed).
        this.surfaceShown = false;
        this.scheduleReport();
        return;
      }
      this.surfaceShown = false;
      this.send(now);
    };
    if (!raf) {
      hide();
      return;
    }
    pending.handles.push(
      raf(() => {
        if (this.pendingHide === pending) pending.handles.push(raf(hide));
      }),
    );
  }

  private confirmShown(generation: number): void {
    if (this.destroyed || generation !== this.awaiting || !this.surfaceShown) return;
    this.awaiting = null;
    this.setHole(true);
  }

  private async drawPoster(): Promise<void> {
    const canvas = this.element;
    if (!this.readStill || this.destroyed || this.posterInFlight) return;
    if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, this.view?.devicePixelRatio || 1);
    const boxW = Math.max(1, Math.round(rect.width * dpr));
    const boxH = Math.max(1, Math.round(rect.height * dpr));
    if (rect.width <= 0 || rect.height <= 0) return;
    this.posterInFlight = true;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await this.readStill(Math.min(boxW, POSTER_MAX_WIDTH), Math.min(boxH, POSTER_MAX_HEIGHT));
      if (!bitmap || this.destroyed) return;
      // The poster stands in for the surface: the same fit, the same crop, and
      // the black the surface draws where a contained frame leaves room.
      const scale = Math.min(1, POSTER_MAX_WIDTH / boxW, POSTER_MAX_HEIGHT / boxH);
      const w = Math.max(1, Math.round(boxW * scale));
      const h = Math.max(1, Math.round(boxH * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const context = canvas.getContext('2d');
      if (!context) return;
      const at = posterPlacement(bitmap.width, bitmap.height, w, h, this.fit, this.anchor ?? CENTER_ANCHOR);
      context.fillStyle = '#000';
      context.fillRect(0, 0, w, h);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, at.x, at.y, at.width, at.height);
      if (!this.hasPoster) {
        this.hasPoster = true;
        canvas.dataset.poster = 'true';
      }
    } catch (error) {
      console.error('[media] the native video poster could not be read', {
        streamId: this.streamId,
        trackId: this.trackId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      bitmap?.close();
      this.posterInFlight = false;
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.rafHandle != null) {
      this.view?.cancelAnimationFrame?.(this.rafHandle);
      this.rafHandle = null;
    }
    this.cancelPendingHide();
    if (this.posterTimer) clearInterval(this.posterTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.posterTimer = null;
    this.pollTimer = null;
    this.unlistenShown?.();
    this.unlistenShown = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.view?.removeEventListener('scroll', this.onScrollOrResize, true);
    this.view?.removeEventListener('resize', this.onScrollOrResize);
    this.view?.removeEventListener('transitionend', this.onLayoutSettled, true);
    this.view?.removeEventListener('animationend', this.onLayoutSettled, true);
    this.element.ownerDocument?.removeEventListener('visibilitychange', this.onDocVisibility);
    this.element.removeEventListener(
      'paracord:native-underlay-hole-ready',
      this.onUnderlayHoleReady,
    );
    this.view?.removeEventListener('paracord:native-underlay-repaint', this.onUnderlayRepaint);
    if (this.holeOpen) {
      this.holeOpen = false;
      this.onVisibilityChange?.(false);
    }
    if (this.hasPoster && this.element instanceof HTMLElement) delete this.element.dataset.poster;
    const surfaceId = this.surfaceId;
    this.surfaceId = null;
    if (surfaceId != null) {
      void this.invoke('native_render_detach', { surfaceId }).catch(() => {});
    }
  }
}
