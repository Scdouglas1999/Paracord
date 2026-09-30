# WP-G17 checkpoint: reactions on the stream

Contract: `docs/glass-spec.md` §6.5 and §9 (reduced motion). Plan: `docs/design/glass-plan.md` §3
(the reactions row) and the WP-G17 row. Nothing is committed. All work is in
`~/Documents/Paracord-glass` (branch `design/glass`).

The G14 stubs are filled. The stage's flame and heart buttons now send reactions. Nothing in
`StageControls.tsx` had to change, because the buttons already read `useStreamReactions(target)`.
Sean, watching without joining, sends a flame. His own bubble appears in 26 to 32 ms. Luke, who is
also watching, draws it with Sean's face about 0.5 s later. Brendan, who is in the call, receives
the event. Jeremy, a Game Night member outside Lounge, does not. This was proven live on the
embedded build (20 of 20 checks pass).

## Server

**Endpoint.** `POST /api/v2/voice/{channel_id}/stream-reactions`, in the new file
`crates/paracord-api/src/routes/voice_reactions.rs`. Body (`SendStreamReactionRequest`):

```ts
{ kind: 'flame' | 'heart', stream_user_id: string, count?: number /* 1..20, default 1 */, nonce?: string /* [A-Za-z0-9_-]{1,64} */ }
```

The checks run in this order. Anything refused before the rate limit does not use up the
person's second.

1. The channel is a voice or stage channel (400 otherwise). It is in a server; a DM gets 400.
2. The caller is a member of the server (`ensure_guild_member`) and has **VIEW_CHANNEL** (403).
3. `count`, `nonce` and `stream_user_id` are valid (400). An unknown `kind` is refused by the
   body's type (422).
4. **Presence.** The caller has a voice state in the channel (joined or listening), or holds a
   **watch** view session there (`rooms.view_for_user`: same server and channel, kind `Watch`).
   Otherwise 403. An ambient view (the room light) is not watching and gets 403.
5. The named streamer has `self_stream` in this channel (409 otherwise).
6. **Rate limit.** One request per second per person, checked and recorded in one step
   (`DashMap` entry, keyed by user). Otherwise 429, with `Retry-After: 1` and `retry_after: 1`
   in the body (the existing `ApiError::RateLimited` path).

On success the route returns 204. Nothing is stored.

**Event.** `STREAM_REACTIONS` (`paracord_models::gateway::EVENT_STREAM_REACTIONS`), shaped as
`StreamReactions`:

```ts
{ guild_id, channel_id, reactions: [{ user_id, stream_user_id, kind, count, nonce: string|null,
  username, display_name: string|null, avatar_hash: string|null }, …] }
```

- **Coalescing.** Reactions for one channel are gathered for 250 ms. The first reaction into an
  empty batch spawns the flush, so a busy channel costs its recipients at most four events a
  second.
- **Recipients.** Read at flush time: every voice state in the channel (joined and listening),
  plus every watch view session on the channel (`rooms.views_snapshot()`). They are deduped and
  sent with `dispatch_to_users`. The event is never guild-scoped and never goes to ambient
  viewers. The sender is included, and their echo carries their nonce.
- **Sender details.** The name and avatar come from one `users` read per accepted request, so a
  viewer's client can draw a sender who is not in its member roster.
- **Failure.** A DB error at flush time is logged with `tracing::warn!` and the batch is dropped.
  The reaction is ephemeral, and the log says so.

Model: `SOUNDBOARD_PLAY` (`soundboard.rs`). No SQL was added. The event is user-targeted, so it
needs no intent mapping, the same as `SOUNDBOARD_PLAY`.

**Contracts** (`crates/paracord-contracts/src/voice.rs`):

- New types: `StreamReactionKind` (lowercase and extensible), `SendStreamReactionRequest`,
  `StreamReaction`, `StreamReactions`, and the constants `MAX_STREAM_REACTION_COUNT = 20` and
  `MAX_STREAM_REACTION_NONCE_LEN = 64`.
