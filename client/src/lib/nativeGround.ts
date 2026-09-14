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
 * Nothing here runs in the browser build, and nothing here invents a colour: a
 * ground it cannot read is reported as unread, not guessed at.
 */

/** The custom property that IS the ground. One name, in one place. */
const GROUND_PROPERTY = '--bg-base';

/**
 * A colour no stylesheet in this app uses, parked in the canvas before the real
 * one is offered to it. `fillStyle` silently keeps its previous value when it
 * is handed something it cannot parse, so without a sentinel an engine with no
 * `oklch()` in canvas would report black with complete confidence.
 */
const SENTINEL = '#ff00ff';

const hex2 = (value: number) => value.toString(16).padStart(2, '0');

/**
 * Any CSS colour the renderer can compute → `#rrggbb`.
 *
 * Through a 1×1 canvas rather than by parsing, because `getComputedStyle`
 * returns a colour in the space it was written in — `oklch(0.165 0.007 65)` —
 * and the shell needs sRGB bytes. Returns null when the engine could not read
 * the colour, which the caller reports rather than papers over.
 */
export function cssColorToHex(color: string, doc: Document = document): string | null {
  const trimmed = color.trim();
  if (trimmed === '') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = SENTINEL;
  ctx.fillStyle = trimmed;
  // Still the sentinel, and the colour asked for was not the sentinel: the
  // engine refused it. Say so.
  if (ctx.fillStyle === SENTINEL && trimmed.toLowerCase() !== SENTINEL) return null;
  ctx.fillRect(0, 0, 1, 1);
  try {
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  } catch {
    return null;
  }
}

/**
 * What `--bg-base` resolves to right now, as `#rrggbb`.
 *
 * Read off a probe rather than off the custom property, because the computed
 * value of `--bg-base` is still `oklch(16.5% calc(0.007 * 1) 65)` — `var()` is
 * substituted, `calc()` is not evaluated, and nothing has been converted to a
 * colour. Painting it on an element is what makes the engine resolve it.
 *
 * The probe hangs off `<html>`, not `<body>`: while the underlay hole is open
 * the body's background is deliberately transparent.
 *
 * Every declaration is set through the CSSOM — `style.setProperty`, the same
 * call `useTheme` writes `--ui-hue` with — and never as a `style` attribute or
 * a stylesheet of its own. Tauri stamps a nonce onto the document's
 * `style-src`, which disables the `'unsafe-inline'` the app declares, so a
 * stylesheet minted at runtime is refused unless it carries that nonce
 * (`9efc214`, which is how Custom CSS silently did nothing). CSSOM writes are
 * outside that policy; this probe deliberately stays inside the part that is.
 */
export function resolveGroundColor(doc: Document = document): string | null {
  const root = doc.documentElement;
  if (!root) return null;
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
    const view = doc.defaultView;
    const painted = view ? view.getComputedStyle(probe).backgroundColor : '';
    return cssColorToHex(painted, doc);
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

/**
 * Tell the shell the ground colour, if it changed.
 *
 * Called on every change to the theme, the base hue and the base tint, and
 * again whenever an underlay hole opens — the two moments the colour behind the
 * hole can be wrong. A no-op in the browser build; loud, in the client log,
 * when the shell refuses it or the ground cannot be read.
 */
export async function reportGroundColor(invoke?: GroundInvoke): Promise<void> {
  if (typeof document === 'undefined') return;
  if (!invoke && !isTauri()) return;
  const color = resolveGroundColor();
  if (color === null) {
    console.warn(`[native-render] could not resolve ${GROUND_PROPERTY}; the shell keeps the ground it has`);
    return;
  }
  if (color === lastReported) return;
  const send = invoke ?? (await import('@tauri-apps/api/core')).invoke;
  try {
    await send('native_render_set_ground_color', { color });
    lastReported = color;
  } catch (err) {
    console.warn(`[native-render] the shell refused the ground colour ${color}:`, err);
  }
}
