# Paracord's mark

The mark is "Thread": a single paracord looped into a P. A straight stem, a
round bowl, and the bowl's end threaded under the stem and out the other side
as a short tail. It is drawn as real paracord, flat and precise: a braided
sheath (staggered chevron cells in two lanes), darker shaded edges, and fused
ends (a smooth cap a little darker than the cord, with a thin ring where the
braid stops). The colorway is Ember. As an app icon it sits on a rounded
warm-dark tile (`linear-gradient(160deg, #2b2420, #131214)`, 22.5% corners).

`mark.html` is the source of truth. It draws every variant procedurally as SVG,
so every icon, the in-app mark, the loading screen and the motion data are
generated from it. Nothing downstream is edited by hand. Open it in a browser
to see the variants.

## Level of detail

The centerline is the same at every size; the detail steps down:

| Level | Where | Drawing |
|---|---|---|
| `full` | 64 px and up | the full braid, edges, fused ends, cord width 14 |
| `mid` | 24-63 px (the dock's 34 px) | a coarser braid, cord width 14 |
| `flat` | below 24 px (tabs, buttons) | plain cord, fused ends and the crossing gap, cord width 16 |
| `mono` | trays, inline spinners | `flat` in one light color (in the app, `currentColor`) |

The crossing gap is real transparency (a mask cut around the stem), so the
mark works on any ground: gradients, the tile, the app's surfaces.

## Regenerating everything

From the repository root:

```bash
node client/brand/render.mjs            # everything below, in order
node client/brand/render.mjs masters    # the SVG art and the 2048 px PNG masters (client/brand/out/)
node client/brand/render.mjs derive     # the derived icons, from existing masters
node client/brand/render.mjs code       # CordMark's geometry and CSS, and the loading screen in index.html
node client/brand/render.mjs readme     # the README's animated mark
```

It needs Playwright's Chromium (a client devDependency, so `npm install` in
`client/` covers it) and ImageMagick 7 (`magick`). `client/brand/out/` is the
scratch folder for the masters and is not committed.

What it writes:

| Where | What |
|---|---|
| `client/src-tauri/icons/` | Every desktop, iOS and Android icon, via `npx tauri icon` from the tile; then `32x32.png`, `Square30x30Logo.png`, `Square44x44Logo.png` and `icon.ico` (16-256) redrawn at the level for their size, and `tray-mono-64.png` |
| `client/public/` | `favicon.ico` (the bare mark: flat at 16-32, mid at 48), `pwa-64/192/512` (the tile), `maskable-icon-512x512.png` (inside the 80% safe circle), `apple-touch-icon-180x180.png` (full-bleed tile) |
| `client/public/brand/` | The in-app art: `cord-{full,mid,flat}.svg` (the whole mark), `cord-{full,mid,flat}-under.svg` (the bowl's second half and tail alone, for the drawing animation), `cord-mono.svg`, and the loading screen's `wordmark.webp` |
| `client/src/components/brand/` | `cordGeometry.ts` (centerline paths, widths, the highlight) and `cordMark.css` (every keyframe) |
| `client/index.html` | The loading screen's mark markup and keyframes, between the `cord-mark` markers |
| `docs/images/brand/` | `banner.png` (the README banner), `banner-light.png`, `mark-512.png`, and `paracord.webp` (the README's animated mark) |

`banner.html` composes the banners, the bare wordmark (Gabarito 800) and the
README animation from the art.

## Motion

`motion.mjs` turns the geometry into CSS. No script runs per frame: the art is
static, and each animated mark masks it with strokes along the cord's
centerline (round caps, a hair wider than the cord) whose
`stroke-dasharray`/`stroke-dashoffset` are the only things that move. The cord
is revealed in two halves so the crossing stays right while it draws: the
stem and the bowl's first half reveal the whole art, the rest reveals the
`-under` art, and a third stroke cuts the gap out of the under half only where
the stem has already been drawn.

| Motion | What it does |
|---|---|
| `draw` | Draws on once, 1 s, easing out: up the stem, around the bowl, under the stem |
| `loading` | Starts whole, pulls out through its tail, draws back in; 1.7 s a cycle |
| `working` | Stays whole while a soft highlight (three concentric dashes) runs along the cord, 1.6 s |

`CordMark` (`client/src/components/brand/CordMark.tsx`) picks the level from
its size and draws the still mark as one `<img>`. Under reduced motion it is
always still; looping marks pause offscreen and while the window is hidden.
`CordSpinner` is the inline one-color loader.

## The loading screen

`client/index.html` draws the Ember mark on in pure CSS from the first paint,
with no script, then resolves the wordmark from blur: about 1.1 s in all.
`client/src/lib/bootSplash.ts` hands it off to the app; `BrandSplash.tsx` draws
its final frame for the states that are still loading, and starts the
`loading` loop (which begins whole) once the loading screen has started to
leave.
