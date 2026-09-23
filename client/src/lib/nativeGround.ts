import { logVoiceDiagnostic } from './desktopDiagnostics';
import { isTauri } from './tauriEnv';

/**
 * Telling the desktop shell what the ground is.
 *
 * On Linux a live stream renders on a native GL surface BELOW the webview, and
 * the webview's own background is cleared so the DOM can punch a hole down to
 * it (see `layout.css`, "Native video underlay hole"). Everything the DOM then
 * leaves transparent with no video beneath it — the shell gutters around a
 * tile, a hidden surface's backdrop — falls through to the GTK toplevel, and
 * that has to read as the app's own background rather than as GTK theme grey.
 *
 * The shell used to paint it `#0a0c10`, which was `--bg-base` back when the
 * ground was one fixed colour. It is not one colour any more: the base is
 * `oklch(16.5% calc(0.007 * var(--ui-chroma)) var(--ui-hue))` and the person
 * picks the hue and the tint, so a literal in the shell reads cold against
 * every setting except the one it was copied from. Only the renderer knows what
 * the ground resolved to, so the renderer says so.
 *
 * Nothing here runs in the browser build, and — the hard rule, learned the
 * expensive way — **nothing here reports a colour it did not actually read**.
 * A ground that cannot be read yet is waited for and then declined out loud,
 * never rounded to a plausible dark.
 */

/** The custom property that IS the ground. One name, in one place. */
const GROUND_PROPERTY = '--bg-base';

/**
 * A colour no theme in this app uses, painted and READ BACK before the real one
 * is offered to the same canvas.
 *
 * A 2D canvas starts out black and `fillStyle` silently keeps its previous
 * value when handed something it cannot parse. The first version of this module
 * set the sentinel and compared the `fillStyle` string — which does not catch
 * the case where the *setter itself* never takes: the fill is then still the
 * canvas's own opaque black, the comparison against the sentinel says "not the
 * sentinel, so it parsed", and the module hands the shell `#000000` with
 * complete confidence. That is a colour no theme defines, and it is what the
 * user's window was painted. So the sentinel is now proved by the pixel:
 * unless the canvas can demonstrably paint magenta and read magenta back,
 * nothing it says afterwards is believed.
 */
const SENTINEL = '#ff00ff';
const SENTINEL_PIXEL: readonly [number, number, number, number] = [255, 0, 255, 255];

/** How long to wait for a ground that is not readable yet, in frames. */
const READ_ATTEMPTS = 90;

const hex2 = (value: number) => value.toString(16).padStart(2, '0');

type Pixel = [number, number, number, number];

/** What one read of the ground came back with. */
export interface GroundReading {
  /** `#rrggbb`, or null when the ground could not be read. */
  hex: string | null;
  /** What the renderer computed for the ground, verbatim. For the log. */
  computed: string;
  /** Why it could not be read. Empty when it could. */
  why: string;
}

function paintAndRead(ctx: CanvasRenderingContext2D, color: string): Pixel | null {
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  } catch {
    return null;
  }
}

const isSentinel = (pixel: Pixel) => SENTINEL_PIXEL.every((channel, i) => pixel[i] === channel);

/**
 * Any CSS colour the renderer can compute → `#rrggbb`, or a reason it could
 * not be read.
 *
 * Through a 1×1 canvas rather than by parsing, because `getComputedStyle`
 * returns a colour in the space it was written in — `oklch(0.165 0.007 65)` —
 * and the shell needs sRGB bytes. Every failure is a refusal, never a value:
 * the pipeline proves itself on the sentinel first, so black can only ever come
 * back when black is what the engine actually painted.
 */
export function readCssColor(color: string, doc: Document = document): GroundReading {
  const computed = color.trim();
  if (computed === '') return { hex: null, computed, why: 'the renderer computed no color at all' };

  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { hex: null, computed, why: 'this engine has no 2d canvas to resolve a color with' };

  const proof = paintAndRead(ctx, SENTINEL);
  if (!proof || !isSentinel(proof)) {
    return {
      hex: null,
      computed,
      why: `the canvas could not paint ${SENTINEL} and read it back (got ${proof ? proof.join(',') : 'nothing'})`,
    };
  }

  const painted = paintAndRead(ctx, computed);
  if (!painted) return { hex: null, computed, why: 'the painted pixel could not be read back' };
  if (painted[3] === 0) return { hex: null, computed, why: 'it painted nothing at all — the ground is transparent' };
  if (isSentinel(painted) && computed.toLowerCase() !== SENTINEL) {
    return { hex: null, computed, why: 'the engine refused the color and left the sentinel standing' };
  }
  return { hex: `#${hex2(painted[0])}${hex2(painted[1])}${hex2(painted[2])}`, computed, why: '' };
}

/** Back-compat shape for callers that only want the colour. */
export function cssColorToHex(color: string, doc: Document = document): string | null {
  return readCssColor(color, doc).hex;
}

