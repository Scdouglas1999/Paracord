# Paracord's mark

The mark is a hurricane lantern carried on a braided teal paracord handle: a
550-cord weave with an amber tracer, lark's-head hitches through the eyelets, a
hanging tail with a knurled metal tip, and PARACORD engraved on the tank. It
sits on a rounded Slate tile when it is an app icon.

`mark.html` is the source of truth. It draws the mark procedurally on a canvas,
so every icon, the loading screen and the in-app mark are rendered from it.
Nothing downstream is edited by hand.

## Regenerating everything

From the repository root:

```bash
node client/brand/render.mjs            # masters, then every derived file
node client/brand/render.mjs masters    # only the 2048 px masters, into client/brand/out/
node client/brand/render.mjs derive     # only the derived files, from existing masters
```

It needs Playwright's Chromium (a client devDependency, so `npm install` in
`client/` covers it) and ImageMagick 7 (`magick`). `client/brand/out/` is the
scratch folder for the masters and is not committed.

What it writes:

| Where | What |
|---|---|
| `client/src-tauri/icons/` | Every desktop, iOS and Android icon, via `npx tauri icon`, then the 32 px, 30 px and 44 px files and `icon.ico` redrawn from the small variant |
| `client/public/` | `favicon.ico` (16-48, small variant), `pwa-64/192/512`, `maskable-icon-512x512.png` (inside the 80% safe circle), `apple-touch-icon-180x180.png` |
| `client/public/brand/` | The in-app mark (`mark-64.webp`, `mark-small-32.webp`, used by `AppMark`) and the loading screen's layers (`splash-*.webp`, `wordmark.webp`) |
| `docs/images/brand/` | `banner.png` (the README banner), `banner-light.png`, `mark-512.png` |

## Parameters

`mark.html` reads them from the URL hash, for example `mark.html#bg=0&cord=0`:

| Param | Effect |
|---|---|
| `bg=0` | No Slate tile: transparent around the drawing |
| `lantern=0` | The cord only (the loading screen's cord layer) |
| `cord=0` | The lantern only |
| `lit=0` | The unlit lantern, dimmed and desaturated (the loading screen's first beat) |
| `small=1` | The small-size variant for 16-48 px: the same silhouette drawn larger in the tile, a bolder cord and thicker guard wires, and no engraving, rivets, vent slots, fiber lines, wall rings or grain |
| `ground=0` | No floor shadow, floor light or lamp wash: only the lantern and cord, for the in-app mark, which is trimmed to the drawing |

`banner.html` composes the README banner and the bare wordmark (Gabarito 800)
from the masters.

## The loading screen

`client/index.html` layers four of these files and animates them in pure CSS,
from the first paint, with no script: the unlit lantern fades up, the cord draws
itself on (a conic mask swept by an `@property` angle), the lantern lights and
the wordmark resolves from blur, about 2 s in all. `client/src/lib/bootSplash.ts`
hands it off to the app; `BrandSplash.tsx` draws its final frame for the states
that are still loading. The timings are the marketing film's, compressed.
