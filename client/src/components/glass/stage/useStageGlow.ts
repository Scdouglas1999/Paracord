import { useEffect, type RefObject } from 'react';

import { easeFactor, easeRgb, formatRoomRgb, roomColorFromAverage, type Rgb } from '../../../lib/room/color';
import { createViewFrameSource } from '../../../lib/room/viewFrameSource';

/**
 * The stage pane's ambient glow (docs/glass-spec.md §6.1): "an ambient glow
 * around it sampled from the stream (a soft teal/amber spill left and right)".
 *
 * The watched stream is sampled once a second through the room's own frame
 * source (WP-G8's `createViewFrameSource('watch', …)`, which follows the watch
 * across its engines and asks the desktop shell for its downsample on the
 * native route). The left and right fifths of a 16x9 draw are averaged, lifted
 * and clamped the way the room's color is (`roomColorFromAverage`), eased over
 * about 1.5 seconds, and written as channel numbers (never an `rgb()` string)
 * to `--stage-glow-l` and `--stage-glow-r` on the stage pane, where
 * `styles/glass-stage.css` turns them into the two side shadows. Until the first
 * sample the glow is the room's color (`--room-rgb`, which G8 takes from the
 * same stream while a stage is open).
 *
 * One style write a second at most, on one element: no animated custom
 * property, no per-frame work (glass-plan §6, "Room token churn").
 */

const GLOW_HZ = 1;
const GLOW_TAU_MS = 1500;
const SAMPLE_W = 16;
const SAMPLE_H = 9;
/** Columns averaged on each side (a fifth of the width). */
const SIDE_COLUMNS = 3;

export const STAGE_GLOW_LEFT = '--stage-glow-l';
export const STAGE_GLOW_RIGHT = '--stage-glow-r';

/** The average color of columns [from, to) of an RGBA sample. */
export function averageColumns(data: ArrayLike<number>, width: number, height: number, from: number, to: number): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = from; x < to; x += 1) {
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

/** The glow's two colors for one sample: the stream's left and right edges, as the room would light them. */
export function glowColors(data: ArrayLike<number>, width: number, height: number): { left: Rgb; right: Rgb } {
  const side = Math.max(1, Math.min(SIDE_COLUMNS, Math.floor(width / 2)));
  return {
    left: roomColorFromAverage(averageColumns(data, width, height, 0, side)),
    right: roomColorFromAverage(averageColumns(data, width, height, width - side, width)),
  };
}

export function useStageGlow(rootRef: RefObject<HTMLElement | null>, streamerId: string): void {
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>('.glass-frame__stage') ?? null;
    if (!pane) return;
    let context: CanvasRenderingContext2D | null = null;
    let left: Rgb | null = null;
    let right: Rgb | null = null;
    let lastAt = 0;

    const source = createViewFrameSource('watch', streamerId, { width: SAMPLE_W * 2, height: SAMPLE_H * 2 });
    const stop = source.subscribe((bitmap) => {
      try {
        if (!context) {
          const canvas = document.createElement('canvas');
          canvas.width = SAMPLE_W;
          canvas.height = SAMPLE_H;
          context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return;
        }
        context.drawImage(bitmap, 0, 0, SAMPLE_W, SAMPLE_H);
        const { data } = context.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        const next = glowColors(data, SAMPLE_W, SAMPLE_H);
        const now = performance.now();
        const factor = lastAt === 0 ? 1 : easeFactor(now - lastAt, GLOW_TAU_MS);
        lastAt = now;
        left = left ? easeRgb(left, next.left, factor) : next.left;
        right = right ? easeRgb(right, next.right, factor) : next.right;
        pane.style.setProperty(STAGE_GLOW_LEFT, formatRoomRgb(left));
        pane.style.setProperty(STAGE_GLOW_RIGHT, formatRoomRgb(right));
      } finally {
        bitmap.close();
      }
    }, GLOW_HZ);

    return () => {
      stop();
      pane.style.removeProperty(STAGE_GLOW_LEFT);
      pane.style.removeProperty(STAGE_GLOW_RIGHT);
    };
  }, [rootRef, streamerId]);
}
