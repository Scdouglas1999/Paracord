/**
 * NativeVideoTile — the TS half of the native-surface render route (spec §3.6).
 *
 * For a `native-surface` subscription (the functional WebCodecs probe failed for
 * the track's codec, so nothing but geometry/stats crosses IPC — spec §2), this
 * class mounts in exactly the place a {@link CanvasRenderer} would: it binds to
 * the tile's DOM box (the same element the webview would paint into) and mirrors
 * that box to a native platform surface the decode worker renders into.
 *
 * Lifecycle:
 * - `attach()` invokes `native_render_attach { streamId, trackId } -> { surfaceId }`,
 *   creating the surface (hidden, at a zero rect) and flipping the subscription's
 *   route bookkeeping on the native side.
 * - A single rAF-throttled reporter — fed by a ResizeObserver, an
 *   IntersectionObserver, and window scroll/resize — calls
 *   `native_render_update_geometry` with the tile's physical-pixel rect, device
 *   pixel ratio, computed corner radius, and visibility. No-op updates are
 *   skipped so a still tile never spams IPC.
 * - `destroy()` tears the observers down and invokes `native_render_detach`.
 *
 * Raw frames never cross IPC on this route — the native side owns delivery. The
 * only things this file sends are geometry and visibility (spec §0, §2).
 */

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
}

/** Minimal invoke shape so the tile is unit-testable without the Tauri runtime. */
export type TileInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface NativeVideoTileOptions {
  /** The DOM box whose geometry the native surface mirrors. */
  element: HTMLElement;
  streamId: string;
  trackId: string;
  invoke: TileInvoke;
  /** Fired on the first report and whenever the computed visibility changes, so
   * the subscription can drive `media_set_stream_visibility` (decode pause) and
   * the poster/backdrop UI. */
  onVisibilityChange?: (visible: boolean) => void;
  /** Fired once the surface has been created on the native side. */
  onAttached?: (surfaceId: number) => void;
  /**
   * DOM-occlusion sampling mode (default `true` / full).
   *
   * - `true`: any foreign topmost element hides the surface (overlay backends
   *   such as macOS, where the native surface floats ABOVE the webview).
   * - `false`: never sample occlusion.
   * - `'underlay'`: Linux GTK underlay — DOM chrome composites ABOVE the video
   *   by design. Stage chrome and small body portals (tooltips, device menus
   *   covering only a corner) must NOT hide the GL surface (hiding blanks the
   *   whole tile and `queue_underlay_repaint` on visibility flips glued hover
   *   chrome into the stream). Only a true center-covering occluder (e.g. a
   *   fullscreen modal) hides the surface.
   */
  occlusion?: boolean | 'underlay';
  /** Injectable window for tests; defaults to the element's own view. */
  window?: Window;
}

/** Inset (logical px) from each corner at which occlusion is sampled, so a 1-px
 * anti-aliased border never reads as an occluder. */
const OCCLUSION_INSET = 4;

