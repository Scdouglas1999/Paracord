# S12 checkpoint: privacy defaults and settings

Package S12 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §1.10 (data hooks) and §8.2 to §8.5 (the
backups toggle, §8.5, is S6's route; the sheet row for it is here).

## What changed

### Server

- `user_settings.link_previews` is read and written. `UserSettingsRow` gains
  `link_previews: bool` (selected as `CAST(link_previews AS INTEGER)`, decoded
  with `bool_from_any_row`). `users::set_link_previews(pool, user_id, bool)`
  upserts the flag, bound as a Rust `bool`; `users::link_previews_enabled`
  returns the author's setting (no row means never changed, so on). The
  positional `upsert_user_settings` is left alone (the identity import in
  `paracord-core` calls it).
- `PATCH /users/@me/settings` takes `link_previews` (the field S0 added to
  `UpdateSettingsRequest`) and writes it with `set_link_previews`.
- `UserSettingsResponse` (contracts, regenerated into
  `contracts/api-contracts.json` and `client/src/api/generated/`) gains
  `link_previews: bool` and `link_previews_available: bool`.
  `link_previews_available` is `AppConfig.link_previews_enabled`, so the switch
  can say "Turned off on this server." Both are in `GET` and `PATCH` bodies.
- Gate: `opengraph::previews_allowed(state, author_id)` is true only when
  `[link_previews] enabled` and the author's setting are on. The send handler
  (`routes/channels/messages.rs`, the spawn only) checks it before
  `spawn_opengraph_task`, so nothing is fetched for an author who turned them
  off. A failed settings read is a 500, never a silent "fetch".

### Client

- `lib/features/privacyDefaults.ts`: `isActivityDetectionOn` (`=== true`),
  `withExplicitActivityOff` (for sign-up), `visibleEmbeds`.
- "Show what I'm playing" is read as `=== true` in `UserSettings.tsx` (the load
  mapping) and `hooks/useActivityPresence.ts`. Nobody who never chose shares;
  anyone stored `true` keeps it. No data migration is needed or done.
- `hooks/usePrivacySettings.ts`: link previews and activity, applied at once;
  on failure the switch reverts and an inline `role="alert"` says why.
- `components/firstRun/ProtectedSheet.tsx`: the "What's protected" sheet
  (`open`, `onClose`, optional `host` rows for the owner: stored-data copy,
  invite-only, daily backups with an async `onChange` that rejects to revert).
- `components/user/PrivacySection.tsx`: Link previews, Show what I'm playing,
  Ask for my password when Paracord opens (the switch only; state and handler
  come from `UserSettings`, S3 owns what it does), and a "What's protected"
  button that opens the sheet. Mounted in `UserSettings.tsx` in the former
  "Activity privacy" section, now labeled "Privacy" (section id still
  `activity`, so existing links work). "Display current activity" is replaced
  by the new row; "Share what I'm listening to" and Detected apps remain.
  `UserSettings` keeps its draft in step with the stored value so Save cannot
  write the old answer back.
- `MessageList.tsx`: the link-embed block uses `visibleEmbeds` and stops
  fabricating bare-URL cards when the reader's `link_previews` is off. Webhook
  and feed embeds are not previews and stay.

## For S13 / S2

- The first run composes `ProtectedSheet` (pass `host` only on the host path).
  Sheet switches write through `authStore.updateSettings`, so the account and
  its session must exist before it opens.
- Sign-up must write the activity default explicitly:
  `updateSettings({ notifications: withExplicitActivityOff(settings.notifications) })`
  (`lib/features/privacyDefaults.ts`). I did not edit sign-up code (S2/S13
  own it). With `=== true` the default is already off; this makes it a recorded
  choice.
- Release notes must say: "Show what I'm playing" is now off unless you turned
  it on yourself.

## Deviations

1. **Switches are cream, not green.** The prototype's sheet draws green
   switches; the Index `Switch` (the app's one boolean control, index-spec
   §1.4) is cream-on, so the sheet uses it. The lock/"Always on" ink is the
   success token, which Index also makes cream. Panel is 560 wide, radius 24,
   `--ix-pop-solid` (#16171a, the prototype's `#17181b` equivalent).
2. The settings route's link-previews write is a second statement after the
   positional upsert (not one transaction), to leave the shared upsert
   signature alone. The row always exists by then.
3. The device-security toggle in the Account section (S3's region) still
   exists; the Privacy section shows the same setting under the spec's new
   name. S3 should remove or reword the old one.
4. The user-settings export/import bundle (`paracord-core/identity.rs`) does
   not carry `link_previews` (the file is not S12's). A restored account gets
   the default (on).

## Gates

- `cargo fmt` on S12's files; `cargo clippy -p paracord-api -p paracord-db
  -p paracord-contracts --all-targets -D warnings`: clean.
- `cargo test -p paracord-api --test link_previews_setting` (round trip, gate
  by author, gate by server config, PATCH before any row): pass.
- Client: `typecheck`, vitest (new `ProtectedSheet.test.tsx`,
  `privacyDefaults.test.ts`; existing UserSettings, message and api suites),
  eslint (no errors), `test:tokens`, `test:motion-lint`, `test:a11y:static`,
  `test:contrast`, `contracts:check`: pass.

## Screenshots (looked at)

Scratchpad, 1280x800, Index glass: `s12-sheet-host.png` (all seven rows),
`s12-sheet-nonhost.png`, `s12-section.png` (Settings › Privacy). Layout,
copy, row order, hairlines, title/sub sizes match
`output/design-reference/setup/s-3b-privacy.png` apart from deviation 1.

## Not done

- The plan's live check on port 18500 (a real message with a link, previews
  off versus on) was not run: it needs a built server, and the shared tree
  does not build the server binary while other packages are mid-edit. The gate
  is covered at the API level instead (`previews_allowed` per author and per
  server config, driven through the real settings routes). A message-send
  integration test that proves `spawn_opengraph_task` is skipped is not
  possible without outbound network (the fetch refuses private addresses), so
  the check stays at the gate function the send handler calls. Run the live
  check once S13 integrates.
