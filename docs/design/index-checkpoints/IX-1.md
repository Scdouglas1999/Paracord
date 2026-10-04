# IX-1 checkpoint: Foundation (colors, avatars and server marks)

Contract: `docs/index-spec.md` §2 (tokens, hue, avatars and marks, glyphs), §3.1 (primitive
metrics), §10 (High contrast). Plan row: `docs/design/index-plan.md` §3 (IX-1).
Worktree `~/Documents/Paracord-index`, branch `feat/index-ui`.

## What the next packages get

### Hue (`client/src/lib/identityHue.ts`)

```ts
PALETTE_HUES  // [350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226]  (no purples)
PEOPLE_HUE    // 210
paletteHue(id: string): number          // id mod 11 over the last 9 decimal digits; non-decimal ids hash onto the same list
serverHue(g: { id: string; hue?: number | null }): number   // g.hue if an integer 0-359, else paletteHue(g.id)
isHue(v: unknown): v is number          // integer 0-359 (what the server stores)
```

JS passes numbers; CSS builds colors. Two scopes of hue variable, both plain numbers, never animated:

- `--ix-hue` on a tinted layer (a place): used by the `ix-hue-*` classes below.
- `--ix-h` on one avatar or mark: set by the components, or by you when you write an `.ix-av` by hand.

### Identity (`client/src/components/ix/identity`, import from `.../ix/identity`)

```tsx
<Avatar userId name avatar? size?=32 hue? presence? ring? label? className? style? />
<ServerMark guildId name icon? hue? size?=34 radius? fontSize? label? className? style? />
<AvatarStack people={[{userId,name,avatar?}]} size?=24 overlap?=7 max? ring? />
<PresenceDot status ring? size? inline? />       // also: presenceKind(status)
monogramOf(name) / monogramFontSize(size, 'person'|'server') / graphemes(text)
```

- `avatar` is the stored value (`avatar_hash`); `icon` the stored icon (`icon_hash ?? icon`). They resolve the
  URL the way the app already does (`resolveUserAvatarUrl`, `resolveGuildIconUrl`, `useAuthenticatedImage`,
  `useDownloadTicket`), so callers pass the raw field. An uploaded picture always wins; one that fails to load
  falls back to the monogram until its URL changes.
- `hue` on `Avatar` overrides the person's hue (a call tile on a fixed hue). On `ServerMark`, `hue` is the guild's
  own `guild.hue` (nullable): pass `guild.hue` straight through and it falls back to the id's.
- Monogram: the first grapheme that is a letter or a digit, uppercased, one grapheme only. A name that starts with
  a symbol or emoji (`@jeremy`, `🔥 Fire pit`) takes the first letter after it; a name with none takes the first
  grapheme as it is; empty is `?`. (This refines the spec's "first grapheme of the display name" so a leading
  symbol does not become the whole identity.)
- Sizes: the component sets `width`, `height`, `font-size` inline (44% of the size, rounded; a person at 88px
  and above 36%). `ServerMark` radius is 28% in CSS; the Welcome mark passes `radius={22} fontSize={34}` (76px).
- Both are `aria-hidden` unless you pass `label` (`role="img"`). Put the name in text beside them.
- Presence: `presence` on `Avatar` draws the dot (online and `streaming` solid ink, idle ink-3, dnd a hollow
  ring, offline and invisible nothing); the dot is 10px (8 under 30px). Its 2.5px ring is the surface behind:
  pass `ring="var(--ix-main)"` or set `--ix-ring` on an ancestor; the default is `--ix-side-end` (the sidebar).
  The state must also be in the control's accessible name (`presenceLabel`).
- `AvatarStack` is the room card's "and N more" and a busy room row: `ring` is the surface (the card's color).
- The recipes are `.ix-av` / `.ix-sq` in `client/src/styles/ix-base.css`, copied from the prototype's `.av` and
  `.sq` (a test pins every value). A hairline over an uploaded image is drawn by `.ix-has-img::after`. Rules that
  another sheet's ring must be able to replace are inside `:where()`.

`Face` (`components/glass/places/Lead.tsx`) now renders `Avatar` (keeping the `glass-face` class so the rings
and dimming other sheets draw still apply), so every existing face (Home, DMs, live rows, the pill, sheets,
profile, search) switched at once. `FaceStack` follows. `initialsOf` stays only for the timeline's own avatar
until IX-11 rebuilds it.

