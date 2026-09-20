# Release validation — 2026-09-19

Target: **v3.0.1**, released as **v3.1.0** on 2026-09-20. The 3.0.1 candidate was never published; its work shipped in 3.1.0 together with the new looks.

**What was run on the 3.1.0 sources (2026-09-20, Linux):** `cargo fmt --check` and `cargo clippy --workspace -D warnings` clean; `cargo test --workspace --no-fail-fast` 1,700 passed, 0 failed, 4 ignored across 102 suites (SQLite); client `tsc` clean, 2,827 unit tests in 291 files, contrast, literal-colour and static accessibility audits; 92 mocked Playwright cases; 16 real-server Playwright cases against the release binary; `client/scripts/live-drive.mjs` 25/25 against a live instance of the release binary. PostgreSQL, Windows and macOS were left to CI.

**Not repeated for 3.1.0:** the open items under "Release gates still open" below (three-instance federation, bot gateway runtime, native screen portal end to end, Windows/systemd installer branches). The table that follows records the state on 2026-09-19 and has not been re-run line by line.

Two CI failures on `main` at the time were not product defects: `release_upload_quota` set the quota in config while the seeded `server_settings` row (which outranks it) still said 5 GiB, so the test could never have limited anything; and `real-server.smoke` expected the sign-in screen after a logout on a device that now, by design, asks to unlock its identity. Two were: `WINDOWS_GRANT_VERIFIED` was referenced and never declared (Windows did not compile), and the vendored `scap` read a field that had been renamed (macOS did not compile).

This record distinguishes real application checks from unit tests, protocol fixtures,
and platform limitations. A passing check applies to the tested build and scenario;
it does not prove the absence of all defects. The accompanying
[security audit](security-audit-2026-09-19.md) records the original security findings.

All runtime accounts, messages, databases, files, federation keys, and services used
here are disposable fixtures on loopback. Native microphone/speaker tests use private
virtual audio devices. Existing user instances, profiles, files, and physical audio
devices are not test inputs.

## Executed coverage

| Area | Evidence | Result / remaining gate |
|---|---|---|
| Registration, owner claim, login, session refresh | Real browser and HTTP tests; rejected credentials and identity setup/reload | Passing fixes; final embedded rerun pending |
| Multiple simultaneous users | Seven real authenticated gateways, six senders, 18 concurrent messages, 108 verified deliveries, outsider exclusion, live access revocation | SQLite and PostgreSQL pass |
| Text messages, edits, deletion, exact retry | Real browser, REST, gateway replay and restart suites | Pass; lost-response/restart regression fixed |
| Direct-message text encryption | Two actual browser profiles; first encrypted send, edit/delete, locked recipient recovery, replay eviction and restart | Six production messaging/encrypted attachment cases pass |
| Direct-message attachment confidentiality | Actual sender encrypts, server receives opaque bytes/metadata, recipient decrypts and verifies | Pass |
| Identity/ratchet/media cryptography | Unit and security regression suites; malformed/tampered/replayed inputs | Pass in initial audit; final suite pending |
| Threads, replies, formatting | Actual UI creates a thread from a delivered message and sends formatted reply; API lifecycle checks | Pass |
| Scheduled messages | Actual UI schedules a message and observes delivery at the requested time; API create/edit/cancel/restart checks | Pass |
| Polls and reactions | Actual UI multiselect voting; concurrent API voters and same-user replacements on both databases | Pass; SQLite transaction and PostgreSQL flag binding fixed |
| Attachments and previews | Real upload, authenticated image lightbox, download; active-content/security tests | Pass; image lightbox fixed |
| QUIC file upload | Browser production uploader to `/files`, message association and exact HTTP download (7 and 1,228,800 bytes) | Pass; final quota/metadata build rerun pending |
| QUIC upload rejection | Token/transfer substitution, size mismatch, premature end, wrong purpose/path, replay, revoked session/membership | Pass |
| Upload concurrency and storage policy | Duplicate transfer writes; retained partial budget; guild quota admission | Final concurrent quota tests pending |
| Search, pins, saved messages, mentions, inbox, unread, typing | Product API suite and component/browser suites | Final UI checks pending |
| Roles, channels, invites and membership | Product API, abuse tests, concurrent invite redemption, private-channel revocation | Pass |
| Discovery and templates | Real UI and API tests; malicious template rollback | API passes; discovery member event crash fixed; final full UI rerun pending |
| Welcome/onboarding | Real process malformed payload/rules/role assignment/reentry suite | Pass |
| AutoMod, reports, bans, moderation templates and audit | Real product/moderation suites and authorization regressions | Pass |
| Events, emoji, anonymous/disappearing channels, economy | Real process lifecycle suites, cooldowns/achievements/level roles, animation upload | Pass |
| Bot store and application administration | Real HTTP search/reviews/metrics/install/uninstall | Pass |
| Bot gateway, slash commands and interaction callbacks | In-process callbacks; new opaque credential gateway and real bot loop | Runtime completion pending |
| Webhooks | REST product tests and security regressions, delivery/creator permissions/timeouts/thread restrictions | Pass in audit; final suite pending |
| Instance administration, storage settings, backup UI | Real UI CRUD, settings persistence, archive download, recovery instructions, audit filters/pagination | Diagnostic flows pass; full acceptance rerun pending |
| Three-instance federation | Real signed discovery, pins, membership, message mutation, catch-up, encrypted file transfer/cache, rotation and revocation | Further topology/return-path fixes; final runtime rerun pending |
| Group direct messages | Existing production release disables sends; old implementation lacks account isolation/authentication guarantees | Secure integration assessment pending; not counted as working |
| Browser voice, camera and screen | Two real sessions, both directions decoded/played audio, rendered camera/screen frames, UDP reachability diagnostics and disconnect cleanup | Six tests pass using synthetic media |
| Native desktop messaging and voice | Actual packaged desktop UI login/message; raw QUIC to browser WebTransport peer; both directions decoded audio on private virtual devices | Pass |
| Native codec and system audio | Opus/transport suites; three actual NVENC/NVDEC GPU cases; private PipeWire capture/playback | Pass; Linux native screen portal end-to-end pending |
| Installer and upgrades | 27 actual release installer assertions; v0.9.0/v3.0.0 SQLite and PostgreSQL schema/startup/login/history/second restart | Pass; Windows/systemd branches not yet executed |
| Backup/restore and SQLite-to-PostgreSQL conversion | Real CLI verification, rows/history epochs, media/key integrity, rollback/refusal cases | Pass; latest runtime rerun pending |
| Graceful restart, resume, retention and load | Real SIGTERM/gateway/SSE drain, replay, persistence, 250 messages/four signaling sessions | Pass; functional stress test, not a production benchmark |
| Desktop packaging | Linux native default features including VPX; AppImage and Debian package | Local build passes; final version/portable CI artifacts pending |
| Signed updater | Configured public key and release workflow examined | Matching private signing key is not configured in repository Actions secrets |

