# brand-cord: the Thread mark replaces the lantern

The owner-approved "Thread" mark (Ember) is Paracord's mark everywhere: every
OS and web icon, the in-app mark, the loading screen, and the app's loaders.

## What was built

**Brand pipeline (`client/brand/`).** `mark.html` is still the single
procedural source of truth, now emitting SVG. It carries the approved geometry
(`loopMark({phi:130, cross:80, l1:15, l2:24, R:24})`, cord width 14, 16 for
the flat level) and the approved renderer (`cord2.js`'s braid cells, edges,
fused ends) unchanged in look. Compared side by side with the reference page's
Ember render, proportions, braid density, ends and crossing match. One change
from the reference, as asked: the crossing gap is a real cut-out (an SVG mask
around the stem) instead of paint in the ground's color.
`render.mjs` regenerates everything: Tauri icons (desktop, iOS, Android via
`npx tauri icon`, then `32x32`, `Square30x30`, `Square44x44` and `icon.ico`
redrawn at the right level), `favicon.ico`, `pwa-*`, maskable (mark's box at
56% so the drawing stays in the 80% circle), Apple touch, the in-app art
(`public/brand/cord-{full,mid,flat}[-under].svg`, `cord-mono.svg`), the
banners, `mark-512`, the README's animated mark, and the generated code
(`cordGeometry.ts`, `cordMark.css`, the loading screen block in `index.html`
between `cord-mark` markers). `motion.mjs` computes the keyframes.
The lantern layers (`splash-lantern*`, `splash-cord`, `mark-64`,
`mark-small-32`) are deleted. README.md (root) shows the new animated mark.

**Level of detail.** `full` from 64 px, `mid` (coarser braid) from 24 px,
`flat` (plain cord, fused ends, the gap, w16) below. `mono` is flat in one
light color (trays) or `currentColor` (in the app).

