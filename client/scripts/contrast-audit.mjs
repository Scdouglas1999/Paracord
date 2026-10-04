/**
 * The contrast audit (docs/glass-spec.md §2, §9).
 *
 * Glass is the only look, and there are two themes: `glass` (the default) and
 * `glass-contrast` (High contrast). Neither is a fixed ramp. Every surface is
 * a `color-mix()` of one channel triplet, `--room-rgb`, into a neutral step,
 * and the room controller (WP-G8) writes that triplet from whatever is live in
 * the current server. So this script resolves the real tokens, for BOTH
 * themes, and sweeps the room over the two reference tints (spec §2.1), the
 * default room, and a hue x saturation x value grid over exactly the clamp box
 * the room controller enforces (read from `src/lib/room/color.ts`).
 * At every one of those it requires:
 *
 *   - the Glass ink set (spec §2.2) on every Glass surface: 7:1 for `--ink-1`,
 *     4.5:1 for the rest, panes measured over the brightest backdrop the room
 *     can draw;
 *   - the Lantern-named tokens the screens nobody has rebuilt yet still read
 *     (`--text-*` on `--bg-*`, the semantic accents, identity inks), because
 *     they are mapped onto the Glass ones and must keep clearing 4.5:1 there;
 *   - for High contrast, the higher floors it exists for: opaque panes, 12:1
 *     for the first ink step and 7:1 for the other two, and 3:1 for every edge.
 *
 * The Index look (docs/index-spec.md §2) is audited too, by hue rather than by
 * room: every server hue 0-359 in 15 degree steps, plus the eleven palette hues,
 * for both themes. Ink, ink-2 and ink-3 are measured on the sidebar's top, its
 * list zone and its foot, the selected row, main (with its glow), a bubble, an
 * event card and the call surface; the cream, danger and amber pairs, the
 * avatar and server-mark letters, and the High contrast hardening of each are
 * measured too. The recipes are READ from src/styles/ix-base.css, not copied, so
 * a change to the stylesheet is audited and cannot drift from this script.
 *
 * It also fails on a token that lands outside sRGB (a browser would gamut-map
 * it and the measured color would no longer be the one written down), on a
 * second declaration of the danger ink (there is exactly one, and every other
 * danger token is made from it), and, for the default theme, when the two
 * reference tints in spec §2.1 stop being reproduced.
 *
 * Run: `npm run test:contrast`
 */
import fs from 'node:fs';
import path from 'node:path';

const tokensPath = path.resolve(process.cwd(), 'src/styles/tokens.css');
const css = fs.readFileSync(tokensPath, 'utf8');

function extractBlocks(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'gm');
  const vars = {};
  let match = regex.exec(css);
  while (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const parsed = line.match(/--([\w-]+)\s*:\s*([^;]+);/);
      if (parsed) vars[`--${parsed[1]}`] = parsed[2].trim();
    }
    match = regex.exec(css);
  }
  return vars;
}

/* ---- var() substitution + calc() ------------------------------------------
   `oklch(21.3% calc(0.009 * var(--ui-chroma)) var(--ui-hue))` has to become
   three numbers before it can be measured. Substitute every var() against the
   theme's map, then fold the arithmetic. */

function substituteVars(value, map, depth = 0) {
  if (depth > 24) throw new Error(`var() nested too deep in "${value}"`);
  const open = value.indexOf('var(');
  if (open === -1) return value;
  let i = open + 4;
  let level = 1;
  while (i < value.length && level > 0) {
    if (value[i] === '(') level += 1;
    else if (value[i] === ')') level -= 1;
    i += 1;
  }
  const inner = value.slice(open + 4, i - 1);
  const comma = splitTop(inner, ',');
  const name = comma[0].trim();
  const fallback = comma.length > 1 ? comma.slice(1).join(',').trim() : null;
  const resolved = map[name] != null ? map[name] : fallback;
  if (resolved == null) throw new Error(`unresolved ${name}`);
  const next = value.slice(0, open) + substituteVars(resolved, map, depth + 1) + value.slice(i);
  return substituteVars(next, map, depth + 1);
}

