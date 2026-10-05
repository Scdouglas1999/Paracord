/**
 * A looping canvas scene that stands in for a live stream, so the stream tile
 * and the call view can be reviewed without a media server (the review
 * harness, `e2e/fixtures/index/call.ts`).
 *
 * DEV ONLY. Nothing may import this statically. A consumer reaches it the same
 * way `App.tsx` reaches `IxCardsGallery`, so Rollup folds it to `null` and the
 * module never ships:
 *
 *   const fixtureFrames = import.meta.env.DEV
 *     ? () => import('@/lib/media/fixtureFrameSource')
 *     : null;
 *
 * As a second line of defence, `createFixtureFrameSource` throws outside a DEV
 * build rather than quietly producing pictures nobody made.
 *
 * COLOR: this file holds no color literal. A canvas cannot read a custom
 * property, so each color is a design token resolved through a probe element
 * (`resolveToken`) — the scene is drawn in the palette's own amber and teal,
 * and follows it when the palette changes. That is why this file needs no entry
 * in the literal-color audit's ALLOWED list.
 *
 * Scenes:
 *   'stream'  a cave mouth at dusk: teal crystals, a warm headlamp beam sweeping
 *             the wall, drifting motes. The reference render's "Vincent's screen"
 *   'camera'  a head-and-shoulders silhouette against a soft backdrop, breathing
 *   'camera-warm'  the same, in the warm ground
 *
 * The loop is 12 seconds and seamless, so a screenshot at any moment is
 * representative and a recording never visibly restarts.
 */
import type { FrameSource } from './frameSource';

export type FixtureScene = 'stream' | 'camera' | 'camera-warm';

export interface FixtureFrameSourceOptions {
  scene?: FixtureScene;
  width?: number;
  height?: number;
  /** Fix the moment drawn, in seconds into the loop, instead of following the clock. */
  freezeAtSeconds?: number;
}

/** The scene repeats every this many seconds. */
export const FIXTURE_LOOP_SECONDS = 12;

const TOKENS = {
  ground: '--bg-well',
  dusk: '--window-dark',
  amber: '--light-amber',
  teal: '--accent-primary',
  white: '--light-white',
} as const;

type Palette = Record<keyof typeof TOKENS, string>;

/**
 * A token's resolved color. Custom properties hold their declared text
 * (`oklch(… var(--ui-hue))`), which a canvas cannot parse, so let the style
 * engine resolve it on a probe element and read the computed value back.
 */
function resolveToken(name: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  if (!resolved) throw new Error(`fixtureFrameSource: token ${name} did not resolve to a color`);
  return resolved;
}

function readPalette(): Palette {
  const palette = {} as Palette;
  for (const key of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) {
    palette[key] = resolveToken(TOKENS[key]);
  }
  return palette;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const TAU = Math.PI * 2;

/** Layer `color` at `alpha` without needing an alpha-bearing color string. */
function withAlpha(ctx: Ctx, alpha: number, draw: () => void) {
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * alpha;
  draw();
  ctx.globalAlpha = previous;
}

function drawCave(ctx: Ctx, w: number, h: number, phase: number, p: Palette) {
  // The wall: the ground token, lit warm toward the mouth of the cave.
  ctx.fillStyle = p.ground;
  ctx.fillRect(0, 0, w, h);

  const pulse = 0.5 + 0.5 * Math.sin(phase * TAU);
  const glowX = w * 0.72;
  const glowY = h * 0.5;
  const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, w * (0.55 + 0.04 * pulse));
  glow.addColorStop(0, p.amber);
  glow.addColorStop(0.35, p.dusk);
  glow.addColorStop(1, p.ground);
  withAlpha(ctx, 0.5 + 0.12 * pulse, () => {
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  });

  // Ceiling teeth.
  ctx.fillStyle = p.ground;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const teeth = 14;
  for (let i = 0; i <= teeth; i += 1) {
    const x = (i / teeth) * w;
    const depth = h * (0.1 + 0.16 * Math.abs(Math.sin(i * 2.3 + 0.7)));
    ctx.lineTo(x, i % 2 === 0 ? depth * 0.35 : depth);
  }
  ctx.lineTo(w, 0);
  ctx.closePath();
  ctx.fill();

  // Teal crystals on the left, breathing in brightness.
  const crystals: Array<[number, number, number]> = [
    [0.2, 0.74, 0.36],
    [0.26, 0.76, 0.24],
    [0.15, 0.76, 0.16],
  ];
  crystals.forEach(([cx, base, height], index) => {
    const shimmer = 0.75 + 0.25 * Math.sin(phase * TAU + index * 1.7);
    ctx.fillStyle = p.teal;
    withAlpha(ctx, shimmer, () => {
      ctx.beginPath();
      ctx.moveTo(w * (cx - 0.035), h * base);
      ctx.lineTo(w * cx, h * (base - height));
      ctx.lineTo(w * (cx + 0.035), h * base);
      ctx.closePath();
      ctx.fill();
    });
  });

  // Ground: a low ridge in silhouette.
  ctx.fillStyle = p.ground;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h * 0.78);
  for (let i = 0; i <= 20; i += 1) {
    const x = (i / 20) * w;
    ctx.lineTo(x, h * (0.76 + 0.03 * Math.sin(i * 0.9) - 0.02 * Math.sin(i * 2.1)));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // The figure with the headlamp, and its beam sweeping slowly.
  const figX = w * 0.62;
  const figBase = h * 0.78;
  const sweep = Math.sin(phase * TAU) * 0.06;
  const lampX = figX + w * 0.012;
  const lampY = figBase - h * 0.2;
  const beam = ctx.createLinearGradient(lampX, lampY, w, lampY);
  beam.addColorStop(0, p.white);
  beam.addColorStop(1, p.ground);
  withAlpha(ctx, 0.42, () => {
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(lampX, lampY);
    ctx.lineTo(w, lampY - h * (0.14 - sweep));
    ctx.lineTo(w, lampY + h * (0.2 + sweep));
    ctx.closePath();
    ctx.fill();
  });
  ctx.fillStyle = p.ground;
  ctx.beginPath();
  ctx.ellipse(figX, figBase - h * 0.21, w * 0.018, h * 0.035, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(figX - w * 0.03, figBase);
  ctx.quadraticCurveTo(figX - w * 0.03, figBase - h * 0.19, figX, figBase - h * 0.19);
  ctx.quadraticCurveTo(figX + w * 0.03, figBase - h * 0.19, figX + w * 0.03, figBase);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = p.white;
  ctx.beginPath();
  ctx.arc(lampX, lampY, Math.max(2, w * 0.005), 0, TAU);
  ctx.fill();

  // Motes drifting through the beam. Whole-loop periodic, so the seam is clean.
  ctx.fillStyle = p.amber;
  for (let i = 0; i < 18; i += 1) {
    const t = (phase + i / 18) % 1;
    const x = lampX + (w - lampX) * t;
    const y = lampY + Math.sin(i * 12.9898 + t * TAU) * h * 0.09 * t;
    withAlpha(ctx, 0.55 * Math.sin(t * Math.PI), () => {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, w * 0.0025), 0, TAU);
      ctx.fill();
    });
  }
}