- Both schemas are registered in `lib.rs`, with a test.
- `count` is `u32`. `u8` would emit a `uint8` format, which the client generator's strict Ajv
  rejects.
- `contracts/api-contracts.json` was re-exported. `client/src/api/generated/` was regenerated
  (`SendStreamReactionRequest.ts`, `StreamReactions.ts`, and the validators).

## Client

**`stores/streamReactionStore.ts`** (new):

- **Receiving.** `receive(serverId, payload)` keeps only reactions for a stream whose layer is
  on screen (`watch(key)`, refcounted). A call member who is not watching holds no bubbles and
  no timers. The key is `serverId + channelId + streamerId`.
- **Echo dedupe.** An entry whose nonce this client sent is dropped, because it was already
  drawn. The same person on another device has a different nonce, so it is drawn there as a
  normal bubble with their face. That is deliberate.
- **Unknown kinds** are skipped, with one `console.warn` per kind.
- **Sending.** `send(target, kind)` draws your bubble at once, then queues the tap in a
  per-instance outbox. At most one request per second: the next is allowed a second after the
  previous answer, so the server has always seen the last request more than a second before the
  next one. Taps in between merge into the next request's `count`, capped at 20; the rest carry
  over. A flame and a heart tapped together go out a second apart.
- **Errors.** A 429 puts the taps back at the front and waits for `Retry-After`. Any other
  failure toasts "Your reaction was not sent: <server's words>".
- **Accounts.** Taps belong to the account that tapped them. After an account switch they are
  dropped, never sent as someone else.
- **Busy.** A stream shows at most 10 bubbles. Once 6 are rising, a new reaction of the same
  kind and the same ownership joins the youngest bubble born within the last 900 ms, and its
  count goes up. At 10 it joins regardless of age, or it evicts the oldest bubble when no
  bubble of its kind exists.
- **Lifetimes.** Someone else's bubble lasts 2.6 s and your own 2.8 s. Under reduced motion a
  bubble lasts 1.6 s, and the store stamps it `still`.

**`components/glass/stage/StreamReactionsLayer.tsx`** (now owned by G17):

- **`useStreamReactions(target)`** is available when this client is in the call for that channel
  (`callPhase === 'connected'`, joined or listening) or has a `live` watch view of that exact
  stream. Otherwise it is unavailable, with one of these reasons:
  - "You can react once the stream is on your screen." (a watch that is still connecting counts
    as not yet)
  - "Reactions on the stream are for server voice channels." (DM)
  - `send('fire' | 'heart')` maps to the wire kinds `flame` and `heart` through `toWireKind`
    (see below).
- **`StreamReactionsLayer`** is an `aria-hidden` column (`pointer-events: none`), 72×320,
  24 px in from the stream box's bottom right.
  - Someone else's reaction is a 44 px dark glass disc (`--glass-n-solid` at 50%, hairline edge,
    16 px blur). The flame is amber and the heart is ink. It carries the sender's 20 px `Face`
    in the corner and rises with the reference's `floatUp` as a one-shot: fade in, rise 270 px,
    fade out.
  - Your own is the reference's `floatOnce`: 48 px, `--glass-fill-on`, raised shadow, no face.
  - Merged bubbles show a small count badge.
  - **Reduced motion.** A `data-still` bubble has `animation: none` and stacks in place (52 px
    rows), then goes. `animation: none` matters here: the global reduced-motion rule zeroes
    animation durations, which would land a rising bubble on its invisible end frame.
  - **Native underlay and reduced transparency.** The discs switch to near-solid fills with no
    blur, the same rule as `.glass-stage__sbtn`.
  - The styles are in **`StreamReactionsLayer.css`** (new, imported by the component), using
    tokens only. It passes the token audit and the motion lint (transform and opacity only).

**Gateway:** `events.ts` gains `STREAM_REACTIONS`, and `dispatch.ts` gains one case with a hand
guard (`isStreamReactions`) and a redacted parse-failure warning, as for
`VOICE_WATCHERS_UPDATE`. **API:** `createCallVoiceApi(...).streamReaction(channelId, body)` in
`api/voice.ts`.

## For other packages (lines I did not edit)

