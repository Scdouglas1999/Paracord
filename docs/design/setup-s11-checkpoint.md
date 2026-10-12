# S11 checkpoint: deep links and clipboard

Package S11 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §6.4 and §6.5. Branch `feat/setup`. Uses
S9's `parseInviteLink` (no second parser).

## 1. Rust (`client/src-tauri/src/lib.rs`, region of `forward_deep_link_urls`)

- `PENDING_DEEP_LINKS` (`DeepLinkQueue { urls, taken }` behind a mutex). Every
  source (cold start `get_current`, the single-instance argv, macOS `open-url`)
  still goes through `forward_deep_link_urls`, which now routes each link:
  before the webview has drained the queue it is stored (cap 16, extras dropped
  with a stderr line); after, it is emitted as the `deep-link` event.
- `take_pending_deep_links() -> Vec<String>` drains the queue and sets `taken`
  under the same lock. That is what makes delivery exactly-once with no gap:
  the webview listens first, then drains; a link before the drain is in the
  queue (no event), a link after is an event (not queued).
  **Deviation from §6.4's wording** ("events still fire for links that arrive
  while running"): events fire only once the queue was taken, since an event
  before that has no listener and would also duplicate the queued copy.
- `.plugin(tauri_plugin_clipboard_manager::init())`; `take_pending_deep_links,`
  added to `generate_handler!` (my own line, per the S0 note).
- Cargo: `tauri-plugin-clipboard-manager = "2"` (resolved 2.3.3; Cargo.lock
  gains it plus arboard, wl-clipboard-rs, x11rb and friends). Capability
  `default.json`: `clipboard-manager:allow-read-text`, `allow-write-text`,
  `allow-clear`.
- Linux `x-scheme-handler/paracord`: the existing
  `plugins.deep-link.desktop.schemes: ["paracord"]` in `tauri.conf.json` is what
  the Tauri bundler turns into the MimeType entry for deb/rpm/AppImage; nothing
  to add. `register_all` unchanged.
- Tests (`deep_link_queue_tests`, 3): cold-start queue taken once, post-drain
  links emit instead of queue, bound.

## 2. JS

- `lib/deepLinks.ts`, installed by one line in `main.tsx` (before the router
  mounts; its rejection goes to the existing unhandled-rejection logger).
  `installDeepLinks()`: `listen('deep-link')`, then `invoke('take_pending_deep_links')`,
  each link through `routeDeepLink`. Desktop only (no-op in a browser).
  - invite (`paracord://invite/…` or an https invite link): waits for
    `serverListStore.tokensHydrated`; if first run is active or there are no
    servers (no saved server, no token, no stored server URL), puts the invite
    in `useDeepLinkIntake` and navigates to `FIRST_RUN_JOIN_PATH`
    (`/welcome/join/invite`); otherwise `openAddServer('join', link)`.
  - `paracord://server/<host>`: host checked with the invite parser's rules;
    a saved server gets an info toast; otherwise the server goes in
    `useDeepLinkIntake` and the router goes to `FIRST_RUN_SIGN_IN_PATH`
    (`/connect` today).
  - anything else: toast "That link isn't a Paracord invite."
  - Navigation is `history.pushState` plus a `popstate` event (this code runs
    before the router exists).
- **Entry point for S13**: `useDeepLinkIntake` (`takeInvite()`, `takeServer()`,
  plus normal zustand subscription) is the only handoff; the join step reads it
  on mount and subscribes. `setFirstRunProbe(fn)` lets the first-run store
  report "active" in addition to the default test. Repoint the two path
  constants if S13 names the routes differently. Until S13 lands,
  `/welcome/join/invite` falls into the `*` route and redirects to `/app`; that
  path is only reached with no servers at all.
- `lib/clipboard.ts`: desktop writes go through the plugin
  (`plugin:clipboard-manager|write_text`), web keeps `navigator.clipboard`.
  New `readClipboardText()` (desktop only; throws on web) and
  `copySecretToClipboard(secret, ttlMs = 60 s)`: copy, then after the delay
  clear only if the clipboard still holds the secret (a newer copy replaces the
  timer; `cancel()` stops it). In a browser it copies and returns
  `autoClears: false` so the caller does not promise a clear. The plugin's
  commands are invoked by name through `@tauri-apps/api/core`, so
  `@tauri-apps/plugin-clipboard-manager` was **not** added to `package.json`
  (its JS is a wrapper over those same calls, and `client/node_modules` is a
  shared symlink here).
  **S13/S12 must call `copySecretToClipboard` for the recovery phrase.**
- `lib/clipboardInvite.ts`: `peekClipboardInvite()` and
  `watchClipboardInvite({ isActive, fieldIsEmpty, onInvite, onError })`: read on
  mount and on each window focus, only while active and the field is empty;
  only the parser result leaves the module; each link is offered once per run;
  "nothing readable" is no offer, other read errors go to `onError`; no-op on
  the web. S13's Welcome and Join step own the call.

## 3. Additive changes outside S11's files

- `components/ix/dock/addServerStore.ts`: `joinDraft` + `clearJoinDraft`, and
  `openAddServer(tab, joinDraft?)`.
- `components/ix/dock/AddServerSheet.tsx` `JoinPanel`: one effect that moves a
  `joinDraft` into the field.
- The "invite card" in the Join tab does not exist yet; the field is filled and
  the person presses Join.

## 4. Gates

| Gate | Result |
|---|---|
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` | ok |
| `cargo fmt -p paracord-desktop -- --check` | ok |
| `cargo test -p paracord-desktop --lib deep_link` | 3 passed |
| `npm run typecheck` | ok |
| `npm run test:unit` | 475 files, 4814 tests passed (new: `deepLinks.test.ts` 8, `clipboardInvite.test.ts` 7, `clipboard.test.ts` 4) |
| `tauriCommandRegistry` (every `invoke` names a registered command) | passes |
| `npm run lint` (0 errors), `test:tokens`, `test:motion-lint` | ok |
| Live cold-start/warm launch of the desktop app | not run (needs a display; the queue logic is unit-tested and the JS side is tested with the shell mocked) |
