// The mark's motion, as CSS keyframes, computed from the geometry mark.html
// exports (PCMark.GEO). render.mjs writes the result into
// client/src/components/brand/cordMark.css (CordMark) and into the loading
// screen's inline styles in client/index.html.
//
// The technique: the art is static (precomputed SVG). Each animated mark masks
// it with strokes along the cord's centerline, round-capped and a hair wider
// than the cord, and only those strokes' stroke-dasharray/stroke-dashoffset
// move. Two halves are revealed separately, so the crossing stays right while
// it draws: `o` (over) reveals the whole art along the stem and the bowl's
// first half, `u` (under) reveals the bowl's second half and the tail from
// art drawn without the stem, and `h` (halo) cuts the gap out of the under
// strand only where the stem has already been drawn.
//
// No script runs per frame; the keyframes are sampled finely enough that
// linear interpolation between them is indistinguishable from the easing.

/** Length of the gap in every dash pattern: longer than the whole cord. */
const BIG = 999;

const easeOut = (t) => 1 - (1 - t) ** 3;
const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => +v.toFixed(2);

/** Timings, in ms. The owner wants snappy motion. */
export const TIMING = {
  draw: 1000,
  loading: 1700,
  working: 1600,
};

/**
 * Global progress of the cord at time t (0..1) of each mode, as the visible
 * stretch [from, upto] in fractions of the cord.
 */
export const PROGRESS = {
  // Draws on once: up the stem, around the bowl, under the stem. Ease-out.
  draw: (t) => [0, easeOut(t)],
  // Starts whole (so a still mark can hand over to it without a jump), pulls
  // out through its tail, then draws back in, over and over.
  loading: (t) => {
    if (t < 0.06) return [0, 1];
    if (t < 0.5) return [inOut((t - 0.06) / 0.44), 1];
    if (t < 0.94) return [0, inOut((t - 0.5) / 0.44)];
    return [0, 1];
  },
};

/** A visible local stretch [a, b] of a path of length L, as dash values. */
export function dash(a, b, L) {
  a = clamp(a, 0, L);
  b = clamp(b, 0, L);
  if (b - a < 0.01) {
    // An empty dash with round caps still paints a dot, so park it just off
    // the path: before its start if the drawing has not reached it yet, past
    // its end once it has been pulled through.
    return { array: `0 ${BIG}`, offset: b <= 0.01 ? 0.5 : -(L + 0.5) };
  }
  return { array: `${r2(b - a)} ${BIG}`, offset: r2(-a) };
}

/** The three masked stretches, each [start, length] along the cord. */
export function pieces(geo) {
  return {
    o: [0, geo.sMid],
    u: [geo.sMid, geo.tot - geo.sMid],
    h: [0, geo.haloHi],
  };
}

function keyframes(name, frames) {
  // Merge runs of identical frames: keep the first and the last of each run.
  const kept = frames.filter((f, i) => {
    const prev = frames[i - 1], next = frames[i + 1];
    const same = (x) => x && x.array === f.array && x.offset === f.offset;
    return !(same(prev) && same(next));
  });
  const body = kept
    .map((f) => `${r2(f.pct)}%{stroke-dasharray:${f.array};stroke-dashoffset:${f.offset}}`)
    .join('');
  return `@keyframes ${name}{${body}}`;
}

/**
 * Keyframes for one mode: one animation per masked stretch.
 * Returns { o, u, h } CSS @keyframes strings.
 */
export function modeKeyframes(geo, mode, prefix, steps) {
  const out = {};
  for (const [key, [start, L]] of Object.entries(pieces(geo))) {
    const frames = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const [from, upto] = PROGRESS[mode](t);
      const d = dash(from * geo.tot - start, upto * geo.tot - start, L);
      frames.push({ pct: t * 100, ...d });
    }
    out[key] = keyframes(`${prefix}-${mode}-${key}`, frames);
  }
  return out;
}

/**
 * The working highlight: soft bands that run along the cord from the stem's
 * foot to the tail's end, as if the cord were being pulled through. Three
 * concentric dashes of falling length make the band's soft edge without a
 * blur. Each band exists twice, once per half (over and under), so the under
 * half's band passes beneath the stem; the under copy's offset carries on
 * where the over copy's leaves off.
 */
export const HIGHLIGHT = {
  bands: [
    { len: 0.22, opacity: 0.14 },
    { len: 0.13, opacity: 0.14 },
    { len: 0.06, opacity: 0.16 },
  ],
  color: '#fff6ec',
};

export function highlightKeyframes(geo, prefix) {
  const H = HIGHLIGHT.bands[0].len * geo.tot;
  const period = geo.tot + H;
  const css = [];
  HIGHLIGHT.bands.forEach((band, i) => {
    const h = band.len * geo.tot;
    const lead = H - (H - h) / 2; // centered in the widest band
    for (const [key, start] of [['o', 0], ['u', geo.sMid]]) {
      const from = r2(lead + start);
      css.push(`@keyframes ${prefix}-work-${key}${i}{from{stroke-dashoffset:${from}}to{stroke-dashoffset:${r2(from - period)}}}`);
    }
  });
  return { css: css.join(''), period: r2(period) };
}

/** The dasharray of each highlight band. */
export function highlightDash(geo) {
  const H = HIGHLIGHT.bands[0].len * geo.tot;
  const period = geo.tot + H;
  return HIGHLIGHT.bands.map((b) => `${r2(b.len * geo.tot)} ${r2(period - b.len * geo.tot)}`);
}

/**
 * Everything for CordMark: the keyframes and the rules that attach them.
 * Classes: .pc-cord (the svg), .pc-cord--draw / --loading / --working (mode),
 * .pc-cord__o / __u / __h (the masks' strokes), .pc-cord__w{o,u}{0,1,2} (bands).
 */
export function cordMarkCss(geo) {
  const P = 'pc-cord';
  const draw = modeKeyframes(geo, 'draw', P, 50);
  const loading = modeKeyframes(geo, 'loading', P, 85);
  const hl = highlightKeyframes(geo, P);
  const rules = [];
  for (const key of ['o', 'u', 'h']) {
    rules.push(`.${P}--draw .${P}__${key}{animation:${P}-draw-${key} ${TIMING.draw}ms linear both}`);
    rules.push(`.${P}--loading .${P}__${key}{animation:${P}-loading-${key} ${TIMING.loading}ms linear infinite}`);
  }
  HIGHLIGHT.bands.forEach((_, i) => {
    for (const key of ['o', 'u']) {
      rules.push(`.${P}--working .${P}__w${key}${i}{animation:${P}-work-${key}${i} ${TIMING.working}ms linear infinite}`);
    }
  });
  return [
    Object.values(draw).join('\n'),
    Object.values(loading).join('\n'),
    hl.css,
    rules.join('\n'),
  ].join('\n');
}

/**
 * The loading screen's draw-on, for client/index.html: the same keyframes as
 * CordMark's `draw`, under the loading screen's own names and timing.
 */
export function bootSplashCss(geo, { delay = 60 } = {}) {
  const P = 'pc-boot-cord';
  const draw = modeKeyframes(geo, 'draw', P, 50);
  const rules = ['o', 'u', 'h'].map(
    (key) => `.pc-boot__${key}{animation:${P}-draw-${key} ${TIMING.draw}ms linear ${delay}ms backwards}`,
  );
  return [Object.values(draw).join('\n'), rules.join('\n')].join('\n');
}