**`CordMark`** (`client/src/components/brand/CordMark.tsx`): `size`, `motion`
(`none | draw | loading | working`), `tone` (`ember | mono`), `paused`,
`label`. Still marks are one `<img>`. Animated marks are an inline SVG with two
`<image>`s of static art, each under a mask whose strokes run along the
centerline (round caps, cord width + 0.6). Only `stroke-dasharray` /
`stroke-dashoffset` animate, in CSS. The stem half reveals the whole art; the
under half reveals `-under` art (drawn without the stem), minus a halo stroke
that cuts the gap only where the stem has been drawn, so the crossing is right
at every frame of drawing in and pulling out. `working` adds three concentric
low-opacity dashes per half (a soft band) running along the cord.
Loops pause offscreen (one shared IntersectionObserver sets
`data-offscreen`), the app pauses all loops while the window is hidden
(lib/motion/visibility), and reduced motion (OS or the app's setting) draws
the still mark. `CordSpinner` = `CordMark tone="mono" motion="loading"` at
16 px for buttons and one-line status rows; the mono mark is one
`currentColor` fill cut by a mask, so translucent text colors do not double
up where the halves meet. Mono `working` falls back to `loading` (the
highlight needs a braid). Logic in `cordMarkModel.ts`, tests in
`CordMark.test.tsx`.

**Timings.** draw 1000 ms ease-out (cubic); loading 1.7 s cycle (whole,
pull out through the tail with in-out easing, draw back in, whole); working
1.6 s linear.

**Boot splash.** `index.html` draws the Ember mark on from first paint
(starts at 60 ms, 1 s), the wordmark resolves at 700 ms for 420 ms: done
at about 1.12 s (was 2 s). Script-free; preloads `cord-full.svg` and
`cord-full-under.svg`. `BrandSplash` renders the same markup with `CordMark`
(`motion="loading"`, `paused` until `useBootSplashGone()`), so the hand-off
is one still picture and the loop then starts from the whole mark.
`.pc-boot.is-static` no longer stills the mark inside it.

## Loaders replaced

- `components/ui/Feedback.tsx` `LoadingSpinner` (covers ~25 call sites):
  `md` → ember `CordMark loading` 40 px above the label, `lg` → 56 px, `sm` →
  `CordSpinner` beside the label. Sites: DailyWordSection, FeedsSection,
  ForumView (x2), GameServersSection, GuildSettings, EconomySettingsSection,
  OnboardingSettingsSection, ChannelPermissionsEditor, MessageEditHistoryDialog,
  SlashCommandPopup (x2), SportsSettingsSection, ChannelManager,
  GuildSettingsPage, AddonsPanel, BotAdvancedTabs, FederationPanel (x2),
  TemplateGalleryPage, DeveloperPage, SecurityPanel, AdminPage, BackupsPanel.
- `components/ui/Button.tsx` `loading` → `CordSpinner`.
- `App.tsx` `LazyFallback` (in-shell lazy route) → `CordMark loading` 40
  (was the breathing lantern; `pc-mark-breathe` CSS removed).
- `App.tsx` BrandSplash states (Restoring session, Connecting, Loading
  account settings, Signing in with this device's key, Just a moment,
  Loading) → BrandSplash's `loading` motion.
- `components/ix/sidebar/ServerUnavailable.tsx` connecting state →
  `CordMark working` 40 above "Connecting to {name}…" (`.ix-sb__mark`).
- `pages/InstanceSetupPage.tsx` "Checking this instance…" → AuthHeading's mark
  with `markMotion="working"` (new prop).
- `components/voice/ScreenSharePickerModal.tsx` "Looking for screens and
  windows…" (CSS ring) → `CordMark loading` 40 above the text.
- Inline `Loader2` → `CordSpinner` (16, 18 in the send button):
  GameServerSheet and AddFeedSheet "Checking…", AutomodSection (x3),
  MessageComponents bot button busy (its rotate CSS removed), RemindersPane,
  InteractionModal "Submitting…", MessageInput (command note, send button),
  TogetherSheet (x2), ServerConnectPage status well, FederationPanel (x5),
  OverviewPanel, BackupsPanel (x3).
- The remaining lantern marks (AuthScaffold heading, OnboardingWizard,
  UserSettings › About, the App error screens, DesignTokensPage) use
  `CordMark`; DesignTokensPage's Mark section shows the sizes and motions.

Left alone on purpose: `RefreshCw` icons that spin inside refresh/reconnect
buttons (InviteModal, UserSettings sessions, ScreenSharePicker refresh,
ServerConnectPage Reconnect: the button's own glyph in motion), the
VoiceConnectionCheck step icon set (a status glyph among check/x icons),
skeleton loaders (GuildLoadingScreen, Discovery grid, ServerWaitNote), and
text-only notes ("Loading channels…", "Loading templates…", "Loading saved
messages…", "Loading invite…").

## Verification

- `npm run typecheck` clean; `npm run test:unit` 460 files / 4663 tests pass;
  `npm run lint` 0 errors (warnings unchanged in touched files);
  `npm run build` passes and ships `dist/brand/cord-*.svg`.
- Screenshots (headless Chromium) in the session scratchpad `brand-shots/`:
  `compare-full.png` (reference vs. ours), `mark-preview.png`,
  `icon-1024-half.png`, `icon-set-small.png` (128, 34, 16 tile, 16 favicon),
  `splash-sequence.png`, `splash-zoom.png`, `brandsplash-loading.png`,
  `motion-{loading,working,button,loading44}.png`, `loaders-in-place.png`,
  `app-root-300.png` (sign-in with the mark), `banners.png`, `readme-strip.png`.

## Open

- WebKitGTK (offscreen snapshots, scratchpad `wk-snap.py`) renders every
  motion at 16/40/56/184 px and mono the same as Chromium, and the boot splash
  draws on in it. The dark-brown bowl seen there was not a mask difference: it
  was the loading screen fading out half-drawn over a BrandSplash that mounted
  after the app's first commit. bootSplash now brings the loading screen back
  when a splash arrives during its fade, plays it to the end, and leaves over
  the splash. A glossy blue cord under file:// is WebKit's missing-image
  placeholder (the art's absolute /brand/ paths); served normally it is fine.
  The halo cut now has butt caps, so a stem pulling out no longer notches the
  under strand. WKWebView/WebView2 are still unchecked.
- The tray still uses the window icon (`tray.rs`, unchanged). A monochrome
  tray asset is emitted (`src-tauri/icons/tray-mono-64.png`); switching to it
  is a Rust change and a per-platform decision (light panels).
- The index theme has no light variant, so only dark was checked.
- The drawing head is the braid cut round by the mask's round cap; the
  reference painted a melted cap on the moving head. A tiny round dot shows at
  the very start of each draw-in for the same reason.
- `client/dist` / the embedded UI is not rebuilt into the server binary here.