### Primitives (`components/ix/primitives`)

```tsx
<CreamButton size?='md'|'sm' grow? ...button />          // 36px r11 14/700; sm = padding 8 12 r10 13.5/600
<Control label tone?='default'|'danger' pressed? ...button />   // 36x36 r11, glyph 16 ink-2; pressed => aria-pressed + amber glyph
<WideControl tone? ...button />                          // flex 1, 13.5/600 ink
<ToolChip ...button />                                   // padding 6 10 r8, glyph 14
<SectionLabel as?='div'|'h2'|'h3' count? id? />          // 12.5/600 ink-3, padding 16 8 6
<Hairline orientation? length? decorative? />            // 1px --ix-line; vertical default 24px
```

`Control` requires `label` (aria-label). `--ix-ctl-size` sets the control side (40px on phone). All share the
one focus ring (`outline: var(--ix-focus)`, offset `--ix-focus-offset`), disabled = opacity .45, hover/press
colors only (color transitions, 120ms).

### Glyphs (`components/ix/glyphs`)

`<IxGlyph name size?=18 title? />`, `IX_GLYPH_NAMES`, and `<GlyphFrame size?>` (the 24-grid, stroke 1.7, round
caps frame, for a one-off glyph; all of them `currentColor`, `.ix-glyph` class). Names: speaker, mic, micOff,
camera, screen, x, search, people, dots, invite, plan, hello, attach, poll, event, send, plus, chevron (down),
check, lock, megaphone, stage (podium), phone, and the call view's verbs listen, watch, clip, flame, theater
(Glass paths restroked to 1.7). Prototype paths are verbatim (a test pins them); lock, megaphone, stage, phone,
check and micOff are mine, drawn in the same hand.

### Hue-derived classes (`ix-base.css`)

Set `--ix-hue` (a number) on the element or an ancestor:

| Class | Spec | Notes |
|---|---|---|
| `.ix-hue-side` | sidebar ground | the three-stop gradient; no hairline (IX-4 adds the right edge) |
| `.ix-hue-main` | main glow over `--ix-main` | |
| `.ix-hue-selected` | selected channel | background + inset 1px edge; opaque with a visible edge in High contrast |
| `.ix-hue-tile` | action-card glyph tile | background and glyph color |
| `.ix-hue-weekday` | event weekday | color |
| `.ix-hue-halo` | message box focus halo | fade it by opacity; never animate the shadow |

`--ix-tint` (1; .5 in High contrast) scales their strength. Nothing here animates `--ix-hue`: a hue change is a
crossfade of two layers (IX-4).

### Tokens (`styles/tokens.css`, the Index block before "Sports field")

Every `--ix-*` in spec §2.1, plus the prototype's other literal colors by role so nobody types one: washes
(`--ix-wash-hover`, `--ix-fill-field`, `--ix-fill-card`, `--ix-fill-card-hover`, `--ix-fill-ctl`,
`--ix-fill-ctl-hover`, `--ix-fill-btn`), edges (`--ix-edge-side`, `--ix-edge-lit`, `--ix-edge-strong`,
`--ix-edge-open`), the card (`--ix-room-bg`, `--ix-room-bg-yours`, `--ix-amber-edge`, `--ix-amber-edge-yours`,
`--ix-room-dark`), shadows (`--ix-shadow-room`, `-room-yours`, `-event`, `-call`, `--ix-glow-talk`), danger
(`--ix-danger-fill-call`), `--ix-tile-end`, `--ix-mention-ink`, `--ix-toolbar-fold` (.92, no blur, per §4.9),
`--ix-pop` (switcher), `--ix-ring-default`, `--ix-cream-hover`, `--ix-spring`, `--ix-ease`, `--ix-hue`, `--ix-tint`.
High contrast overrides sit in a `[data-theme='glass-contrast']` block right after (§10).
Need another literal color? Add a token in that block (IX-1 owns it until M1/IX-19); write one declaration per line
(the contrast audit reads the block line by line) and keep `--name: value` text out of comments.

Remapped (so every screen not yet rebuilt follows): `--join`, `-ink`, `-hover`, `-press` -> cream (`--accent-primary`
and friends follow; supersedes the 2026-10-03 slate-blue), `--accent-primary-rgb` -> `244, 242, 237`, `--own-bub` /
`--own-ink` -> cream and its ink, `--accent-danger` -> `--ix-danger-ink` (still declared once; every other danger
token is made from it). The Glass ink ramp (`--ink-1..3`) is NOT remapped: `--ix-ink-*` live on Index surfaces only.

