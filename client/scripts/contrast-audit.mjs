/**
 * The contrast audit (docs/lantern-stage-spec.md §9).
 *
 * Every ground, well, hairline, wash and gray ink in `tokens.css` is written
 * `oklch(L C var(--ui-hue))`: the ramp is L and C, and the user picks H in
 * Settings › Appearance. That is the whole safety argument for a configurable
 * base color — relative luminance is carried almost entirely by L at these
 * chromas, so holding L and C and moving only H leaves every pair where it was.
 *
 * "Almost entirely" is not "entirely", so this script does not take the
 * argument on trust: it resolves the tokens for real, sweeping the hue around
 * the whole circle every 30 degrees, at full tint and at none, against all four
 * themes, and fails if any pair drops below its floor at any setting. It also
 * fails on a token that lands outside sRGB, because a browser would gamut-map
 * it and the measured color would no longer be the one written down.
 *
 * GLASS (docs/glass-spec.md §2, §9). The default theme's surfaces are not a
 * fixed ramp: they are `color-mix()` of one channel triplet, `--room-rgb`, into
 * neutral steps, and the room controller (WP-G8) writes that triplet from the
 * live stream. So the Glass section below resolves the real tokens and sweeps
 * the room over the two reference tints (spec §2.1), a dim warm and a bright
 * cool tint, and a hue x saturation x brightness grid that covers the clamp box
 * WP-G8 will enforce (plus the two extremes, white and black), and requires
 * 4.5:1 for every text pair on every Glass surface. Panes are translucent, so
 * they are measured over the brightest backdrop the room can draw.
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
// The Glass surfaces are derived per subtree (`:root, .glass-room`), which the
// `:root {` pattern does not see; read that block by its second selector.
const glassRoom = extractBlocks('.glass-room');
const rootBase = { ...extractBlocks(':root'), ...glassRoom };
const daylight = extractBlocks("[data-theme='light']");
const themeBlocks = {
  night: {},
  daylight,
  amoled: extractBlocks("[data-theme='amoled']"),
  'high-contrast': extractBlocks("[data-theme='high-contrast']"),
  // The looks (§1.8). Dusk sky, Slate and Aubergine stand on Night's set, Paper & ink on
  // Daylight's — the same inheritance the selectors in tokens.css give them.
  'dusk sky': extractBlocks("[data-theme='dusk']"),
  slate: extractBlocks("[data-theme='slate']"),
  aubergine: extractBlocks("[data-theme='voices']"),
  'paper & ink': { ...daylight, ...extractBlocks("[data-theme='paper']") },
};

// docs/lantern-stage-spec.md §9 (Accessibility, non-negotiable):
//   body text >= 7:1 on plates, meta >= 4.5:1, white-light Join ink >= 12:1,
//   emerald on plate >= 4.5:1 for text.
// Every ramp step is checked against every ground it can actually land on —
// a token that only passes on the darkest surface is not passing.
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
  // Action and semantics as text on a plate.
  ...GROUNDS.map((bg) => ({ fg: '--accent-primary', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-danger', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-warning', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--accent-info', bg, min: 4.5 })),
  // Ink on a fill.
  { fg: '--text-on-light', bg: '--light-white', min: 12 },
  { fg: '--text-on-accent', bg: '--accent-primary', min: 4.5 },
  { fg: '--text-on-danger', bg: '--danger-well', min: 4.5 },
  // The two lights must stay legible as a label as well as a fill.
  ...GROUNDS.map((bg) => ({ fg: '--light-white', bg, min: 4.5 })),
  ...GROUNDS.map((bg) => ({ fg: '--light-amber', bg, min: 4.5 })),
  // A lit channel thumbnail carries its LIVE label and its occupants' names on
  // a tinted frame of its own, not on any of the four grounds above.
  { fg: '--light-white', bg: '--thumb-frame-lit', min: 4.5 },
  { fg: '--text-primary', bg: '--thumb-frame-lit', min: 7 },
  // An author's name is written in their identity's ink (§1.2 / the Blend).
  // Eight hues x four grounds: a name is a name, so 4.5:1 is the floor.
  ...IDENTITY_INKS.flatMap((fg) => GROUNDS.map((bg) => ({ fg, bg, min: 4.5 }))),
  // Ink on the row you are on: the selection wash is translucent, so the real
  // question is the ink over wash-over-plate.
  { fg: '--text-primary', bg: '--row-selected', over: '--bg-plate', min: 7 },
  { fg: '--text-secondary', bg: '--row-selected', over: '--bg-plate', min: 4.5 },
  { fg: '--text-primary', bg: '--bg-mod-strong', over: '--bg-plate', min: 7 },
  // Yard numbers, end-zone letters and the digits inside a pitch marker.
  // The field is a fixed green, so these pairs do not move with --ui-hue.
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

// Paper & ink's spine: the sidebar is a block of cobalt with an ink set of its
// own. Only a theme that declares `--spine-bg` is asked these.
const spineChecks = [
  ...['--spine-bg', '--spine-well', '--spine-raised'].flatMap((bg) => [
    { fg: '--spine-accent', bg, min: 4.5 },
    { fg: '--spine-danger', bg, min: 4.5 },
    { fg: '--spine-text-primary', bg, min: 7 },
    { fg: '--spine-text-secondary', bg, min: 4.5 },
    { fg: '--spine-text-muted', bg, min: 4.5 },
    { fg: '--spine-text-faint', bg, min: 4.5 },
    { fg: '--spine-light-amber', bg, min: 4.5 },
  ]),
  { fg: '--spine-selected-ink', bg: '--spine-selected', min: 4.5 },
];

/**
 * Voices' bubbles. A bubble is `color-mix(in srgb, <author> M, <plate>)`, which
 * is exactly an alpha blend, so it can be measured here. Eight authors: the
 * body ink, the meta ink, a link and the author's own name all have to read on
 * each. Your own bubble is the same recipe at a stronger mix, so it is measured
 * the same way.
 */
