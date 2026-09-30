/**
 * The room controller (docs/glass-spec.md §4): one frame source in, two
 * canvases and one custom property out.
 *
 *   source (≤ 4 Hz ImageBitmaps)
 *     └─ analyze: 32x18 grid, blurred and graded in the pixels; room color, clamped
 *         ├─ backdrop: the lit layer's grid eases toward each new grid, painted
 *         │  at most 4 times a second, only while it is still moving
 *         └─ token: the room color eases the same way and is offered to the
 *            token writer, which writes `--room-rgb` at most 4 times a second
 *
 * Changing source (another server, a stream starting, the stage opening) is a
 * crossfade: the incoming source paints the OTHER layer and, once its first
 * frame is in, the two layers swap `data-lit` and CSS fades their opacity over
 * 1.2 s. The outgoing layer is held until then, for at most
 * {@link ROOM_HOLD_MS}; a source that has not delivered by then lets the room
 * go dark and says so (`phase: 'waiting'`) rather than keep another server's
 * light on.
 *
 * Nothing here writes a style per frame: the canvases are painted with
 * `putImageData`, the crossfade is an attribute, and the token goes through the
 * writer's budget.
 */
import {
  channelDistance,
  clampRoomColor,
  easeFactor,
  easeRgb,
  ROOM_NEUTRAL,
  type Rgb,
} from './color';
import type { FrameAnalyzer } from './analyzeFrame';
import type { FrameSource } from './frameSource';
import {
  ROOM_BLUR_SIGMA,
  ROOM_GRID_HEIGHT,
  ROOM_GRID_WIDTH,
  STILL_GRADE,
  STREAM_GRADE,
  type RoomAnalysis,
} from './pixels';
import { realClock, type RoomTokenWriter, type TokenWriterClock } from './tokenWriter';

/** The easing time constant: a change is 95% done after about 1.8 s. */
export const ROOM_EASE_TAU_MS = 600;
/** How often the room steps while it is still easing (canvas and token). */
export const ROOM_TICK_HZ = 4;
export const ROOM_TICK_MS = 1000 / ROOM_TICK_HZ;
/** How long the outgoing room stays lit while the incoming source finds its first frame. */
export const ROOM_HOLD_MS = 1000;
/** Below this (channel units) a grid or color counts as arrived. */
const SETTLE_EPSILON = 0.5;

/** One of the two backdrop canvases. */
export interface RoomLayer {
  /** Paint the grid: `ROOM_GRID_WIDTH * ROOM_GRID_HEIGHT * 4` RGBA bytes. */
  paint(rgba: Uint8ClampedArray): void;
  /** Lit layers are shown; CSS fades opacity between the two. */
  setLit(lit: boolean): void;
}

export interface RoomSourceRequest {
  /** Identity: the same key again is the same source and changes nothing. */
  key: string;
  source: FrameSource;
  /** Streams follow spec §4's grade; banners and icons the reference renders'. */
  grade: 'stream' | 'still';
  /** Frames a second to ask the source for. */
  hz: number;
}

export type RoomPhase = 'idle' | 'waiting' | 'lit';

export interface RoomControllerOptions {
  layers: readonly [RoomLayer, RoomLayer];
  writer: RoomTokenWriter;
  analyze: FrameAnalyzer;
  clock?: TokenWriterClock;
  /** Reduced transparency: no blur anywhere (spec §4). Read on every frame. */
  reducedTransparency?: () => boolean;
  /** Told whenever the phase or the lit source changes (for `data-*` diagnostics). */
  onPhase?: (phase: RoomPhase, key: string | null) => void;
}

export interface RoomController {
  /** Point the room at a source, or at nothing (the neutral room). */
  setSource(request: RoomSourceRequest | null): void;
  /** The window was hidden or shown: a hidden room asks for no frames and paints nothing. */
  setVisible(visible: boolean): void;
  /** Something the analysis depends on changed (reduced transparency): take a fresh frame. */
  refresh(): void;
  readonly phase: RoomPhase;
  readonly key: string | null;
  /** Canvas paints so far (for the budget test). */
  readonly paints: number;
  dispose(): void;
}

interface Active {
  request: RoomSourceRequest;
  layer: 0 | 1;
  current: Float32Array | null;
  target: Float32Array | null;
  /** The grid has somewhere to go (a new target since it last settled). */
  moving: boolean;
  /** The largest per-channel step taken since the last paint. */
  unpainted: number;
  unsubscribe: (() => void) | null;
}