/**
 * What `--bg-base` resolves to right now, as `#rrggbb`.
 *
 * Read off a probe rather than off the custom property, because the computed
 * value of `--bg-base` is still `oklch(16.5% calc(0.007 * 1) 65)` — `var()` is
 * substituted, `calc()` is not evaluated, and nothing has been converted to a
 * colour. Painting it on an element is what makes the engine resolve it.
 *
 * Two things have to be true before the probe is even worth painting, and both
 * are false for a moment at boot: the app's stylesheet has to be in effect, so
 * `--bg-base` is declared at all, and the app has to have published which theme
 * it is showing, so what is declared is the ground the person will actually
 * see. Before that `var(--bg-base)` substitutes nothing and paints nothing —
 * a state to wait out, not to report.
 *
 * The probe hangs off `<html>`, not `<body>`: while the underlay hole is open
 * the body's background is deliberately transparent. Every declaration on it
 * goes through the CSSOM — `style.setProperty`, the same call `useTheme` writes
 * `--ui-hue` with — and never as a `style` attribute or a stylesheet of its
 * own. Tauri stamps a nonce onto the document's style-src, which disables the
 * 'unsafe-inline' the app declares (`9efc214`, which is how Custom CSS silently
 * did nothing). CSSOM writes are outside that policy; this probe deliberately
 * stays inside the part that is.
 */
export function resolveGroundColor(doc: Document = document): GroundReading {
  const root = doc.documentElement;
  const view = doc.defaultView;
  if (!root || !view) return { hex: null, computed: '', why: 'there is no document to read the ground off' };

  if (!root.hasAttribute('data-theme')) {
    return { hex: null, computed: '', why: 'the app has not published a theme yet' };
  }
  const declared = view.getComputedStyle(root).getPropertyValue(GROUND_PROPERTY).trim();
  if (declared === '') {
    return { hex: null, computed: '', why: `${GROUND_PROPERTY} is not declared yet — no stylesheet in effect` };
  }

  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  for (const [property, value] of [
    ['position', 'absolute'],
    ['left', '-9999px'],
    ['top', '0'],
    ['width', '0'],
    ['height', '0'],
    ['pointer-events', 'none'],
    ['background-color', `var(${GROUND_PROPERTY})`],
  ] as const) {
    probe.style.setProperty(property, value);
  }
  root.appendChild(probe);
  try {
    return readCssColor(view.getComputedStyle(probe).backgroundColor, doc);
  } finally {
    probe.remove();
  }
}

/** Minimal invoke shape, so this is testable without the Tauri runtime. */
export type GroundInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let lastReported: string | null = null;

/** Forget what the shell was last told (test seam, and a relaunch's reset). */
export function resetGroundColorReport(): void {
  lastReported = null;
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise((r) => setTimeout(r, 16));
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Read the ground, waiting out the moment at boot when it is not readable yet.
 *
 * Bounded: a ground that never becomes readable is a thing to say out loud, not
 * to poll for forever.
 */
async function readGroundWhenReadable(doc: Document = document): Promise<GroundReading> {
  let reading = resolveGroundColor(doc);
  for (let attempt = 0; reading.hex === null && attempt < READ_ATTEMPTS; attempt += 1) {
    await nextFrame();
    reading = resolveGroundColor(doc);
  }
  return reading;
}

/**
 * Tell the shell the ground colour, if it changed.
 *
 * Called on every change to the theme, the accent, the base hue and tint and
 * the committed custom CSS, and again whenever an underlay hole opens — every
 * moment the colour behind the hole can be wrong. A no-op in the browser build;
 * loud, in the client log, when the ground cannot be read or the shell refuses
 * what it is told. Nothing is cached unless it was actually read, so a boot
 * that could not see the ground does not poison every later report.
 */
export async function reportGroundColor(invoke?: GroundInvoke): Promise<void> {
  if (typeof document === 'undefined') return;
  if (!invoke && !isTauri()) return;

  const reading = await readGroundWhenReadable();
  if (reading.hex === null) {
    logVoiceDiagnostic(`[native-render] the ground could not be read; the shell keeps the ground it has`, {
      why: reading.why,
      computed: reading.computed,
      theme: document.documentElement.getAttribute('data-theme'),
    });
    return;
  }
  if (reading.hex === lastReported) return;

  const send = invoke ?? (await import('@tauri-apps/api/core')).invoke;
  try {
    await send('native_render_set_ground_color', { color: reading.hex });
    lastReported = reading.hex;
    logVoiceDiagnostic(`[native-render] ground reported as ${reading.hex}`, {
      computed: reading.computed,
      theme: document.documentElement.getAttribute('data-theme'),
    });
  } catch (err) {
    logVoiceDiagnostic(`[native-render] the shell refused the ground color ${reading.hex}`, { err: String(err) });
  }
}