function drawCamera(ctx: Ctx, w: number, h: number, phase: number, p: Palette, warm: boolean) {
  const backdrop = ctx.createLinearGradient(0, 0, 0, h);
  backdrop.addColorStop(0, warm ? p.amber : p.teal);
  backdrop.addColorStop(1, p.dusk);
  ctx.fillStyle = p.ground;
  ctx.fillRect(0, 0, w, h);
  withAlpha(ctx, 0.5, () => {
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, w, h);
  });

  const breathe = 1 + 0.012 * Math.sin(phase * TAU);
  const cx = w / 2;
  ctx.fillStyle = p.ground;
  // Shoulders.
  ctx.beginPath();
  ctx.ellipse(cx, h * 1.02, w * 0.32 * breathe, h * 0.3 * breathe, 0, Math.PI, TAU);
  ctx.fill();
  // Neck and head.
  ctx.fillRect(cx - w * 0.05, h * 0.6, w * 0.1, h * 0.14);
  ctx.beginPath();
  ctx.ellipse(cx, h * 0.46, w * 0.14 * breathe, h * 0.2 * breathe, 0, 0, TAU);
  ctx.fill();
  // A rim of the scene's light along the head, so it reads as lit rather than cut out.
  ctx.strokeStyle = warm ? p.amber : p.teal;
  ctx.lineWidth = Math.max(2, w * 0.006);
  withAlpha(ctx, 0.55, () => {
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.46, w * 0.14 * breathe, h * 0.2 * breathe, 0, Math.PI * 1.15, Math.PI * 1.75);
    ctx.stroke();
  });
}

interface Surface {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: Ctx;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('fixtureFrameSource: no 2d context');
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('fixtureFrameSource: no 2d context');
  return { canvas, ctx };
}

export function createFixtureFrameSource(options: FixtureFrameSourceOptions = {}): FrameSource {
  if (!import.meta.env.DEV) {
    throw new Error('fixtureFrameSource is a DEV-only review fixture and must not run in a production build');
  }
  const scene = options.scene ?? 'stream';
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const surface = createSurface(width, height);
  const palette = readPalette();
  const origin = performance.now();

  const paint = () => {
    const seconds = options.freezeAtSeconds ?? (performance.now() - origin) / 1000;
    const phase = (seconds % FIXTURE_LOOP_SECONDS) / FIXTURE_LOOP_SECONDS;
    if (scene === 'stream') drawCave(surface.ctx, width, height, phase, palette);
    else drawCamera(surface.ctx, width, height, phase, palette, scene === 'camera-warm');
  };
  const snapshot = () => {
    paint();
    return createImageBitmap(surface.canvas);
  };

  const timers = new Map<symbol, ReturnType<typeof setInterval>>();

  return {
    kind: 'fixture',
    width,
    height,
    subscribe(onFrame, hz) {
      if (!(hz > 0)) throw new Error('fixtureFrameSource: hz must be positive');
      const id = Symbol('subscriber');
      let live = true;
      const deliver = () => {
        void snapshot().then((bitmap) => {
          if (live) onFrame(bitmap);
          else bitmap.close();
        });
      };
      deliver();
      timers.set(id, setInterval(deliver, 1000 / hz));
      return () => {
        live = false;
        const timer = timers.get(id);
        if (timer !== undefined) clearInterval(timer);
        timers.delete(id);
      };
    },
    getLatestFrame: () => snapshot(),
  };
}