const GRID_LENGTH = ROOM_GRID_WIDTH * ROOM_GRID_HEIGHT * 3;

function toRgba(grid: Float32Array, out: Uint8ClampedArray): Uint8ClampedArray {
  for (let cell = 0, i = 0; i < GRID_LENGTH; cell += 4, i += 3) {
    out[cell] = grid[i];
    out[cell + 1] = grid[i + 1];
    out[cell + 2] = grid[i + 2];
    out[cell + 3] = 255;
  }
  return out;
}

export function createRoomController(options: RoomControllerOptions): RoomController {
  const clock = options.clock ?? realClock;
  const { layers, writer, analyze } = options;
  const rgba = new Uint8ClampedArray(ROOM_GRID_WIDTH * ROOM_GRID_HEIGHT * 4);

  let active: Active | null = null;
  /** The layer still showing the previous source while the new one finds a frame. */
  let holdingLayer: 0 | 1 | null = null;
  /**
   * The layer lit most recently, whether it is still lit or fading out. An
   * incoming source always paints the other one, so even a quick
   * none-then-something (a route change that resolves in two renders) is a
   * crossfade and never a repaint of the picture on screen.
   */
  let lastLitLayer: 0 | 1 | null = null;
  /** Fires when a new source has not delivered within ROOM_HOLD_MS. */
  let deadline: unknown = null;
  let tokenCurrent: Rgb | null = null;
  let tokenTarget: Rgb = ROOM_NEUTRAL;
  let visible = true;
  let tickTimer: unknown = null;
  let lastTickAt = 0;
  let phase: RoomPhase = 'idle';
  let paints = 0;
  let disposed = false;

  const announce = (next: RoomPhase) => {
    phase = next;
    options.onPhase?.(phase, active?.request.key ?? null);
  };

  const paint = (layer: 0 | 1, grid: Float32Array) => {
    paints += 1;
    layers[layer].paint(toRgba(grid, rgba));
  };

  const releaseHold = () => {
    if (holdingLayer === null) return;
    layers[holdingLayer].setLit(false);
    holdingLayer = null;
  };

  const clearDeadline = () => {
    if (deadline !== null) clock.clearTimeout(deadline);
    deadline = null;
  };

  const tokenMoving = () => tokenCurrent !== null && channelDistance(tokenCurrent, tokenTarget) >= SETTLE_EPSILON;

  const scheduleTick = () => {
    if (disposed || !visible || tickTimer !== null) return;
    if (!active?.moving && !tokenMoving()) return;
    lastTickAt = clock.now();
    tickTimer = clock.setTimeout(tick, ROOM_TICK_MS);
  };

  function tick() {
    tickTimer = null;
    if (disposed || !visible) return;
    const factor = easeFactor(Math.min(clock.now() - lastTickAt, 1000), ROOM_EASE_TAU_MS);

    const owner = active;
    if (owner?.moving && owner.current && owner.target) {
      const { current, target } = owner;
      let remaining = 0;
      let stepped = 0;
      for (let i = 0; i < GRID_LENGTH; i += 1) {
        const step = (target[i] - current[i]) * factor;
        current[i] += step;
        const size = Math.abs(step);
        if (size > stepped) stepped = size;
        const left = Math.abs(target[i] - current[i]);
        if (left > remaining) remaining = left;
      }
      if (remaining < SETTLE_EPSILON) {
        current.set(target);
        owner.moving = false;
      }
      // A step under one 8-bit level changes no pixel: every paint recomposites
      // a full-window layer, so a still-easing room that would look the same
      // is not painted (the last, settling step always is).
      owner.unpainted = Math.max(owner.unpainted, stepped);
      if (owner.unpainted >= 1 || !owner.moving) {
        owner.unpainted = 0;
        paint(owner.layer, current);
      }
    }

    if (tokenMoving() && tokenCurrent) {
      const next = easeRgb(tokenCurrent, tokenTarget, factor);
      const settled = channelDistance(next, tokenTarget) < SETTLE_EPSILON;
      tokenCurrent = settled ? tokenTarget : next;
      // Easing in RGB between two hues passes through grays darker than the
      // box allows; what is written is always inside it.
      writer.offer(clampRoomColor(tokenCurrent), settled);
    }

    scheduleTick();
  }

  const setTokenTarget = (rgb: Rgb) => {
    tokenTarget = rgb;
    if (tokenCurrent === null) {
      // The very first color lands directly: easing from the stylesheet's
      // default would be easing from a room nobody was in.
      tokenCurrent = rgb;
      writer.offer(rgb, true);
      return;
    }
    scheduleTick();
  };

  const onAnalysis = (owner: Active, analysis: RoomAnalysis) => {
    if (owner !== active) return;
    if (!owner.current) {
      clearDeadline();
      owner.current = analysis.grid.slice();
      owner.target = analysis.grid;
      paint(owner.layer, owner.current);
      releaseHold();
      layers[owner.layer].setLit(true);
      lastLitLayer = owner.layer;
      announce('lit');
    } else {
      owner.target = analysis.grid;
      owner.moving = true;
    }
    setTokenTarget(analysis.color);
    scheduleTick();
  };

  const deliver = (owner: Active, frame: ImageBitmap) => {
    if (disposed || owner !== active) {
      frame.close();
      return;
    }
    let analysis: RoomAnalysis | null = null;
    try {
      analysis = analyze(frame, {
        grade: owner.request.grade === 'stream' ? STREAM_GRADE : STILL_GRADE,
        blurSigma: options.reducedTransparency?.() ? 0 : ROOM_BLUR_SIGMA,
      });
    } catch (error) {
      // A frame the canvas may not read (a cross-origin still without CORS) is
      // a real failure of this source: say so and keep the light as it is.
      console.error('[room] a frame could not be read; the room keeps its light', {
        source: owner.request.key,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      frame.close();
    }
    if (analysis) onAnalysis(owner, analysis);
  };

  const subscribe = (owner: Active) => {
    if (owner.unsubscribe || !visible || disposed) return;
    owner.unsubscribe = owner.request.source.subscribe((frame) => deliver(owner, frame), owner.request.hz);
  };

  const unsubscribe = (owner: Active | null) => {
    owner?.unsubscribe?.();
    if (owner) owner.unsubscribe = null;
  };

  return {
    setSource(request) {
      if (disposed) return;
      if ((request?.key ?? null) === (active?.request.key ?? null)) return;
      const previous = active;
      unsubscribe(previous);
      clearDeadline();
      // A hold from the switch before this one goes dark at once.
      releaseHold();

      if (!request) {
        if (previous) layers[previous.layer].setLit(false);
        active = null;
        setTokenTarget(ROOM_NEUTRAL);
        announce('idle');
        return;
      }

      if (previous?.current) holdingLayer = previous.layer;
      else if (previous) layers[previous.layer].setLit(false);
      const layer: 0 | 1 = lastLitLayer === 0 ? 1 : 0;
      const next: Active = { request, layer, current: null, target: null, moving: false, unpainted: 0, unsubscribe: null };
      active = next;
      layers[layer].setLit(false);
      deadline = clock.setTimeout(() => {
        deadline = null;
        if (active !== next || next.current) return;
        // Nothing yet: let the old light go rather than keep another source's
        // room on, and rest the surfaces on the neutral room meanwhile.
        releaseHold();
        setTokenTarget(ROOM_NEUTRAL);
      }, ROOM_HOLD_MS);
      announce('waiting');
      subscribe(next);
    },
    setVisible(next) {
      if (disposed || next === visible) return;
      visible = next;
      if (!visible) {
        unsubscribe(active);
        if (tickTimer !== null) clock.clearTimeout(tickTimer);
        tickTimer = null;
        return;
      }
      if (active) subscribe(active);
      scheduleTick();
    },
    refresh() {
      const owner = active;
      if (!owner || disposed) return;
      void owner.request.source.getLatestFrame().then((frame) => {
        if (frame) deliver(owner, frame);
      });
    },
    get phase() {
      return phase;
    },
    get key() {
      return active?.request.key ?? null;
    },
    get paints() {
      return paints;
    },
    dispose() {
      disposed = true;
      unsubscribe(active);
      active = null;
      clearDeadline();
      holdingLayer = null;
      if (tickTimer !== null) clock.clearTimeout(tickTimer);
      tickTimer = null;
      writer.dispose();
    },
  };
}