/** Split on a separator that is not inside parentheses. */
function splitTop(value, separator) {
  const parts = [];
  let level = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') level += 1;
    if (ch === ')') level -= 1;
    if (ch === separator && level === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Fold every `calc(...)` in a value. Only the arithmetic tokens.css uses. */
function foldCalc(value) {
  let out = value;
  for (;;) {
    const at = out.indexOf('calc(');
    if (at === -1) return out;
    let i = at + 5;
    let level = 1;
    while (i < out.length && level > 0) {
      if (out[i] === '(') level += 1;
      else if (out[i] === ')') level -= 1;
      i += 1;
    }
    const expr = out.slice(at + 5, i - 1);
    out = out.slice(0, at) + String(evalExpr(foldCalc(expr))) + out.slice(i);
  }
}

function evalExpr(expr) {
  const tokens = expr.match(/(\d+\.?\d*|[-+*/()])/g);
  if (!tokens) throw new Error(`cannot evaluate "${expr}"`);
  let pos = 0;
  const peek = () => tokens[pos];
  const term = () => {
    let left = factor();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++];
      const right = factor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const factor = () => {
    if (peek() === '(') {
      pos += 1;
      const inner = sum();
      pos += 1;
      return inner;
    }
    if (peek() === '-') {
      pos += 1;
      return -factor();
    }
    return Number(tokens[pos++]);
  };
  const sum = () => {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const value = sum();
  if (!Number.isFinite(value)) throw new Error(`cannot evaluate "${expr}"`);
  return value;
}

/* ---- Color ---------------------------------------------------------------- */

const linearFromSrgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const srgbFromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** OKLab → linear sRGB (Björn Ottosson's matrices). */
function oklabToLinearSrgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const GAMUT_SLACK = 0.002;

/** A trailing `NN%` on a color-mix() argument: `<color> [<percentage>]`. */
function splitMixArg(arg) {
  const m = arg.trim().match(/^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/);
  return m ? { color: m[1].trim(), weight: Number(m[2]) / 100 } : { color: arg.trim(), weight: null };
}

/**
 * `color-mix(in srgb, A [p%], B [q%])` — the only shape tokens.css derives the
 * Glass surfaces with. Premultiplied, as the specification has it: mixing with
 * `transparent` keeps the color and takes the alpha.
 */
function mixColors(inner, label) {
  const [space, first, second, ...extra] = splitTop(inner, ',').map((part) => part.trim());
  if (space !== 'in srgb' || first == null || second == null || extra.length > 0) {
    throw new Error(`${label}: unsupported color-mix() "${inner}"`);
  }
  const a = splitMixArg(first);
  const b = splitMixArg(second);
  let wa = a.weight;
  let wb = b.weight;
  if (wa == null && wb == null) {
    wa = 0.5;
    wb = 0.5;
  } else if (wa == null) wa = 1 - wb;
  else if (wb == null) wb = 1 - wa;
  const total = wa + wb;
  const scale = total < 1 ? total : 1; // a sum under 100% leaves the rest transparent
  wa /= total;
  wb /= total;
  const ca = parseColor(a.color, label);
  const cb = parseColor(b.color, label);
  if (!ca || !cb) return null;
  const alpha = (ca.a * wa + cb.a * wb) * scale;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (k) => (ca[k] * ca.a * wa + cb[k] * cb.a * wb) / (ca.a * wa + cb.a * wb);
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}

function parseColor(value, label) {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (normalized === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (normalized.startsWith('color-mix(') && normalized.endsWith(')')) {
    return mixColors(normalized.slice('color-mix('.length, -1), label);
  }

  if (normalized.startsWith('#')) {
    let hex = normalized.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6) return null;
    const int = Number.parseInt(hex, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }

  const rgba = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim());
    if (parts.length < 3) return null;
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts[3] != null ? Number(parts[3]) : 1,
    };
  }

  const oklch = normalized.match(/^oklch\(([\s\S]+)\)$/);
  if (oklch) {
    const [main, alphaPart] = splitTop(oklch[1], '/');
    const parts = main.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const lightness = parts[0].endsWith('%') ? Number.parseFloat(parts[0]) / 100 : Number(parts[0]);
    const chroma = Number(parts[1]);
    const hue = Number.parseFloat(parts[2]);
    const alpha = alphaPart == null
      ? 1
      : alphaPart.trim().endsWith('%')
        ? Number.parseFloat(alphaPart) / 100
        : Number(alphaPart);
    if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
    const radians = (hue * Math.PI) / 180;
    const linear = oklabToLinearSrgb(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians));
    if (linear.some((channel) => channel < -GAMUT_SLACK || channel > 1 + GAMUT_SLACK)) {
      throw new Error(
        `${label} is outside sRGB: oklch(${parts[0]} ${chroma} ${hue}) — a browser would gamut-map it`,
      );
    }
    const [r, g, b] = linear.map((channel) => srgbFromLinear(Math.min(1, Math.max(0, channel))) * 255);
    return { r, g, b, a: alpha };
  }

  return null;
}

function resolveVar(name, map) {
  const declared = map[name];
  if (declared == null) return null;
  return foldCalc(substituteVars(declared, map)).trim();
}

const luminance = (color) =>
  0.2126 * linearFromSrgb(color.r / 255) +
  0.7152 * linearFromSrgb(color.g / 255) +
  0.0722 * linearFromSrgb(color.b / 255);

function blend(fg, bg) {
  const alpha = Number.isFinite(fg.a) ? fg.a : 1;
  const inv = 1 - alpha;
  return { r: fg.r * alpha + bg.r * inv, g: fg.g * alpha + bg.g * inv, b: fg.b * alpha + bg.b * inv, a: 1 };
}

function contrastRatio(foreground, background) {
  const fg = foreground.a < 1 ? blend(foreground, background) : foreground;
  const l1 = luminance(fg);
  const l2 = luminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}


/* ---- The checks ------------------------------------------------------------ */

const themeBase = extractBlocks('@theme');
// The Glass surfaces are derived per subtree (`:root, [data-theme=…], .glass-room`),
// which the `:root {` pattern does not see; read that block by its last selector.
const glassRoom = extractBlocks('.glass-room');
const rootBase = { ...extractBlocks(':root'), ...glassRoom };
// Glass is what `:root` declares. High contrast is its own block laid over that,
// which is exactly the cascade the selectors in tokens.css give it.
const highContrast = extractBlocks("[data-theme='glass-contrast']");
const THEMES = { glass: {}, 'high contrast': highContrast };
const isHighContrast = (themeName) => themeName === 'high contrast';

// docs/glass-spec.md §9: text is at least 4.5:1 against its actual surface.
// Body text is held to 7:1, and every ramp step is checked against every ground
// it can land on: a token that only passes on the darkest surface is not passing.
const GROUNDS = ['--bg-base', '--bg-plate', '--bg-raised', '--bg-well'];
const IDENTITY_INKS = Array.from({ length: 8 }, (_, i) => `--identity-ink-${i + 1}`);

const checks = [
  // The text ramp. `--text-body-ink` is the body step (the name `--text-body`
  // belongs to Tailwind's body *type* step, a font-size).
  ...GROUNDS.map((bg) => ({ fg: '--text-primary', bg, min: 7 })),
  ...GROUNDS.map((bg) => ({ fg: '--text-body-ink', bg, min: 7 })),
  ...GROUNDS.map((bg) => ({ fg: '--text-secondary', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--text-muted', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--text-faint', bg, min: 4.5 })),
  // Action and semantics as text on a plate. `--accent-danger` is the one
  // danger ink: destructive confirms and error text.
  ...GROUNDS.map((bg) => ({ fg: '--accent-primary', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-danger', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-warning', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-info', bg, min: 4.5 })),
  // Ink on a fill.
  { fg: '--text-on-light', bg: '--light-white', min: 12 },
  { fg: '--text-on-accent', bg: '--accent-primary', min: 4.5 },
  { fg: '--text-on-danger', bg: '--danger-well', min: 4.5 },
  { fg: '--text-on-danger', bg: '--danger-well-hover', min: 4.5 },
  // The two lights must stay legible as a label as well as a fill.
  ...GROUNDS.map((bg) => ({ fg: '--light-white', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--light-amber', bg, min: 4.5 })),
  // A lit channel thumbnail carries its LIVE label and its occupants' names on
  // a tinted frame of its own, not on any of the four grounds above.
  { fg: '--light-white', bg: '--thumb-frame-lit', min: 4.5 },
  { fg: '--text-primary', bg: '--thumb-frame-lit', min: 7 },
  // An author's name is written in their identity's ink. Eight hues x four
  // grounds: a name is a name, so 4.5:1 is the floor.
  ...IDENTITY_INKS.flatMap((fg) => GROUNDS.map((bg) => ({ fg, bg, min: 4.5 }))),
  // Ink on the row you are on: the selection is a solid step, but a row inside
  // a server's group writes its own wash, so the real question is the ink over
  // the selection over the plate.
  { fg: '--text-primary', bg: '--row-selected', over: '--bg-plate', min: 7 },
  { fg: '--text-secondary', bg: '--row-selected', over: '--bg-plate', min: 4.5 },
  { fg: '--text-primary', bg: '--bg-mod-strong', over: '--bg-plate', min: 7 },
  // Yard numbers, end-zone letters and the digits inside a pitch marker.
  // The field is a fixed green, so these pairs do not move with the room.
  { fg: '--sports-chalk', bg: '--sports-turf', min: 4.5 },
  { fg: '--sports-chalk', bg: '--sports-turf-alt', min: 4.5 },
  { fg: '--sports-chalk', bg: '--sports-endzone', min: 4.5 },
  { fg: '--sports-chalk', bg: '--sports-bug', over: '--sports-stadium', min: 4.5 },
  { fg: '--sports-chalk', bg: '--sports-stadium', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-ball', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-looking', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-swinging', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-foul', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-inplay', min: 4.5 },
  { fg: '--sports-pitch-ink', bg: '--sports-pitch-other', min: 4.5 },
];

let failures = 0;
let worst = { ratio: Infinity };
let comparisons = 0;

/* ---- The one danger ink ------------------------------------------------------
   Owner decision (docs/design/glass-plan.md §8): one danger color, only for
   destructive confirms and errors. It is written once, and every other danger
   token is made from it, so there cannot be a second red to drift. */
{
  const declarations = css.match(/^\s*--accent-danger\s*:/gm) ?? [];
  if (declarations.length !== 1) {
    failures += 1;
    console.error(`[contrast] --accent-danger is declared ${declarations.length} times; there must be exactly one.`);
  }
  for (const name of ['--danger-well', '--danger-well-hover', '--danger-tint']) {
    const own = [...css.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'gm'))].map((m) => m[1]);
    if (own.length === 0 || own.some((value) => !value.includes('var(--accent-danger)'))) {
      failures += 1;
      console.error(`[contrast] ${name} must be made from --accent-danger, not written as a second color: ${own.join(' | ')}`);
    }
  }
}

/* ---- The room tints to sweep ------------------------------------------------ */

const hsvToRgb = (h, sat, v) => {
  const c = v * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return [r + m, g + m, b + m].map((channel) => Math.round(channel * 255)).join(', ');
};

/* The clamp box. The room controller (WP-G8, `src/lib/room/color.ts`) writes
   only colors inside an HSV box: any hue, saturation 0..ROOM_CLAMP.saturationMax,
   value ROOM_CLAMP.valueMin..valueMax. The edges are read from that file, so
   the audit sweeps exactly what the room can write and the two cannot drift:
   every 15 degrees of hue at the box's low, middle and high saturation and
   value, plus the default room (ROOM_DEFAULT) and the two reference samples,
   which must lie inside the box too. */
const roomColorSource = fs.readFileSync(path.join(path.dirname(tokensPath), '..', 'lib', 'room', 'color.ts'), 'utf8');
const readRoomNumber = (name) => {
  const match = roomColorSource.match(new RegExp(`${name}:\\s*([0-9.]+)`));
  if (!match) throw new Error(`[contrast] ${name} not found in src/lib/room/color.ts`);
  return Number(match[1]);
};
const CLAMP = {
  saturationMax: readRoomNumber('saturationMax'),
  valueMin: readRoomNumber('valueMin'),
  valueMax: readRoomNumber('valueMax'),
};
const defaultMatch = roomColorSource.match(/ROOM_DEFAULT: Rgb = \[(\d+), (\d+), (\d+)\]/);
if (!defaultMatch) throw new Error('[contrast] ROOM_DEFAULT not found in src/lib/room/color.ts');
const rgbToHsv = (triplet) => {
  const [r, g, b] = triplet.split(',').map((c) => Number(c) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return { s: max === 0 ? 0 : (max - min) / max, v: max };
};

const namedTints = {
  'warm (spec §2.1)': extractBlocks('.glass-tint-warm')['--room-rgb'],
  'cool (spec §2.1)': extractBlocks('.glass-tint-cool')['--room-rgb'],
  'default room': defaultMatch.slice(1, 4).join(', '),
};
for (const [name, triplet] of Object.entries(namedTints)) {
  const { s, v } = rgbToHsv(triplet);
  if (s > CLAMP.saturationMax + 0.006 || v < CLAMP.valueMin - 0.006 || v > CLAMP.valueMax + 0.006) {
    failures += 1;
    console.error(`[contrast] ${name} (${triplet}) lies outside the room's clamp box (s ${s.toFixed(3)}, v ${v.toFixed(3)})`);
  }
}
const tints = { ...namedTints };
const boxSaturations = [0, CLAMP.saturationMax / 2, CLAMP.saturationMax];
const boxValues = [CLAMP.valueMin, (CLAMP.valueMin + CLAMP.valueMax) / 2, CLAMP.valueMax];
for (let hue = 0; hue < 360; hue += 15) {
  for (const sat of boxSaturations) {
    // Saturation 0 has no hue: sweep it once.
    if (sat === 0 && hue > 0) continue;
    for (const v of boxValues) tints[`hue ${hue} s${sat.toFixed(3)} v${v.toFixed(2)}`] = hsvToRgb(hue, sat, v);
  }
}

// Panes are translucent over the room. The backdrop is drawn at brightness .6
// (spec §4), so the brightest thing a pane can be over is 60% white.
const WORST_BACKDROP = { r: 153, g: 153, b: 153, a: 1 };
const SURFACES = ['--pane', '--bub', '--raise', '--sel', '--deep', '--solid', '--street', '--well'];
const INKS = [
  ['--ink-1', 7],
  ['--ink-2', 4.5],
  ['--ink-3', 4.5],
  ['--amber', 4.5],
  ['--amber-ink', 4.5],
];
// What High contrast is for. Its two ink steps are 12:1 and 7:1 (AAA), and
// every edge it draws is at least the 3:1 that non-text contrast asks for.
const INKS_HIGH_CONTRAST = [
  ['--ink-1', 12],
  ['--ink-2', 7],
  ['--ink-3', 7],
];

/**
 * A ground or surface, as it is seen. Opaque ones are just their color; a
 * translucent one is composited over the brightest backdrop the room can draw,
 * which is the worst case for light ink.
 */
function surfaceColor(name, vars, setting) {
  const value = resolveVar(name, vars);
  const color = value ? parseColor(value, `${setting}: ${name}`) : null;
  if (!color) throw new Error(`${setting}: unable to resolve ${name}`);
  return color.a < 1 ? blend(color, WORST_BACKDROP) : color;
}

function record(setting, fgName, bgName, ratio, min) {
  comparisons += 1;
  const headroom = ratio / min;
  if (worst.ratio === Infinity || headroom < worst.ratio / (worst.min ?? 1)) {
    worst = { ratio, min, setting, fg: fgName, bg: bgName };
  }
  if (ratio < min) {
    failures += 1;
    console.error(`[contrast] ${setting}: ${fgName} on ${bgName} ratio ${ratio.toFixed(2)} < ${min.toFixed(2)}`);
  }
}

/** The Lantern-named tokens the long tail of screens still reads. */
function legacyChecks(vars, setting) {
  for (const check of checks) {
    let fg;
    let bg;
    try {
      const fgValue = resolveVar(check.fg, vars);
      fg = fgValue ? parseColor(fgValue, `${setting}: ${check.fg}`) : null;
      if (check.over) {
        const bgValue = resolveVar(check.bg, vars);
        bg = bgValue ? parseColor(bgValue, `${setting}: ${check.bg}`) : null;
        if (bg) bg = blend(bg, surfaceColor(check.over, vars, setting));
      } else if (GROUNDS.includes(check.bg)) {
        bg = surfaceColor(check.bg, vars, setting);
      } else {
        const bgValue = resolveVar(check.bg, vars);
        bg = bgValue ? parseColor(bgValue, `${setting}: ${check.bg}`) : null;
      }
    } catch (error) {
      console.error(`[contrast] ${setting}: ${error.message}`);
      failures += 1;
      continue;
    }
    if (!fg || !bg) {
      console.error(`[contrast] ${setting}: unable to resolve ${check.fg} on ${check.bg}`);
      failures += 1;
      continue;
    }
    record(setting, check.fg, check.bg, contrastRatio(fg, bg), check.min);
  }
}

/** The Glass primitives (spec §2), for one theme at one room tint. */
function glassChecks(themeName, vars, setting) {
  const check = (fgName, bgColor, bgName, min) => {
    const fg = parseColor(resolveVar(fgName, vars), `${setting}: ${fgName}`);
    record(setting, fgName, bgName, contrastRatio(fg, bgColor), min);
  };
  const surfaces = Object.fromEntries(SURFACES.map((name) => [name, surfaceColor(name, vars, setting)]));
  // The glow washes the pane's far corner: measure the ink on pane + glow.
  const glow = parseColor(resolveVar('--glow', vars), `${setting}: --glow`);
  surfaces['--pane + --glow'] = blend(glow, surfaces['--pane']);
  const inks = isHighContrast(themeName)
    ? [...INKS_HIGH_CONTRAST, ...INKS.filter(([name]) => name.startsWith('--amber'))]
    : INKS;
  for (const [name, bg] of Object.entries(surfaces)) {
    for (const [ink, min] of inks) check(ink, bg, name, min);
  }
  // Ink over the glass controls, which sit on every one of those surfaces.
  for (const base of ['--pane', '--bub', '--solid', '--deep']) {
    for (const [fill, ink] of [
      ['--glass-fill', '--ink-1'],
      ['--glass-fill-hover', '--ink-1'],
      ['--glass-fill-on', '--ink-1'],
      ['--amber-on', '--amber-ink'],
    ]) {
      const over = blend(parseColor(resolveVar(fill, vars), fill), surfaces[base]);
      check(ink, over, `${fill} over ${base}`, 4.5);
    }
  }
  // Text on the near-black pill, and over the surfaces it floats above.
  const pill = blend(parseColor(resolveVar('--pill', vars), '--pill'), surfaces['--pane']);
  for (const [ink] of INKS) check(ink, pill, '--pill', 4.5);
  // Chips are solid tonal fills.
  for (const chip of ['--chip-count', '--chip-event', '--chip-react']) {
    check('--ink-1', parseColor(resolveVar(chip, vars), chip), chip, 4.5);
  }
  for (const base of ['--pane', '--bub', '--raise', '--solid']) {
    const chip = blend(parseColor(resolveVar('--amber-tint', vars), '--amber-tint'), surfaces[base]);
    check('--amber-ink', chip, `--amber-tint over ${base}`, 4.5);
  }
  // Fixed pairs (they do not move with the room, but they are part of the set).
  for (const [fg, bg] of [
    ['--own-ink', '--own-bub'],
    ['--mention-ink', '--mention-chip'],
    ['--join-ink', '--join'],
    ['--join-ink', '--join-hover'],
    ['--join-ink', '--join-press'],
  ]) {
    check(fg, parseColor(resolveVar(bg, vars), bg), bg, 7);
  }

  if (!isHighContrast(themeName)) return;

  // High contrast: nothing is see-through, and every edge can be seen.
  for (const name of ['--pane', '--deep']) {
    const alpha = parseColor(resolveVar(name, vars), name).a;
    comparisons += 1;
    if (alpha !== 1) {
      failures += 1;
      console.error(`[contrast] ${setting}: ${name} must be opaque in High contrast, alpha ${alpha.toFixed(2)}`);
    }
  }
  const plate = surfaceColor('--bg-plate', vars, setting);
  for (const [edge, base, baseName] of [
    ['--glass-hair', surfaces['--pane'], '--pane'],
    ['--border-subtle', plate, '--bg-plate'],
    ['--border-strong', plate, '--bg-plate'],
  ]) {
    const line = parseColor(resolveVar(edge, vars), `${setting}: ${edge}`);
    record(setting, edge, baseName, contrastRatio(blend(line, base), base), 3);
  }
}

for (const [themeName, overrides] of Object.entries(THEMES)) {
  if (isHighContrast(themeName) && Object.keys(overrides).length < 20) {
    failures += 1;
    console.error("[contrast] the [data-theme='glass-contrast'] block in tokens.css is missing or empty.");
    continue;
  }
  for (const [tintName, room] of Object.entries(tints)) {
    const setting = `${themeName} @ ${tintName} (${room})`;
    const vars = { ...themeBase, ...rootBase, ...overrides, '--room-rgb': room };
    try {
      legacyChecks(vars, setting);
      glassChecks(themeName, vars, setting);
    } catch (error) {
      failures += 1;
      console.error(`[contrast] ${setting}: ${error.message}`);
    }
  }
}

/* ---- Index (docs/index-spec.md §2) ------------------------------------------
   Hue is a number, so every server hue is a different set of surfaces. The
   recipes (sidebar gradient, selection, glow, avatar and mark fills and letters)
   are parsed out of ix-base.css with `--ix-hue` / `--ix-h` / `--ix-tint`
   substituted, so the audit measures what ships. The tokens are read from
   tokens.css. Set PARACORD_AUDIT_VERBOSE=1 for the table. */
const stylesDir = path.dirname(tokensPath);
const ixBaseCss = fs.readFileSync(path.join(stylesDir, 'ix-base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const hueSource = fs.readFileSync(path.join(stylesDir, '..', 'lib', 'identityHue.ts'), 'utf8');
const paletteMatch = hueSource.match(/PALETTE_HUES\s*=\s*\[([^\]]+)\]/);
if (!paletteMatch) throw new Error('[contrast] PALETTE_HUES not found in src/lib/identityHue.ts');
const PALETTE = paletteMatch[1].split(',').map((n) => Number(n.trim()));
if (PALETTE.some((hue) => hue >= 250 && hue <= 320)) {
  failures += 1;
  console.error('[contrast] PALETTE_HUES holds a purple (250-320): the palette has no purples (docs/index-spec.md §2.2).');
}
const IX_HUES = [...new Set([...Array.from({ length: 24 }, (_, i) => i * 15), 359, ...PALETTE])].sort((a, b) => a - b);

/** The declarations of the rule whose selector is exactly `selector`. */
function ixRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A rule starts at the top of the file or right after the `}` of the one before it
  // (so a selector that is the tail of a list, `.ix-av,\n.ix-sq`, is not a match).
  const found = ixBaseCss.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!found) throw new Error(`[contrast] ix-base.css has no rule "${selector}"`);
  return found[1];
}

/** One declaration's value inside a rule body. */
function ixDecl(body, property) {
  const found = body.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+);`));
  if (!found) throw new Error(`[contrast] ix-base.css: no "${property}" in "${body.trim().slice(0, 60)}…"`);
  return found[1].trim();
}

/** Every top-level hsl(...) call in a value, parentheses balanced. */
function hslCalls(value) {
  const out = [];
  let at = value.indexOf('hsl(');
  while (at !== -1) {
    let depth = 0;
    let end = at + 3;
    for (; end < value.length; end += 1) {
      if (value[end] === '(') depth += 1;
      else if (value[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(value.slice(at, end + 1));
    at = value.indexOf('hsl(', end);
  }
  return out;
}

function hslToRgb(h, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: 1 };
}

/** `hsl(var(--ix-hue) calc(24% * var(--ix-tint)) 14% / .3)` at a hue and a tint, as a color. */
function evalHsl(call, hue, tint) {
  const folded = foldCalc(
    call
      .replace(/var\(--ix-hue\)|var\(--ix-h\)/g, String(hue))
      .replace(/var\(--ix-tint\)/g, String(tint)),
  );
  const m = folded.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%?\s+([\d.]+)%?\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (!m) throw new Error(`[contrast] cannot read "${call}" (folded: "${folded}")`);
  return { ...hslToRgb(Number(m[1]), Number(m[2]), Number(m[3])), a: m[4] == null ? 1 : Number(m[4]) };
}

const mixRgb = (from, to, t) => ({
  r: from.r * (1 - t) + to.r * t,
  g: from.g * (1 - t) + to.g * t,
  b: from.b * (1 - t) + to.b * t,
  a: 1,
});

let ixComparisons = 0;
let ixWorst = { headroom: Infinity };
function ixRecord(setting, fgName, bgName, ratio, min) {
  comparisons += 1;
  ixComparisons += 1;
  const headroom = ratio / min;
  if (headroom < ixWorst.headroom) ixWorst = { headroom, ratio, min, setting, fg: fgName, bg: bgName };
  if (process.env.PARACORD_AUDIT_VERBOSE && headroom < 1.05) {
    console.log(`[index] ${setting}: ${fgName} on ${bgName} ${ratio.toFixed(2)} (floor ${min})`);
  }
  if (ratio < min) {
    failures += 1;
    console.error(`[contrast] ${setting}: ${fgName} on ${bgName} ratio ${ratio.toFixed(2)} < ${min.toFixed(2)}`);
  }
}

{
  // The sidebar gradient's stops and where its list zone sits: the first row of
  // a 900px window starts near 20% of the height, the mid stop is at 45%.
  const SIDE_FRACTIONS = { 'list top (20%)': 0.2, 'mid stop (45%)': 0.45, 'list foot (70%)': 0.7 };
  const sideBackground = ixDecl(ixRule('.ix-hue-side'), 'background');
  const [sideTopCall, sideMidCall] = hslCalls(sideBackground);
  if (!sideTopCall || !sideMidCall || !/var\(--ix-side-end\)/.test(sideBackground) || !/\b45%/.test(sideBackground)) {
    throw new Error('[contrast] .ix-hue-side must be: top hsl, mid hsl at 45%, then var(--ix-side-end)');
  }
  const mainBackground = ixDecl(ixRule('.ix-hue-main'), 'background');
  const glowGeometry = mainBackground.match(/radial-gradient\(\s*(\d+)px\s+(\d+)px\s+at\s+([\d.]+)%\s+(-?\d+)px/);
  const glowEnd = mainBackground.match(/transparent\s+(\d+)%/);
  const [glowCall] = hslCalls(mainBackground);
  if (!glowGeometry || !glowEnd || !glowCall) throw new Error('[contrast] .ix-hue-main must be a radial-gradient of one hsl to transparent');
  const glowRadiusY = Number(glowGeometry[2]);
  const glowCenterY = Number(glowGeometry[4]);
  const glowReach = Number(glowEnd[1]) / 100;

  const selectedRule = ixRule('.ix-hue-selected');
  const selectedHcRule = ixRule("[data-theme='glass-contrast'] .ix-hue-selected");

  const avatarRule = ixRule('.ix-av');
  const markRule = ixRule('.ix-sq');
  const avatarHcRule = ixRule("[data-theme='glass-contrast'] .ix-av");
  const markHcRule = ixRule("[data-theme='glass-contrast'] .ix-sq");
  const letterOf = (rule) => hslCalls(ixDecl(rule, 'color'))[0];
  const fillsOf = (rule) => hslCalls(ixDecl(rule, 'background'));

  for (const [themeName, overrides] of Object.entries(THEMES)) {
    const hc = isHighContrast(themeName);
    const vars = { ...themeBase, ...rootBase, ...overrides };
    const token = (name) => {
      const value = resolveVar(name, vars);
      const color = value ? parseColor(value, `index ${themeName}: ${name}`) : null;
      if (!color) throw new Error(`[contrast] index ${themeName}: unable to resolve ${name}`);
      return color;
    };
    const tint = Number(resolveVar('--ix-tint', vars));
    const ground = token('--ix-ground');
    const sideEnd = token('--ix-side-end');
    const main = token('--ix-main');
    const bubble = token('--ix-bubble');
    const card = token('--ix-card');
    const callSurface = token('--ix-call');
    // Ink steps are translucent: each is measured over the surface it lands on.
    const inks = hc
      ? [['--ix-ink', 7], ['--ix-ink-2', 7], ['--ix-ink-3', 7]]
      : [['--ix-ink', 7], ['--ix-ink-2', 4.5], ['--ix-ink-3', 4.5]];

    // The sidebar and the glow at one hue.
    const sweepHue = (hue) => {
      const setting = `index ${themeName} @ hue ${hue}`;
      const sideTop = evalHsl(sideTopCall, hue, tint);
      const sideMid = evalHsl(sideMidCall, hue, tint);
      const sideAt = (fraction) => (fraction <= 0.45 ? mixRgb(sideTop, sideMid, fraction / 0.45) : mixRgb(sideMid, sideEnd, (fraction - 0.45) / 0.55));
      const selectedFill = hc
        ? evalHsl(hslCalls(ixDecl(selectedHcRule, 'background'))[0], hue, tint)
        : evalHsl(hslCalls(ixDecl(selectedRule, 'background'))[0], hue, tint);
      const selectedOver = (base) => (hc ? selectedFill : blend(selectedFill, base));
      const glow = evalHsl(glowCall, hue, tint);
      // The strongest the glow gets under any text: the toolbar row, straight under its center.
      const glowAtToolbar = glow.a * Math.max(0, 1 - Math.abs(0 - glowCenterY) / glowRadiusY / glowReach);
      const surfaces = {
        'sidebar top': sideTop,
        'sidebar foot': sideEnd,
        ...Object.fromEntries(Object.entries(SIDE_FRACTIONS).map(([name, fraction]) => [`sidebar ${name}`, sideAt(fraction)])),
        ...Object.fromEntries(Object.entries(SIDE_FRACTIONS).map(([name, fraction]) => [`selection over ${name}`, selectedOver(sideAt(fraction))])),
        main,
        'main + glow at the toolbar': blend({ ...glow, a: glowAtToolbar }, main),
        bubble,
        card,
        call: callSurface,
      };
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        for (const [inkName, min] of inks) {
          ixRecord(setting, inkName, surfaceName, contrastRatio(token(inkName), surface), min);
        }
      }

      // The selection's edge shows in High contrast; in the default theme the
      // selection is a tint by design (the prototype), carried by ink and aria-current.
      if (hc) {
        const edge = evalHsl(hslCalls(ixDecl(selectedHcRule, 'box-shadow'))[0], hue, tint);
        ixRecord(setting, 'selection edge', 'selection fill', contrastRatio(blend(edge, selectedFill), selectedFill), 3);
      }

      // The live card: amber on its tint over the list zone, yours and not yours.
      const cardOver = (tokenName, base) => {
        const stops = resolveVar(tokenName, vars).match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g) ?? [];
        // The strongest stop is the first; text sits over the whole card, so use it.
        const first = parseColor(stops[0], tokenName);
        return blend(first, base);
      };
      const amber = token('--ix-amber');
      for (const [name, tokenName] of [['room card', '--ix-room-bg'], ['your room card', '--ix-room-bg-yours']]) {
        ixRecord(setting, '--ix-amber', name, contrastRatio(amber, cardOver(tokenName, sideAt(0.2))), 4.5);
        ixRecord(setting, '--ix-ink-2', name, contrastRatio(token('--ix-ink-2'), cardOver(tokenName, sideAt(0.2))), hc ? 7 : 4.5);
      }

      // Avatars and server marks: the letter against its fill.
      const marks = [
        ['avatar', letterOf(hc ? avatarHcRule : avatarRule), fillsOf(hc ? avatarHcRule : avatarRule), 4.5, 7],
        ['server mark', letterOf(hc ? markHcRule : markRule), fillsOf(hc ? markHcRule : markRule), 4.5, 7],
      ];
      for (const [kind, letterCall, fillCalls, floor, floorHc] of marks) {
        if (!letterCall || fillCalls.length !== 2) throw new Error(`[contrast] ${kind}: needs a letter and a two-stop gradient`);
        const letter = evalHsl(letterCall, hue, tint);
        const [start, end] = fillCalls.map((call) => evalHsl(call, hue, tint));
        const lightest = luminance(start) >= luminance(end) ? start : end;
        // The letter sits in the middle of the tile, where the gradient is halfway.
        ixRecord(setting, `${kind} letter`, `${kind} fill (middle)`, contrastRatio(letter, mixRgb(start, end, 0.5)), hc ? floorHc : floor);
        // Against the lightest corner it only has to be a legible graphic (3:1), 7:1 in High contrast.
        ixRecord(setting, `${kind} letter`, `${kind} fill (lightest corner)`, contrastRatio(letter, lightest), hc ? floorHc : 3);
      }
    };
    for (const hue of IX_HUES) sweepHue(hue);

    // Pairs that do not move with the hue.
    const fixed = (fgName, bg, bgName, min) => ixRecord(`index ${themeName}`, fgName, bgName, contrastRatio(token(fgName), bg), min);
    for (const name of ['--ix-cream', '--ix-cream-hover', '--ix-cream-press']) {
      fixed('--ix-cream-ink', token(name), name, 7);
    }
    fixed('--ix-mention-ink', token('--ix-ink'), '--ix-ink (the mention chip)', 7);
    for (const [surfaceName, surface, fillName] of [
      ['sidebar foot', sideEnd, '--ix-danger-fill'],
      ['card', card, '--ix-danger-fill'],
      ['main', main, '--ix-danger-fill'],
      ['call', callSurface, '--ix-danger-fill-call'],
    ]) {
      fixed('--ix-danger-ink', blend(token(fillName), surface), `${fillName} over ${surfaceName}`, 4.5);
    }
    fixed('--ix-amber', callSurface, 'call', 4.5);
    // The focus ring is a UI component: 3:1 against every ground it can sit on.
    const focus = parseColor((resolveVar('--ix-focus', vars).match(/(rgba?\([^)]*\)|#[0-9a-f]{3,6})\s*$/i) ?? [])[1] ?? '', '--ix-focus');
    if (!focus) throw new Error('[contrast] --ix-focus must end in a color');
    for (const [name, surface] of [['--ix-ground', ground], ['--ix-main', main], ['--ix-side-end', sideEnd], ['--ix-card', card], ['--ix-bubble', bubble]]) {
      ixRecord(`index ${themeName}`, '--ix-focus', name, contrastRatio(focus, surface), 3);
    }
  }

  // Exactly one place writes each of the ink and danger colors.
  for (const name of ['--ix-danger-ink', '--ix-ink-3', '--ix-cream']) {
    const declarations = css.match(new RegExp(`^\\s*${name}\\s*:`, 'gm')) ?? [];
    const expected = name === '--ix-ink-3' ? 2 : 1; // the base value and High contrast's
    if (declarations.length !== expected) {
      failures += 1;
      console.error(`[contrast] ${name} is declared ${declarations.length} times in tokens.css; expected ${expected}.`);
    }
  }
}

/* ---- Glass reference tints (spec §2.1) --------------------------------------
   The default theme's derivation has to reproduce the two reference tints, not
   merely look like them. CIE76 delta-E in Lab (D65) on the resolved sRGB, under
   2; alpha within .005; the glow, which is 7% opaque, is compared as it lands on
   its own pane. Set PARACORD_AUDIT_VERBOSE=1 for the table. */
const glassVars = (room) => ({ ...themeBase, ...rootBase, '--room-rgb': room });
const REFERENCE = {
  'warm (spec §2.1)': {
    '--pane': [28, 25, 23, 0.94], '--bub': [45, 41, 38], '--raise': [56, 51, 47], '--sel': [54, 49, 45],
    '--deep': [20, 18, 16, 0.96], '--solid': [28, 25, 23], '--glow': [255, 168, 88, 0.07],
  },
  'cool (spec §2.1)': {
    '--pane': [23, 27, 31, 0.94], '--bub': [39, 45, 52], '--raise': [49, 56, 64], '--sel': [47, 54, 63],
    '--deep': [16, 18, 21, 0.96], '--solid': [24, 28, 32], '--glow': [150, 190, 230, 0.07],
  },
};
const toLab = ({ r, g, b }) => {
  const [R, G, B] = [r, g, b].map((c) => linearFromSrgb(c / 255));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const deltaE = (p, q) => Math.hypot(...toLab(p).map((v, i) => v - toLab(q)[i]));
let worstDelta = 0;
for (const [tintName, expected] of Object.entries(REFERENCE)) {
  const vars = glassVars(namedTints[tintName]);
  const solid = parseColor(resolveVar('--solid', vars), '--solid');
  for (const [name, [r, g, b, a = 1]] of Object.entries(expected)) {
    const setting = `glass ${tintName}: ${name}`;
    try {
      const got = parseColor(resolveVar(name, vars), setting);
      // Browsers round each channel to 8 bits when they paint.
      const rounded = { r: Math.round(got.r), g: Math.round(got.g), b: Math.round(got.b) };
      const target = { r, g, b };
      const seenGot = name === '--glow' ? blend({ ...rounded, a: got.a }, solid) : rounded;
      const seenWant = name === '--glow' ? blend({ ...target, a }, solid) : target;
      const delta = deltaE(seenGot, seenWant);
      worstDelta = Math.max(worstDelta, delta);
      if (process.env.PARACORD_AUDIT_VERBOSE) {
        console.log(`[glass] ${tintName.padEnd(17)} ${name.padEnd(8)} got ${rounded.r},${rounded.g},${rounded.b} a=${got.a.toFixed(2)}  want ${r},${g},${b} a=${a}  dE ${delta.toFixed(2)}`);
      }
      if (delta >= 2 || Math.abs(got.a - a) > 0.005) {
        failures += 1;
        console.error(`[contrast] ${setting} misses the reference: dE ${delta.toFixed(2)}, alpha ${got.a.toFixed(3)} vs ${a}`);
      }
    } catch (error) {
      failures += 1;
      console.error(`[contrast] ${setting}: ${error.message}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n[contrast] ${failures} failing pair(s).`);
  process.exit(1);
}

console.log(
  `[contrast] ${comparisons} comparisons passed — ${Object.keys(THEMES).length} themes `
    + `(${Object.keys(THEMES).join(', ')}) x ${Object.keys(tints).length} room tints `
    + `(${Object.keys(namedTints).join(', ')}, and the clamp box: s 0..${CLAMP.saturationMax}, `
    + `v ${CLAMP.valueMin}..${CLAMP.valueMax}, every 15 degrees).`,
);
console.log(
  `[contrast] index: ${ixComparisons} comparisons passed over ${IX_HUES.length} hues (0-359 in 15 degree steps, the ${PALETTE.length} palette hues) x 2 themes; `
    + `tightest: ${ixWorst.fg} on ${ixWorst.bg} at ${ixWorst.setting} — ${ixWorst.ratio.toFixed(2)} against a floor of ${ixWorst.min}.`,
);
console.log('[contrast] one danger ink: --accent-danger is declared once and every other danger token is made from it.');
console.log(`[contrast] glass reference tints reproduced: worst delta-E ${worstDelta.toFixed(2)} (limit 2).`);
console.log(
  `[contrast] tightest margin: ${worst.fg} on ${worst.bg} at ${worst.setting} — `
    + `${worst.ratio.toFixed(2)} against a floor of ${worst.min}.`,
);
