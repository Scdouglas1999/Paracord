/**
 * The contrast audit (docs/lantern-stage-spec.md §9).
 *
 * Every ground, well, hairline, wash and grey ink in `tokens.css` is written
 * `oklch(L C var(--ui-hue))`: the ramp is L and C, and the user picks H in
 * Settings › Appearance. That is the whole safety argument for a configurable
 * base colour — relative luminance is carried almost entirely by L at these
 * chromas, so holding L and C and moving only H leaves every pair where it was.
 *
 * "Almost entirely" is not "entirely", so this script does not take the
 * argument on trust: it resolves the tokens for real, sweeping the hue around
 * the whole circle every 30 degrees, at full tint and at none, against all four
 * themes, and fails if any pair drops below its floor at any setting. It also
 * fails on a token that lands outside sRGB, because a browser would gamut-map
 * it and the measured colour would no longer be the one written down.
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

/* ---- Colour ---------------------------------------------------------------- */

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

function parseColor(value, label) {
  const normalized = value.trim().toLowerCase();

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
const rootBase = extractBlocks(':root');
const daylight = extractBlocks("[data-theme='light']");
const themeBlocks = {
  night: {},
  daylight,
  amoled: extractBlocks("[data-theme='amoled']"),
  'high-contrast': extractBlocks("[data-theme='high-contrast']"),
  // The looks (§1.8). Dusk sky and Voices stand on Night's set, Paper & ink on
  // Daylight's — the same inheritance the selectors in tokens.css give them.
  'dusk sky': extractBlocks("[data-theme='dusk']"),
  voices: extractBlocks("[data-theme='voices']"),
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
 * Most grounds are opaque and this is just the colour. A look may make them
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
  `[contrast] tightest margin: ${worst.fg} on ${worst.bg} at ${worst.setting} — `
    + `${worst.ratio.toFixed(2)} against a floor of ${worst.min}.`,
);