### Stylesheets

`styles/ix-{base,shell,sidebar,dock,card,cards,sheets,pages,timeline,composer,conversation,call,people,phone}.css`
exist and are imported in that order in `globals.css`, **unlayered and after every Glass sheet** (before
`utilities.css`), so an Index rule wins a tie with the Glass rule it replaces. Only `ix-base.css` has content;
the others are one comment line naming their owner package (overwrite them). Because they are unlayered, a Tailwind
utility at a call site loses to an `ix-*` rule that sets the same property: set sizes in the stylesheet, not by
utility, on Index components.

## Decisions and deviations

1. **`--ix-ink-3` is `.62`, not the prototype's `.5`** (recorded in `docs/index-spec.md` §2.1, per its own rule).
   At .5 the audit fails at every hue: others' bubble 4.34:1, event card 4.23:1, sidebar top 4.49:1 at hue 8, the
   selected row 4.11:1 at hue 0 and 3.35:1 at hue 60 (strict top stop). The smallest step that passes every
   surface at every swept hue is .62 (selection near the top of the list at hue 60 needs .615). What drives it is
   the selected row's preview text: every other surface passes at about .53 and the 11 palette hues alone need .60.
   If the owner would rather keep the quieter ink-3, IX-5 can set the selected row's preview in ink-2 and ink-3
   can drop to about .55; that is an owner call, nothing is blocked on it.
2. **The spec's "selection edge 3:1" cannot hold in the default theme** (the edge is `hsl(h 60% 72% / .12)`, the
   prototype's value, about 1.1:1). It is enforced in High contrast only (opaque selection, 70% edge). The default
   theme carries selection by tint, ink and `aria-current`. Flagging it as a spec inconsistency, not changing it.
3. **Server-mark letter contrast** with the spec's `hsl(h 85% 90%)` on `hsl(h 44% 38%)` is 3.37:1 against the
   lightest corner at hue 60 (3.61 on the palette). The audit holds the letter to 4.5:1 against the middle of the
   diagonal (where it sits; worst 4.99) and 3:1 against the lightest corner (a legible graphic beside the server's
   name as text). Avatars pass 4.5 at both stops (worst 5.53). Spec values are unchanged.
4. **High contrast hardening** (the spec only gives ink, hairlines, bubbles, focus and tint): avatars use fills
   30/22 and 27/16, letter `hsl(h 90% 96%)`, edge .5; marks 44/24 and 40/15 with the same letter; selection is
   `hsl(h 24% 15%)` opaque with a .7 edge. All audited at 7:1 (letters, ink steps) and 3:1 (selection edge).
5. **Danger and cream remap** went one step further than the plan's "(`--accent-primary` etc.)": `--accent-danger`
   now resolves to the Index pink-salmon `#ffb3a8` everywhere, and your own bubbles are the Index cream. Old
   screens therefore already show the one danger color and the cream action.
6. `Avatar` presence dot, `AvatarStack`, `GlyphFrame` and the extra glyphs are additions beyond the plan's list.
7. The plan names the checkpoint `docs/design/index-ix1-checkpoint.md`; the orchestrator's preamble says
   `docs/design/index-checkpoints/IX-1.md`. I followed the preamble.

## Files

New: `client/src/lib/identityHue.ts` (+ test), `client/src/components/ix/{identity,primitives,glyphs}/**`
(components, `index.ts` barrels, 5 test files, `IndexShowcase.tsx`), `client/src/styles/ix-*.css` (14),
`client/src/styles/indexTokens.test.ts`, this file.
Edited: `client/src/styles/tokens.css` (Index block, remap), `client/src/styles/globals.css` (imports),
`client/src/lib/colors.ts` (deprecation notes only), `client/src/components/glass/places/Lead.tsx` (`Face` internals),
`client/scripts/contrast-audit.mjs` (Index sweep), `client/src/pages/DesignTokensPage.tsx` (Index section),
`docs/index-spec.md` (ink-3 row only).
Tests outside my scope that I had to touch because `Face`/the tokens changed (one line each):
`client/src/components/glass/places/PlaceRows.test.tsx` ('NV' -> one letter 'N'),
`client/src/components/glass/primitives/glassTokens.test.ts` (join/own/danger now point at the Index tokens).

