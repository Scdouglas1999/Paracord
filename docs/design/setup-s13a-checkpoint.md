# S13a checkpoint: first-run review harness

Package S13a of `docs/design/setup-plan.md`. Client and e2e only; no Rust, no
change to any shipped client source. The prototype
(`output/design-reference/setup/paracord-first-run.html`) is the source of truth
over spec 1.3's welcome text: the welcome is split down the middle (Host left,
Join right, both at once), choosing a side opens it to the full window and then
the steps begin, and a launch sequence (the cord draws on, the wordmark
resolves, the mark glides into the welcome head) comes first. Every reference
below follows the prototype.

## What shipped

| File | What it is |
|---|---|
| `client/e2e/setup-reference.mjs` | Renders the prototype to `output/design-reference/setup/ref/<state>.png`, 1280x800, plus `ref/manifest.json` (`source: prototype or derived`, and a note). `node e2e/setup-reference.mjs [state ...]` (a subset run keeps the other manifest entries). About 2 minutes for all 58. |
| `client/e2e/setup-review.config.ts` | Playwright config parameterized by `PARACORD_E2E_SETUP_{SPEC,PORT,RT_PORT,WP}` (+ `_REUSE`). Defaults 4993 / 4995 / `latest`. Same shape as `index-review.config.ts`; starts `realtime-stub.mjs` and `index-dev.mjs` (both reused unchanged). Viewport 1280x800 at 1x. |
| `client/e2e/fixtures/setup/**` | The mocked first-run scene (below). |
| `client/e2e/setup-compare.mjs` | `node e2e/setup-compare.mjs <WP or path or ref> [--only a,b] [--max pct] [--quiet]`: reference left, shot right, per-state diff (4x amplified), mean pixel difference and changed-pixel share, `summary.json`. Reads `ref/manifest.json`: derived references are labeled and left out of the "prototype references" summary line. `ref` against itself reports 0. |
| `client/e2e/setup-harness.spec.ts` | 21 tests that hold the scene itself (no first-run UI exists yet). |

Shots a spec takes with `scene.shoot('<state>')` land in
`output/design-reference/setup-build/<WP>/<state>.png`, which is where
`setup-compare.mjs <WP>` looks.

Run:

```
cd client
node e2e/setup-reference.mjs
PARACORD_E2E_SETUP_SPEC=setup-harness PARACORD_E2E_SETUP_WP=s13a npx playwright test -c e2e/setup-review.config.ts
node e2e/setup-compare.mjs s13a
```