function bubbleChecks(vars, setting) {
  const out = [];
  const mix = Number(resolveVar('--bubble-mix', vars));
  const ownMix = Number(resolveVar('--bubble-own-mix', vars));
  const plate = groundColor('--bg-plate', vars, setting);
  for (let i = 1; i <= 8; i += 1) {
    const who = parseColor(resolveVar(`--color-avatar-${i}`, vars), `${setting}: avatar ${i}`);
    for (const [amount, name] of [[mix, `bubble ${i}`], [ownMix, `own bubble ${i}`]]) {
      const bubble = blend({ ...who, a: amount }, plate);
      out.push({ fg: '--text-body-ink', bgColor: bubble, bgName: name, min: 7 });
      out.push({ fg: '--text-faint', bgColor: bubble, bgName: name, min: 4.5 });
      out.push({ fg: `--identity-ink-${i}`, bgColor: bubble, bgName: name, min: 4.5 });
      out.push({ fg: '--text-link', bgColor: bubble, bgName: name, min: 4.5 });
    }
  }
  return out;
}

/**
 * A ground, as it will actually be seen.
 *
 * Most grounds are opaque and this is just the color. A look may make them
 * translucent over a painted backdrop (Dusk sky): the plate and the street
 * scrim then sit over `--audit-backdrop` — the BRIGHTEST point of that
 * backdrop, the worst case for light ink — and everything inside a plate sits
 * over that composite. A translucent ground with no declared backdrop cannot
 * be measured, and says so rather than being waved through.
 */
function groundColor(name, vars, setting) {
  const value = resolveVar(name, vars);
  const color = value ? parseColor(value, `${setting}: ${name}`) : null;
  if (!color) throw new Error(`unable to resolve ${name}`);
  if (!(color.a < 1)) return color;
  const backdropValue = resolveVar('--audit-backdrop', vars);
  if (!backdropValue) throw new Error(`${name} is translucent and the theme declares no --audit-backdrop`);
  const backdrop = parseColor(backdropValue, `${setting}: --audit-backdrop`);
  if (name === '--bg-plate' || name === '--street-scrim') return blend(color, backdrop);
  return blend(color, groundColor('--bg-plate', vars, setting));
}