/**
 * True when `el` is a floating overlay that may hide a Linux underlay surface
 * (only when it also covers the tile centre — see {@link sampleTileVisibility}).
 *
 * Stage chrome (voice control bar, side panels) is excluded — underlay
 * composites that ABOVE the video. Ephemeral hover chrome (`role="tooltip"`)
 * is also excluded: treating every fixed body portal as an occluder caused
 * tooltip hover to flip GL visibility, and the visibility-flip underlay
 * repaint glued Mute/Deafen/… labels into the live stream.
 *
 * Only explicitly marked overlays and dialog/menu roles count. Arbitrary
 * fixed/absolute body children (tooltips, toasts) do not.
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
 * Occlusion test (spec §3.6): sample `elementFromPoint` at the tile centre and
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
 * when it covers the tile *centre*. Corner-only hits from a device picker /
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

export class NativeVideoTile {
  private readonly element: HTMLElement;
  private readonly streamId: string;
  private readonly trackId: string;
  private readonly invoke: TileInvoke;
  private readonly onVisibilityChange?: (visible: boolean) => void;
  private readonly onAttached?: (surfaceId: number) => void;
  private readonly occlusion: boolean | 'underlay';
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
  private lastVisible: boolean | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly onScrollOrResize = () => this.scheduleReport();
  private readonly onDocVisibility = () => this.scheduleReport();
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
    this.onAttached = options.onAttached;
    this.occlusion = options.occlusion ?? true;
    this.view =
      options.window ?? this.element.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    this.boundary =
      (typeof this.element.closest === 'function'
        ? this.element.closest('[data-native-surface-boundary]')
        : null) ?? this.element;
  }

  /**
   * Create the native surface and start reporting geometry. Rejects (and does not
   * leave observers wired) if the native side cannot create a surface for this
   * platform — the caller surfaces that as a loud subscription error (spec §3.7),
   * never a raw-IPC fallback.
   */
  async attach(): Promise<number> {
    const result = (await this.invoke('native_render_attach', {
      streamId: this.streamId,
      trackId: this.trackId,
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
    this.onAttached?.(surfaceId);
    this.startObservers();
    this.scheduleReport();
    return surfaceId;
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
    const doc = this.element.ownerDocument;
    doc?.addEventListener('visibilitychange', this.onDocVisibility);
    this.element.addEventListener('paracord:native-underlay-hole-ready', this.onUnderlayHoleReady);
    this.view?.addEventListener('paracord:native-underlay-repaint', this.onUnderlayRepaint);
    // Pure z-order occlusion (a modal / popover / context menu portalled over the
    // tile) changes none of the above signals: the tile does not resize, its
    // viewport intersection is unchanged, and nothing scrolls. Watch for overlay
    // insertion/removal at the document body — where such portals mount — and
    // re-sample occlusion so the native surface hides behind them (spec §3.6).
    // subtree:true catches portals nested under an existing body child (e.g.
    // AnimatePresence wrappers) without relying on a second mount tick.
    if (typeof MutationObserver !== 'undefined' && doc?.body && this.occlusion !== false) {
      this.mutationObserver = new MutationObserver(() => this.scheduleReport());
      this.mutationObserver.observe(doc.body, { childList: true, subtree: true });
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

  private computeGeometry(surfaceId: number): NativeRenderGeometry {
    const rect = this.element.getBoundingClientRect();
    const dpr = Math.max(1, this.view?.devicePixelRatio || 1);
    const width = Math.max(0, Math.round(rect.width * dpr));
    const height = Math.max(0, Math.round(rect.height * dpr));
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    const cornerRadius = parseCornerRadius(this.element, this.view);
    const doc = this.element.ownerDocument;
    const docVisible = !doc || doc.visibilityState !== 'hidden';
    const viewport =
      this.view &&
      typeof this.view.innerWidth === 'number' &&
      typeof this.view.innerHeight === 'number'
        ? { width: this.view.innerWidth, height: this.view.innerHeight }
        : undefined;
    const underlay = this.occlusion === 'underlay';
    const notOccluded =
      this.occlusion !== false && doc && typeof doc.elementFromPoint === 'function'
        ? sampleTileVisibility(
            this.element,
            rect,
            (px, py) => doc.elementFromPoint(px, py),
            OCCLUSION_INSET,
            viewport,
            this.boundary,
            underlay ? (topmost) => isUnderlayOccluder(topmost, this.boundary) : undefined,
            underlay,
          )
        : true;
    const visible = this.intersecting && docVisible && notOccluded && width > 0 && height > 0;
    return { surfaceId, x, y, width, height, dpr, cornerRadius, visible };
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
      a.visible === b.visible
    );
  }

  private report(): void {
    if (this.destroyed || this.surfaceId == null) {
      return;
    }
    const geometry = this.computeGeometry(this.surfaceId);
    if (this.lastVisible !== geometry.visible) {
      this.lastVisible = geometry.visible;
      this.onVisibilityChange?.(geometry.visible);
    }
    if (this.geometryEquals(this.lastReported, geometry)) {
      return;
    }
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
    }).catch(() => {});
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.view?.removeEventListener('scroll', this.onScrollOrResize, true);
    this.view?.removeEventListener('resize', this.onScrollOrResize);
    this.element.ownerDocument?.removeEventListener('visibilitychange', this.onDocVisibility);
    this.element.removeEventListener(
      'paracord:native-underlay-hole-ready',
      this.onUnderlayHoleReady,
    );
    this.view?.removeEventListener('paracord:native-underlay-repaint', this.onUnderlayRepaint);
    const surfaceId = this.surfaceId;
    this.surfaceId = null;
    if (surfaceId != null) {
      void this.invoke('native_render_detach', { surfaceId }).catch(() => {});
    }
  }
}