No `package.json` script was added (not S13a's file); S13 may add
`test:e2e:setup` next to `test:e2e:index`.

## The references

Exact 1280x800: the stage element `#st` with `transform:none`, clipped to the
rounded stage origin (the review page's fit scale is never in the shot). Two
full runs are pixel-identical (compared with `setup-compare.mjs`: 0.00% on
all 58).

Determinism: launch frames run the prototype's `boot()` timers on our own
virtual clock (the three timers are cancelled and their three actions run at
exact virtual times; every CSS animation and transition is paused at the time
elapsed since it began). Every other state is shot after its motion settles,
with looping animations (the working mark, loading marks) held at 700 ms. The
prototype's own timers (setup rows, invite check) are never waited for: the
rows are painted with the prototype's `complete()`.

Font: the prototype loads Instrument Sans from Google Fonts. The script
refuses to write anything if it did not load, so the renders need network.

**`output/` is gitignored** (`/output/` in `.gitignore`), so the PNGs are not in
the commit. Regenerate them with the command above; S13 in this worktree
already has them.

### 35 states drawn by the prototype

`launch-450ms`, `launch-1150ms`, `launch-1800ms` (the glide begins),
`launch-1950ms` (the glide, the welcome fading in), `welcome` (the split at
rest), `welcome-hover-host`, `welcome-hover-join` (the other half dims, the
hovered half's button turns cream), `welcome-choose-host-140ms`,
`welcome-choose-host-280ms`, `welcome-choose-join-140ms`,
`welcome-choose-join-280ms` (the choose transition, mid-way), `welcome-clipboard`
(= `join-invite-clipboard`: spec 1.3 sends a clipboard invite straight to the Join
step, so that screen is the state), `host-name-empty`, `host-name-typed` (name
typed, hue 150), `account-empty`, `account-weak`, `account-strong`,
`host-setup-running` (rows 1-2 done, row 3 running), `host-setup-done`,
`host-setup-refused`, `privacy-sheet-host`, `privacy-sheet-join`,
`router-sheet`, `phrase-blurred`, `phrase-revealed`, `host-invite-internet`,
`host-invite-lan`, `done-host`, `join-invite-clipboard`, `join-invite-checking`,
`join-invite-card`, `join-account`, `join-setup-done`, `join-phrase`,
`done-join`.

### 23 states the prototype never drew (derived)

Built from the prototype's own components (`.found`, `.srv`, `.trust`, `.task`,
`.sheet`, `.inp`, `.chip`) with the spec's exact copy. Only the few pieces the
prototype has no equivalent for are styled, using the prototype's own colors
(its weak-password red, its warn amber): a `fail` row (danger tint and x), a
field error line, and a blocking notice. These are weaker authority than the
prototype states: where S13 and a derived reference disagree, the spec wins and
the reference may be wrong. They are labeled `(derived reference)` in the compare
output.

- `host-name-blocked-no_user_services`, `-no_keychain`, `-existing_server` (with
  **Use it**), `-no_port`, `-no_space`: spec 2.3 copy in a notice replacing the
  fields, Continue disabled. (`already_hosting` never blocks, so it has no shot.)
- `account-email`: the Email field a server can require (shown on a join).
- `host-setup-no-answer`, `host-setup-shared` (chip **What can I do?**),
  `host-setup-fail` (row 1 failed, chips Try again / Show details): spec 1.7 / 5.4.
- `shared-sheet`: the shared-address sheet. **The sheet body is a stand-in**:
  spec 5.4 only says "ask your provider for a public IPv4 address, or, if
  another router sits in front of yours, forward the port on that one too". S13
  owns the final words.
- `join-invite-empty` (the prototype always shows the clipboard banner; this
  hides it), `join-invite-ca-verified` (no words), `join-invite-invalid`,
  `join-invite-unreachable`, `join-invite-old-server`: spec 1.5.
- `identity-changed`: the spec 7.4 sheet. The words in it are placeholders.
- `sign-in-empty`, `sign-in-probed`, `sign-in-mfa`, `sign-in-legacy`: spec 1.12 and
  3.11; the prototype has no sign-in screen, so this is the account step's frame
  with the sign-in fields.
- `claim-mode-setup-web`, `-at-rest-on`, `-at-rest-off`: spec 2.11 (no launch,
  welcome or row 1; the storage row is a **warn** with "Stored messages and
  files are not encrypted on this server's disk." when at-rest is off).

Names differ from the plan's §5.3 only where one name covered several shots:
`host-name` is `host-name-empty` / `-typed`; `host-name-blocked` is one shot per
reason; `privacy-sheet` is `-host` / `-join`; `phrase-*`, `host-invite-*`,
`join-invite-*`, `sign-in-*` and `claim-mode-setup-*` are as listed. The two
launch frames of §5.3 (`launch-450ms`, `launch-1150ms`) are kept as named; the
glide frames and the split-welcome frames are new.

## The mocked scene (`client/e2e/fixtures/setup/`)

`installSetupScene(page, options)`, called before the first `page.goto`. Use a
fresh browser context per test (first run's "launch seen" flag will live in
localStorage).

- **Desktop** (default): `window.__TAURI_INTERNALS__` is stubbed, so the real
  `@tauri-apps/api` `invoke` and `listen` run against it and `isTauri()` is
  true. `desktop: false` is a plain browser (no Tauri at all).
- **Commands scripted** (spec 9.5): `host_preflight` (every reason of spec 2.3:
  `no_user_services`, `no_keychain`, `existing_server` + `existing_url`,
  `no_port`, `no_space`, `already_hosting` never blocks), `host_setup_start`
  with `host://progress` events (rows 1, 2, 4, 5; row 3 is the page's),
  `host_status`, `host_retry_reachability`, `host_backup_now`, `probe_server`
  (+ `fingerprint`, `ca_verified`), `trust_server` (refuses unless the observed
  fingerprint equals the one shown, spec 7.3), `accept_changed_identity`,
  `take_pending_deep_links`, the clipboard plugin's `read_text` / `write_text`,
  `secure_store_*`. A few boot-time commands are acknowledged
  (`update_trusted_server_hosts`, `append_client_log`, ...). **Any other
  command is rejected** with `setup review harness: the Tauri command "x" is not
  stubbed`, recorded in `host.unstubbed`, and `scene.expectNothingUnhandled()`
  throws on it. Nothing is answered with an invented success.
- **Setup progress**: reach scenarios `open`, `direct`, `refused`, `no_answer`,
  `shared_address`, `firewall_blocked` with the spec 5.4 copy verbatim; setup
  scenarios `ok`, `install_fail`, `start_fail`, `storage_unencrypted`,
  `backup_fail` (a failed row stops the sequence). `progress: 'auto'` plays on a
  timer (`progressDelayMs`), `'manual'` delivers one event per `host.step()` for a
  shot between rows. `host.reach` / `host.setup` / `host.preflight` can be set
  mid-test.
- **Invite previews** (spec 6.1), by code, for
  `https://kanto.home.arpa:8443/invite/<code>` (`inviteUrl(code)`,
  `portableInviteUrl(code)`): `Rf8kQ2` good and self-signed (four words),
  `CaOk1` good, CA-issued (no words), `Gone404` (404), `Unreach1` (connection
  refused), `OldSrv1` (no `instance`: an older server, spec 3.12), `Changed1`
  (same host, a different certificate). Preview carries `hue`, `online_count`,
  `member_count`, three `faces`, `instance`.
- **Identity change**: `host.rekey(host, identity)` changes what a host presents;
  if the host was pinned it emits `trust://identity-changed
  { host, pinned_fp, presented_fp }` (spec 7.2 step 4).
- **Trust words** (`trustWords(fp)`, `showWords(fp)`): spec 7.1 written out
  again, deliberately independent of `client/src/lib/trustWords.ts`, so a spec
  can hold the app's words against it.
- **Clipboard / deep link**: `clipboard` and `pendingDeepLinks` options,
  `host.setClipboard()`.
- **REST**: `/health`, `/api/v1/auth/options` (`require_email: false`) and the
  invite route are answered; every other `/api/v1/**` call is a recorded 404 in
  `scene.unhandled`. Routes are last-wins, so a spec adds its own after the
  scene (e.g. `require_email: true`).
- The clock is pinned (2026-10-12 20:30 Central); `reducedMotion: true` emulates
  the media query (spec 1.2: no launch).
- `scene.shoot(name)` requires the 1280x800 viewport.

## Gates

- `npx tsc --noEmit`: clean (fixtures are in the tsconfig include; the spec and
  config are transpiled by Playwright like every other e2e file).
- `npx eslint` on every file added: clean (page globals of the prototype are
  declared in `setup-reference.mjs`).
- `npm run test:tokens`, `npm run test:motion-lint`: pass.
- `setup-harness.spec.ts`: 21/21 on ports 4993 / 4995.
- References: 58 renders, all exactly 1280x800; two full runs identical;
  `setup-compare.mjs ref` reports 0.00%; the compare tool exercised on a
  deliberately mismatched pair and on an empty folder (exit 2, says why).
- All 58 renders were read as contact sheets and the launch frames
  individually.
- Unit tests, contracts and a11y/contrast gates are not applicable: no `src/`
  file, contract or UI changed.

## Notes for S13

- After the welcome, the title bar carries the progress strip (one segment per
  step after welcome) and a "Sign in instead" text button; the welcome shows
  neither (its own footer has "Already have an account? Sign in"). Back sits in
  the step's footer next to the primary button.
- Mid-transition references (`welcome-choose-*`, `launch-*`) are for matching
  curves and durations by eye, not for a pixel score; the app's shot has to be
  paused at the same elapsed time to be comparable.
- `index-dev.mjs`, `realtime-stub.mjs` and the Index harness are reused, not
  edited. Nothing outside the S13a paths changed.