## Completed suite totals

- Initial security audit: 1,675 Rust tests passed, four environment-specific cases ignored;
  the three GPU cases and private system-audio case were subsequently exercised successfully.
- Client unit suite before the latest release fixes: 2,751 tests passed in 284 files.
- Mocked browser suite: 92 tests passed.
- Production messaging and attachment confidentiality: six real browser cases passed.
- Full PostgreSQL API integration suite: 615 tests across 64 targets passed.
- Real backend release scripts: 16 suites passed, plus installer, migration, recovery,
  database query-plan and PostgreSQL concurrent-session checks.
- Client contracts, bot SDK tests/build, static accessibility, token and contrast checks passed.
- Final complete Rust/client/CI gates will replace these intermediate totals after all fixes settle.

## Build and evidence identity

The tested intermediate release server SHA-256 is
`16176e58ad0fe7bbad126d4234a036832968f10ec59e08d270dd686595a4216e`.
Later topology, quota, gateway, and embedded-client changes require a new final build.
Local packages created during diagnosis carry the previous 3.0.0 version and are **not**
release deliverables.

Evidence is retained outside the repository at `/tmp/paracord-release-20260919/` in
`root`, `authz`, `federation`, and `media` directories. Logs and manifests identify
commands, fixture scope, executable hashes, screenshots, results, and failures.
Earlier security evidence is at
`/tmp/paracord-security-audit-2026-09-19-i778h33b/evidence/`.

The CachyOS host's bundled linuxdeploy strip tool does not understand newer RELR
sections. Local bundling succeeded with `NO_STRIP=1`; this retains symbols and does
not remove any codec feature. Final Linux artifacts need the workflow's older
supported build environment, following [Tauri's AppImage guidance](https://tauri.app/distribute/appimage/).

## Release gates still open

1. Complete and repeat the live federation, bot gateway, quota, and native screen scenarios.
2. Resolve the group-message release scope with a secure account-owned implementation.
3. Build final versioned sources and embedded assets; run complete local and cross-platform CI gates.
4. Configure the existing updater signing key, build/verify final artifacts and manifest.
5. Publish only the validated artifacts, with accurate supported-platform and upgrade notes.
