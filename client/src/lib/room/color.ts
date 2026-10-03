/**
 * The room's color math (docs/glass-spec.md §2.1, §4).
 *
 * Everything here is pure and works on channel numbers, never on CSS color
 * strings: the only thing the room ever writes is `--room-rgb` as three
 * channel numbers (`"222, 109, 35"`), and `tokens.css` derives every tinted
 * surface from it with `color-mix()`.
 *
 * THE CLAMP BOX. Whatever a frame looks like, the room color written to
 * `--room-rgb` lies inside this box, in HSV (the terms
 * `scripts/contrast-audit.mjs` sweeps, so the audit proves every color the room
 * can produce):
 *
 *     hue         any
 *     saturation  0 .. 0.85
 *     value       0.78 .. 1
 *
 * Why these edges:
 *  - Saturation is capped at .85 so a neon frame cannot push the 4-6% tint past
 *    the "sepia" the owner rejected, and so hue noise in a busy frame has less
 *    to swing. The warm reference sample (222, 109, 35) sits at .84.
 *  - Value is held high and narrow (.78 to 1) because the surfaces only take
 *    4-6% of it: a dark frame must not darken the panes and a bright one must
 *    not lift them, or ink contrast would move with the video. Only the hue and
 *    saturation of what is live should reach the interface. The cool reference
 *    sample (80, 158, 255) sits at value 1, the warm one at .87.
 *  - Gray stays gray: a black-and-white stream lights the room neutral rather
 *    than inventing a hue.
 */

export type Rgb = readonly [number, number, number];

export interface Hsv {
  /** Degrees, 0 <= h < 360. */
  h: number;
  /** 0 .. 1 */
  s: number;
  /** 0 .. 1 */
  v: number;
}

/** The clamp box (HSV). `scripts/contrast-audit.mjs` sweeps exactly these edges. */
export const ROOM_CLAMP = {
  saturationMax: 0.85,
  valueMin: 0.78,
  valueMax: 1,
} as const;

/**
 * What a frame's average saturation is multiplied by before the clamp. An
 * average over a whole frame is far grayer than any color in it (a teal cave
 * with an amber lamp averages to mud); this brings the dominant color back out
 * so the tint reads as the stream's, as the reference samples do. Calibrated on
 * the prototype's own room art (`GlassV14*.dc.html`): its cave averages to
 * saturation .37 and its banner to .18, where the designer's samples for them
 * are .84 and .69; 2.4 lands the cave on the cap and the banner at .43.
 */
export const ROOM_SATURATION_GAIN = 2.4;

/**
 * The room with nothing to light it (Home, DMs, a server with no banner or
 * icon): a muted slate blue inside the box, giving quiet pages a little color
 * without changing the lightness or contrast of a lit room.
 */
export const ROOM_DEFAULT: Rgb = [82, 143, 219];

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Force a color into the clamp box, keeping its hue. */
export function clampRoomColor(rgb: Rgb): Rgb {
  const hsv = rgbToHsv(rgb);
  return hsvToRgb({
    h: hsv.h,
    s: Math.min(hsv.s, ROOM_CLAMP.saturationMax),
    v: Math.min(ROOM_CLAMP.valueMax, Math.max(ROOM_CLAMP.valueMin, hsv.v)),
  });
}

/** Whether a color is inside the clamp box (with a rounding tolerance). */
export function insideClampBox(rgb: Rgb, tolerance = 0.006): boolean {
  const { s, v } = rgbToHsv(rgb);
  return (
    s <= ROOM_CLAMP.saturationMax + tolerance &&
    v >= ROOM_CLAMP.valueMin - tolerance &&
    v <= ROOM_CLAMP.valueMax + tolerance
  );
}

/**
 * The room color of a frame, from its average: saturation lifted by
 * {@link ROOM_SATURATION_GAIN}, value mapped into the box so a brighter scene
 * reads a little lighter than a dark one, then clamped.
 */
export function roomColorFromAverage(average: Rgb): Rgb {
  const hsv = rgbToHsv(average);
  const span = ROOM_CLAMP.valueMax - ROOM_CLAMP.valueMin;
  // A frame averaging 60% value or more is as bright as the room gets.
  const lift = clamp01(hsv.v / 0.6);
  return clampRoomColor(
    hsvToRgb({
      h: hsv.h,
      s: clamp01(hsv.s * ROOM_SATURATION_GAIN),
      v: ROOM_CLAMP.valueMin + span * lift,
    }),
  );
}

/**
 * One step of exponential easing toward `target` over `dtMs`, with time
 * constant `tauMs`. With the room's tau of 600 ms a change is 95% done after
 * about 1.8 s: "ease colors over 1 to 2 seconds".
 */
export function easeFactor(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
}

export function easeRgb(current: Rgb, target: Rgb, factor: number): Rgb {
  return [
    current[0] + (target[0] - current[0]) * factor,
    current[1] + (target[1] - current[1]) * factor,
    current[2] + (target[2] - current[2]) * factor,
  ];
}

export function roundRgb(rgb: Rgb): Rgb {
  return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
}

/** The largest per-channel difference between two colors. */
export function channelDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** `--room-rgb`'s value: channel numbers only, never an `rgb()` string. */
export function formatRoomRgb(rgb: Rgb): string {
  const [r, g, b] = roundRgb(rgb);
  return `${r}, ${g}, ${b}`;
}