## Verification (commands run in `client/`)

- `npm run typecheck`: my files clean. One error remains, `src/gateway/dispatch.ts(206)`: `hue` is not in type
  `Guild`. That is IX-2's in-flight edit (it adds `hue` in `dispatch.ts` and the contract fixtures; the type lands
  with its `types/guild.types.ts` change). Not mine.
- `npm run test:unit` (full): 4306 passed, 6 failed, none from IX-1.
  Pre-existing at HEAD (reproduced on a clean `git archive HEAD` copy): `useGlassKeybinds` "S browses, T switches
  layouts, H hides the chat in theater only", `AppShell` "hides the conversation in theater only when the chat is
  hidden", `stageTransition` "T: the stage pane grows to the window…" (the theater-hides-chat default of 19db3e60).
  IX-2's in flight: `readyGuildContract` (2, the new `hue` field). One failure was mine and is fixed: the
  vocabulary test caught the word "room" in a showcase label.
- `npm run test:tokens`: passes (828 files; no literal color in `ix-base.css` or the new components).
- `npm run test:contrast`: 56,303 comparisons pass. Index: 3,353 comparisons over 35 hues (0-359 in 15° steps
  plus 359 and the 11 palette hues) x 2 themes, reading the recipes out of `ix-base.css`. Tightest: `--ix-ink-3`
  on the selection near the list top at hue 60, 4.55 against 4.5. Negative check: with ink-3 at .5 the audit fails
  more than 200 pairs.
- `npm run test:motion-lint` passes (only color transitions). `npm run test:a11y:static` passes.
- `npm run lint`: 0 errors (218 warnings, none new from this package; `eslint` on my files is clean).
- New unit tests: 68 in `components/ix` (identity, monogram, primitives, glyphs, showcase), 10 in
  `identityHue.test.ts` (deterministic, never 250-320 over 10,000 ids, all 11 hues used, serverHue override/null/
  invalid), 10 in `indexTokens.test.ts` (token values, High contrast, import order).
- No e2e spec (the plan has none for IX-1); I shot the pages with Playwright against `node e2e/index-dev.mjs 4503`
  (API calls answered locally, nothing reached a real server).

## Screenshots (`output/design-reference/index/ix1/`, gitignored)

I read each one. `panel-00.png` tokens; `panel-01.png` window hue at the 11 palette hues and People;
`panel-02.png` identity (default theme: people and servers at 24-88, all hues, uploaded picture, presence, stacks);
`panel-03.png` identity in High contrast; `panel-04.png` / `panel-05.png` primitives (default, High contrast);
`panel-06.png` the 28 glyphs; `design-tokens-index-full.png` the section; `face-switch-home.png`,
`face-switch-dm.png` today's UI with every `Face` now an Index avatar (the timeline's own avatar, IX-11, is still
the old yellow one in the DM shot). Differences from the prototype: none seen in the avatar and mark recipes;
the prototype's reference renders have no presence dots, so those are held to spec §2.3 only.

## For the next packages

- IX-4: tint layers set `--ix-hue` and use `.ix-hue-side` / `.ix-hue-main`; add the sidebar's right hairline
  (`inset -1px 0 0 var(--ix-edge-side)`) yourself. Use `serverHue(guild)` (needs IX-2's `guild.hue`) and `PEOPLE_HUE`.
- IX-5/6: `<ServerMark guildId name icon hue={guild.hue}>`, dock mark 34, header mark 40; `.ix-hue-selected` for the
  selected row; ink-3 is .62 (contrast proved), don't lower it. The dock's ring surface is `--ix-side-end` (the default).
- IX-7: `Avatar` 24 with `ring`/`AvatarStack ring="var(--ix-room-dark)"`; the talking ring is yours (a separate
  element, opacity only); the `--ix-room-bg*`, `--ix-amber-edge*`, `--ix-shadow-room*` tokens are ready.
- IX-11: the 30px bubble avatar is `<Avatar size={30}>`; replace `TimelineParts`' own avatar and `initialsOf`.
- IX-13: call tiles `<Avatar size={88} hue=…>`; verb glyphs are in `IxGlyph`; `--ix-tile-end`, `--ix-glow-talk`.
- Anyone replacing a `getIdentityColor` call site deletes it (they are `@deprecated`); IX-19 removes `lib/colors.ts`'s
  identity section and `--color-avatar-N` / `--identity-ink-N`.