// The whole circle, every 30 degrees, at full tint and at none. `--ui-chroma: 0`
// is the "neutral charcoal" preset, where the hue stops meaning anything — it is
// swept anyway, because a zero that only works at one hue is not a zero.
const HUES = Array.from({ length: 12 }, (_, i) => i * 30);
const TINTS = [1, 0];

let failures = 0;
let worst = { ratio: Infinity };
let comparisons = 0;

for (const [themeName, overrides] of Object.entries(themeBlocks)) {
  for (const hue of HUES) {
    for (const tint of TINTS) {
      const vars = {
        ...themeBase,
        ...rootBase,
        ...overrides,
        '--ui-hue': String(hue),
        '--ui-chroma': String(tint),
      };
      const setting = `${themeName} hue ${hue} tint ${tint}`;
      // Where the street is a painted sky, street-level ink sits on the scrim
      // over it, not on `--bg-base` (which is then only what the desktop shell
      // is told to paint behind a native video underlay).
      const painted = vars['--audit-backdrop'] != null;
      let themeChecks = painted
        ? checks.map((check) => (check.bg === '--bg-base' ? { ...check, bg: '--street-scrim' } : check))
        : checks;
      if (vars['--spine-bg'] != null) themeChecks = [...themeChecks, ...spineChecks];
      // Bubbles are audited where a look turns them on — the block that
      // declares its own `--bubble-mix` — not in themes that only inherit it.
      try {
        if (overrides['--bubble-mix'] != null) themeChecks = [...themeChecks, ...bubbleChecks(vars, setting)];
      } catch (error) {
        console.error(`[contrast] ${setting}: bubbles: ${error.message}`);
        failures += 1;
      }
      for (const check of themeChecks) {
        let fg;
        let bg;
        try {
          const fgValue = resolveVar(check.fg, vars);
          fg = fgValue ? parseColor(fgValue, `${setting}: ${check.fg}`) : null;
          if (check.bgColor) {
            bg = check.bgColor;
          } else if (check.over) {
            const bgValue = resolveVar(check.bg, vars);
            bg = bgValue ? parseColor(bgValue, `${setting}: ${check.bg}`) : null;
            if (bg) bg = blend(bg, groundColor(check.over, vars, setting));
          } else if (GROUNDS.includes(check.bg) || check.bg === '--street-scrim') {
            bg = groundColor(check.bg, vars, setting);
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
          console.error(`[contrast] ${setting}: unable to resolve ${check.fg} on ${check.bgName ?? check.bg}`);
          failures += 1;
          continue;
        }
        const ratio = contrastRatio(fg, bg);
        comparisons += 1;
        const headroom = ratio / check.min;
        if (headroom < worst.ratio / (worst.min ?? 1) || worst.ratio === Infinity) {
          worst = { ratio, min: check.min, setting, fg: check.fg, bg: check.bgName ?? check.bg };
        }
        if (ratio < check.min) {
          failures += 1;
          console.error(
            `[contrast] ${setting}: ${check.fg} on ${check.bgName ?? check.bg}`
              + ` ratio ${ratio.toFixed(2)} < ${check.min.toFixed(2)}`,
          );
        }
      }
    }
  }
}


/* ---- Glass (docs/glass-spec.md §2, §9) ------------------------------------- */

const parseTriplet = (value) => {
  const [r, g, b] = value.split(',').map((part) => Number(part.trim()));
  return { r, g, b };
};

const hsvToRgb = (h, sat, v) => {
  const c = v * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return [r + m, g + m, b + m].map((channel) => Math.round(channel * 255)).join(', ');
};

const namedTints = {
  'warm (spec §2.1)': extractBlocks('.glass-tint-warm')['--room-rgb'],
  'cool (spec §2.1)': extractBlocks('.glass-tint-cool')['--room-rgb'],
  'dim warm': '150, 96, 52',
  'bright cool': '150, 200, 255',
  'white (extreme)': '255, 255, 255',
  'black (extreme)': '0, 0, 0',
};
const tints = { ...namedTints };
// The clamp box: every hue at three saturations and three brightnesses.
for (let hue = 0; hue < 360; hue += 30) {
  for (const sat of [0.3, 0.65, 1]) {
    for (const v of [0.35, 0.7, 1]) tints[`hue ${hue} s${sat} v${v}`] = hsvToRgb(hue, sat, v);
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

/** A surface as it is seen: translucent ones over the worst backdrop, and the
    far-corner glow over the pane it lights. */
function glassSurface(name, vars, setting) {
  const value = resolveVar(name, vars);
  const color = value ? parseColor(value, `${setting}: ${name}`) : null;
  if (!color) throw new Error(`${setting}: unable to resolve ${name}`);
  return color.a < 1 ? blend(color, WORST_BACKDROP) : color;
}

let glassComparisons = 0;
const glassVars = (room) => ({ ...themeBase, ...rootBase, '--room-rgb': room });
for (const [tintName, room] of Object.entries(tints)) {
  const setting = `glass ${tintName} (${room})`;
  const vars = glassVars(room);
  try {
    const check = (fgName, bgColor, bgName, min, fgColor) => {
      const fg = fgColor ?? parseColor(resolveVar(fgName, vars), `${setting}: ${fgName}`);
      const ratio = contrastRatio(fg, bgColor);
      glassComparisons += 1;
      const headroom = ratio / min;
      if (headroom < worst.ratio / (worst.min ?? 1)) worst = { ratio, min, setting, fg: fgName, bg: bgName };
      if (ratio < min) {
        failures += 1;
        console.error(`[contrast] ${setting}: ${fgName} on ${bgName} ratio ${ratio.toFixed(2)} < ${min.toFixed(2)}`);
      }
    };
    const surfaces = Object.fromEntries(SURFACES.map((name) => [name, glassSurface(name, vars, setting)]));
    // The glow washes the pane's far corner: measure the ink on pane + glow.
    const glow = parseColor(resolveVar('--glow', vars), `${setting}: --glow`);
    surfaces['--pane + --glow'] = blend(glow, surfaces['--pane']);
    // The token itself must stay inside the cap: a surface never drifts from
    // its neutral by more than 6% of the room.
    for (const [name, bg] of Object.entries(surfaces)) {
      for (const [ink, min] of INKS) check(ink, bg, name, min);
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
    check('--ink-1', parseColor(resolveVar('--chip-count', vars), '--chip-count'), '--chip-count', 4.5);
    check('--ink-1', parseColor(resolveVar('--chip-event', vars), '--chip-event'), '--chip-event', 4.5);
    check('--ink-1', parseColor(resolveVar('--chip-react', vars), '--chip-react'), '--chip-react', 4.5);
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
  } catch (error) {
    failures += 1;
    console.error(`[contrast] ${setting}: ${error.message}`);
  }
}

/* ---- Glass reference tints (spec §2.1) --------------------------------------
   The derivation has to reproduce the two reference tints, not merely look
   like them. CIE76 delta-E in Lab (D65) on the resolved sRGB, under 2; alpha
   within .005; the glow, which is 7% opaque, is compared as it lands on its
   own pane. Set PARACORD_AUDIT_VERBOSE=1 for the table. */
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
  `[contrast] ${comparisons} comparisons passed — ${Object.keys(themeBlocks).length} themes and looks x `
    + `${HUES.length} hues x ${TINTS.length} tints `
    + '(docs/lantern-stage-spec.md §9).',
);
console.log(
  `[contrast] glass: ${glassComparisons} comparisons passed over ${Object.keys(tints).length} room tints `
    + `(${Object.keys(namedTints).join(', ')}, and a hue x saturation x brightness grid).`,
);
console.log(`[contrast] glass reference tints reproduced: worst delta-E ${worstDelta.toFixed(2)} (limit 2).`);
console.log(
  `[contrast] tightest margin: ${worst.fg} on ${worst.bg} at ${worst.setting} — `
    + `${worst.ratio.toFixed(2)} against a floor of ${worst.min}.`,
);