- **Buttons (G14/G15, `StageControls.tsx`).** Nothing needs to change. They enable themselves
  through `useStreamReactions`. The stage's kind is still `'fire'` (G14's contract), and the wire
  says `flame`. To retire the alias, change these three spots in `StageControls.tsx`, then
  delete `toWireKind` and the `StreamReactionKind` alias in the layer:
  - the two `react('fire')` calls become `react('flame')`
  - `id: 'fire'` becomes `id: 'flame'` in the More item
- **Theater (G15).** The layer positions itself inside the stream box. If the theater's
  conversation or controls float over the stream's bottom right, set this on the theater's stream
  container or any ancestor of the layer (the reference's theater numbers):
  `--stream-reactions-right: 428px; --stream-reactions-bottom: 120px;`
  With the chat hidden, the reference uses `--stream-reactions-right: 32px`.
- **Outside my file list (one line).** `crates/paracord-api/src/routes/mod.rs` gains
  `pub mod voice_reactions;`. The route cannot compile without it.
- **New files next to the ones in the brief:**
  - `client/src/components/glass/stage/StreamReactionsLayer.css` (the layer's styles; G14's
    `glass-stage.css` is G15's now)
  - `client/scripts/glass-scene/reactions-live.mjs` (the live driver)

## Commands

| Command | Result |
|---|---|
| `pc-cargo.sh test -p paracord-api -p paracord-contracts -p paracord-models` | pass: 817 tests in 90 suites, 0 failed. Includes `tests/stream_reactions.rs` (5), the route's unit tests (2) and the contract test |
| `pc-cargo.sh clippy -p paracord-api -p paracord-contracts -p paracord-models --tests -- -D warnings` | pass |
| `rustfmt --check` on every Rust file I touched | pass |
| `cargo fmt --all -- --check` | **fails on two files that are not mine**, both already unformatted at `HEAD`: `crates/paracord-api/tests/voice_listen_view_sse.rs:86` and `crates/paracord-server/src/main.rs:4763`. A workspace `cargo fmt` reformatted them during this package; I reverted that so as not to touch other files |
| `npm run contracts:check` | pass (37 types) |
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 401 files, 4,107 tests (the store's 17 and the layer's 12 included; `Stage.test.tsx` unchanged and passing) |
| `npm run test:tokens` / `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors (254 warnings in the tree). `npx eslint` on each of my files: 0 problems |

**Rust route tests** (`tests/stream_reactions.rs`, SQLite `TestContext` with native media on):

- **Recipients.** Recipients are exactly Vincent, Brendan, Nick (listening), Luke (watch view)
  and Sean (the sender's echo). Not a guild member outside the channel, and not an ambient
  viewer. The payload matches the contract and the nonce is echoed. A listener may react, and
  `count` is carried through.
- **Coalescing.** Two people within 250 ms produce one event, in arrival order, and nothing
  follows.
- **Permission.**
  - A guild member neither in the call nor watching: 403.
  - A non-member: 403 or 404.
  - An ambient viewer: 403.
  - A watch viewer with VIEW_CHANNEL denied by an overwrite (before the sweep ends the view):
    403.
  - A text channel: 400.
  - None of these dispatches anything.
- **Validation.**
  - No stream: 409.
  - `count` of 0 or 21, a bad nonce, or a non-numeric streamer: 400.
  - An unknown kind: a client error.
  - None of them uses up the person's second.
- **Rate limit.**
  - A second request inside the second: 429, `Retry-After: 1`, `RATE_LIMITED`,
    `retry_after: 1`.
  - Someone else is not held back.
  - After 1.05 s, allowed again.

## Live proof (2026-09-30, the embedded build, a real relay)

Setup:

1. `npm run build`
2. `touch crates/paracord-server/src/embedded_ui.rs`
3. `pc-cargo.sh build --release --bin paracord-server`
4. `live-env.mjs --port 18770`, with its data in the session scratchpad. The served bundle
   `assets/index-U9WjK5Ii.js` matched `client/dist`.
5. `glass-scene.mjs --no-typing`, holding the call: Vincent sharing, Brendan on camera, Nick
   muted, each in their own Chromium.

`node client/scripts/glass-scene/reactions-live.mjs` passed 20 of 20. Sean and Luke drive only
visible controls. Brendan's, Luke's and Jeremy's event streams are SSE connections held with
their own tokens (`holdRealtime`).

- Jeremy is in Game Night and not in Lounge. Sean and Luke both watch Vincent's screen without
  joining, and neither is in the relay's call.
- Sean's flame button becomes enabled when the stream is on screen. The press draws his own
  bubble in 26 to 32 ms.
- Luke's stage draws Sean's flame 506 to 522 ms after the press (250 ms of that is coalescing),
  with Sean's face in the corner.
- Brendan (in the call) and Luke (watching) receive `STREAM_REACTIONS`. Jeremy receives 0 events
  in the 2 s after. The event names Lounge, Vincent's stream, Sean and a nonce.
- **Echo.** Sampled every 50 ms for 2.5 s after the press, Sean's own stage shows at most one
  bubble and never a bubble that is not his own.
- **Merging.** Four quick heart taps draw four hearts for Sean. The call receives them as two
  requests, 1 + 3, and Luke's stage shows the merged bubble with a "3" badge. No 429 and no
  failure toast.
- **Reduced motion.** With Luke's page set to reduced motion, the next flame appears in place
  (`data-still`) and is gone after about 1.6 s.
- There were no page errors in either client.

Shots are in `output/design-reference/glass-build/g17/live/`. Each has a full frame and a
`-corner` crop of the stream's bottom right:

- `g17-1-sean-own-flame`: Sean's own lighter disc
- `g17-2-luke-sees-sean-flame`: the dark disc with Sean's face, mid-rise, in the side-by-side
  layout of `04`
- `g17-3-luke-sees-merged-hearts`: one heart rising, the merged "3" below it
- `g17-4-luke-reduced-motion`: the still bubble
- `reactions-live.json`: the results

Everything I started was stopped: the scene holder by SIGINT (it left the call), then
`live-env` and its server child. Ports 18770 and 18771 are free, and no Playwright browsers are
left. The other `paracord-server` running on this box (pid 1203, `~/.local/share/paracord`) is
the owner's install and was not touched.

## Not done, or worth knowing

- **Theater was not verified live.** G15's theater is not in the tree yet. The layer rides the
  stream box, so it goes wherever theater puts that box. The custom-property hook above is the
  only thing theater may need.
- **Desktop app not run.** On the Linux native-underlay route the discs switch to near-solid
  fills (the CSS rule above), but that was not seen in Tauri/WebKitGTK. The rising discs carry
  `backdrop-filter: blur(16px)` while they move over live video, as the reference does. With at
  most 10 at once this was fine in Chromium, but WebKitWebProcess CPU with several bubbles is
  worth measuring in WP-G23.
- **WebSocket gateway.** The live run used the SSE transport (the client's default, and the
  driver's listeners). `dispatch_to_users` is transport-agnostic and `SOUNDBOARD_PLAY` rides the
  same path on the WebSocket, but that transport was not exercised for this event.
- **PostgreSQL.** No SQL was added. The route tests ran on SQLite only (no
  `PARACORD_TEST_POSTGRES_URL` here).
- **Phone (G20).** The phone stage is 16:9 and about 220 px tall, so the 270 px rise is clipped
  by the stream box's rounded corners. G20 may want a shorter rise there, through a class or a
  custom property on the layer.
- **Concurrent packages.** G15 (theater, keybinds) and G16 (clips) were editing stage files
  while this package ran. The unit suite, the build and the live run above include whatever
  state their files were in at that moment. `contracts/api-contracts.json` and
  `client/src/api/generated/validators.{js,d.ts}` are generated files: if another package
  regenerates them, run `npm run contracts:generate` again after merging, rather than
  hand-merging.
- **Screen readers.** The layer is `aria-hidden`, as in the reference, and reactions are not
  announced. A polite live region would be easy to add, but it would chatter in a busy stream.
  That is an owner question.
