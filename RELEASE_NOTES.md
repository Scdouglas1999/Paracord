# Paracord 2.0.0 — AutoMod, Server Health, and a Server That Looks After Itself

**Paracord 2.0.0** is about the two things v1.0.0 left to the operator: keeping a community civil, and knowing whether the server behind it is actually healthy. v1 shipped a capable engine — native QUIC media, dual-database support, scheduled backups, federation — but gave the person running it four counters and a config file. This release turns that capability into something you can see and act on, adds the content-moderation layer a public community needs, and puts per-space notification control in the hands of members.

It also carries a substantial security and reliability programme: two independent adversarial reviews across authentication, authorization, cryptography, federation, input handling and resource limits, with every finding remediated, regression-tested, and re-verified against a running server. **Upgrading is recommended for all deployments.**

Full compare: **[v1.0.0...v2.0.0](https://github.com/Scdouglas1999/Paracord/compare/v1.0.0...v2.0.0)**

---

## Highlights at a Glance

| Area | What's new |
|------|------------|
| **Moderation** | **AutoMod** — keyword, pattern, link/invite, mention-flood, and spam rules that run on every message, with block / timeout / alert actions |
| **Operations** | **Server health** — a real diagnostics view that tells you what's wrong *and what to do about it*, replacing four bare counters |
| **Notifications** | **Per-space and per-channel** notification levels and mutes, stored server-side so they follow you between devices |
| **Backups** | Automatic scheduled backups are now **on by default** |
| **Onboarding** | A **Get set up** checklist on Home, derived from live state — no more empty first screen |
| **PostgreSQL** | First-class PostgreSQL support, with the full integration suite running against a real server in CI |
| **Security** | Hardening across authentication, authorization, media encryption, federation and the desktop client |
| **Resilience** | Every request path, upload, media buffer and federation queue now carries an explicit bound |

> Verified at release: **61 Rust suites / 1,238 tests** green on SQLite; the API suite (**349**) green against a real `postgres:16`; **169 client files / 1,204 tests** green; `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --check` clean; `tsc --noEmit` clean; both end-to-end suites passing. See [Verification](#verification).

---

## What's New

### AutoMod

`automod_rules` existed as a table in v1.0.0 and is now a complete feature: an evaluator, routes, and a management UI.

A rule is **a trigger, one or more actions, and its exemptions**. Every enabled rule in a space is evaluated against each message before it is stored.

**Triggers**

| Trigger | What it catches |
|---|---|
| **Keywords** | A list of words or phrases, optionally **whole-word only** so `ass` doesn't flag `assignment` |
| **Pattern** | A regular expression, case-insensitive |
| **Links & invites** | All URLs, invite links, or both — with a domain allowlist that includes subdomains |
| **Mention flood** | A single message pinging more than *N* distinct people |
| **Message spam** | *N* messages from one member inside a rolling time window |

**Actions**

- **Block the message** — it is never stored, and the sender sees the reason *you* wrote.
- **Time the member out** — applied *after* the triggering message is handled, so a non-blocking rule still lets that message post and the timeout starts from the next one.
- **Alert a channel** — posts a moderator-facing notice naming the rule, the member, and what matched.

**Everything else that makes it usable**

- **Exemptions** per rule, by role and by channel. Members who can manage the space are never filtered by its own rules.
- **A dry-run tester** in the rule editor: paste a message, see whether the rule would fire and exactly what it matched — before you enable it.
- **Presets** for the three rules most spaces want (block invites, stop mention spam, slow down flooding), addable in one click.
- **Hit history** — every automated action is recorded with the rule, the match, the actions taken, and an excerpt of the offending content.
- **Audit-log entries** for rule create / update / delete.

**Design notes.** Patterns are compiled with Rust's `regex` crate, which has no backtracking, so a hostile pattern cannot cause exponential blowup; pattern length and compiled program size are bounded on top of that. Rules are validated once, on write — a stored rule that fails to parse is skipped and logged rather than failing the send. **AutoMod fails open**: if evaluation itself errors, the message goes through. A broken filter must never take chat down.

Keyword matching normalises Unicode before comparing, so compatibility forms, zero-width characters and diacritic substitutions do not slip past a rule.

AutoMod covers human messages sent through the REST API, plus webhook executions whose creator lacks `MANAGE_GUILD`. Bot messages and scheduled delivery are operator-authored and not filtered.

*Space Settings → AutoMod. Requires `MANAGE_GUILD`.*

### Server health

The admin Overview was four counters: users, spaces, messages, channels. It could not tell you whether your backups were running, whether your database had outgrown SQLite, or whether you were serving passwords over plaintext HTTP.

`GET /api/v1/admin/health` now returns a full picture — version, uptime, database engine and real on-disk size, upload and media footprints, backup freshness, transport configuration, media backend, and live counts — plus a list of **findings**. Each finding carries a severity and a concrete fix, and the admin Overview leads with them:

- **Automatic backups are off** — critical; nothing is being backed up on a schedule.
- **No backup has run yet** / **Last backup was N hours ago** — the staleness threshold scales off your configured interval.
- **TLS is off and the server is not loopback-only** — critical; credentials are crossing the network in plaintext, and browsers block mic/camera/screen-share without HTTPS. A loopback-only dev server is correctly *not* flagged.
- **Using a self-signed certificate** — informational, with the ACME/reverse-proxy path spelled out.
- **No public URL is set** — invite links and federation depend on it.
- **No account has been created yet** — the first registration becomes the owner; claim it before sharing the URL.
- **SQLite database is over 2 GB** / **Consider PostgreSQL at this user count** — points at the offline migrator, and is skipped entirely on PostgreSQL deployments.
- **No working voice/video backend** — critical; native media disabled and no LiveKit reachable.

A healthy deployment reports nothing and says so.

*Reported database size sums the database and its WAL sidecars, so a busy SQLite deployment reports what it is actually using on disk.*

### Notification settings

Muting a space used to be a browser preference: it did not follow you to another device, did not survive clearing site data, and the server never knew about it. Channels could not be muted at all, so a member of one busy space had no way to quiet a single noisy channel short of leaving.

Notification settings are now **server-side, per space and per channel**:

- **A level** — every message, only mentions, or nothing.
- **A mute**, indefinite or timed (up to 28 days).
- **Suppress @everyone**, independently of the rest.

They resolve **channel → space → default**, which is what makes both real cases work: quiet one channel in a space you otherwise follow, and follow one channel in a space you muted.

A timed mute is resolved when it is read rather than swept by a job, so it lapses on its own. Settings carry foreign keys to their scope, so deleting a space or channel removes its settings with it. The sidebar's existing mute writes through to the server, optimistically, and rolls back if the write fails.

### Automatic backups on by default

`backup.auto_backup_enabled` now defaults to **true** (24-hour interval, 10 retained, media included). In v1.0.0 a self-hoster got no backups unless they found the key in `config/paracord.toml`. Existing configs are untouched — this changes the default for new installs, and the health check flags the setting either way.

### Get set up

A new account's Home was a greeting, four small buttons, one sentence, and roughly three-quarters empty canvas — for exactly the people who needed guidance most.

Home now carries a **Get set up** checklist: create or join a space, set a display name and avatar, add a friend, start a conversation. Every row is derived live from store state rather than a stored flag, so a step un-checks itself if the underlying thing goes away, and the whole block disappears for good once the last step is done.

---

## Security

Two independent adversarial reviews covered authentication and sessions, authorization and object access, input handling, cryptography, the federation trust boundary, resource limits, and operational configuration. Every confirmed finding was remediated with a regression test, and each fix was validated by reverting it and confirming the test detects the regression.

The headline work:

**Media encryption.** The browser media path's AES-GCM nonce construction now guarantees a unique `(key, nonce)` pair for every frame, with an explicit refusal if a sequence number is ever reused — matching the guarantee the native encryptor already enforced. Sequence accounting across fragmented frames was corrected so consecutive frames cannot overlap.

**Credential lifecycle.** Attaching a login key now requires re-authentication with the account password and second factor, and a key is cleared by both a password change and a password reset. Accounts can see whether a key is attached and remove it, which revokes every session. Key-based login runs through the same MFA and email-verification gates as password login, and the MFA check fails closed on error.

**Session revocation.** Revoking a session, changing a password, or signing out everywhere now closes the associated realtime connections rather than only invalidating REST access. Realtime session identifiers are bound to their owner and cannot be claimed by another account.

**Authorization.** Thread permissions resolve strictly through the parent channel, and a thread's parent cannot be reassigned. Channel-level permission overwrites are honoured on webhook, stage, and interaction paths. Bot install-permission caps apply consistently across every space-scoped gate. Moderation reports are delivered to moderators rather than the whole space. `default_member_permissions`, `CHANGE_NICKNAME`, template application and stream control are all enforced.

**Federation.** Inbound events resolve to a concrete local space before dispatch, and outbound forwarding respects the space allowlist and channel visibility. Content limits apply on every ingest path, responses from peers are size-bounded, relay fan-out is admission-controlled, and replay protection keys on the verified peer identity.

**Client and desktop.** Attachment requests resolve their credential from the origin being addressed. Download tickets are minted, keyed and served against the same server. Avatars accept an uploaded image or a data URL only. The web UI is served with a full set of security headers, and the desktop CSP adds `form-action` and `frame-ancestors`.

**Supply chain.** The updater signing key is scoped to the single step that signs, workflow permissions are least-privilege, actions in key-handling jobs are pinned to commit SHAs, and every dependency advisory at moderate severity or above is cleared.

### Native video decode

Hardware video decode selection now verifies that the selected backend can actually decode before committing to it. A hardware decoder that reports itself available but fails on its first frame — the state a mismatched NVIDIA driver produces between an update and a reboot — falls back to software once, loudly, instead of failing every frame for the session. Past the first decoded frame the fallback is disabled and later failures propagate as real errors.

### Resilience

Every request path now carries an explicit bound. Message sends cap and deduplicate attachment and sticker lists; uploads enforce their size limit while reading rather than after buffering; space icons and settings blobs are bounded before they reach the fan-out; and forum posts, bans and events are paginated. A default storage quota applies without configuration, and emoji and sticker counts are capped per space.

In the media stack, per-sender caches are bounded, control-plane identifiers share the binary path's length limit, hot control paths no longer clone room state, and QUIC connections are address-validated with a pre-authentication admission ceiling. The gateway meters heartbeats, control frames and key announcements, and enforces per-IP connection and handshake limits.

There is now a request timeout and a pool acquisition timeout, so a slow request sheds instead of holding a connection.

Every limit ships with a test asserting that ordinary use is unaffected: a normal message, a normal inline icon, a full fifty-participant call reconnecting at once, and a client heartbeating at its advertised interval.

---

## Fixes

### Random logout on page reload — high severity

The client had three code paths that refreshed the session. Two carried careful single-flight guards; the **session bootstrap path did not**. On every page load it raced the request interceptor's refresh.

The server rotates the refresh token on each use, so the loser of that race presented an already-rotated token and got a 401. Worse, the bootstrap path's error handler nulled the access token **even when the other refresh had just succeeded** — destroying a session that was actually valid.

Observed before the fix: two refresh calls per load, one 401, and an intermittent kick to `/login` behind four red "unauthorized" toasts. After: one refresh call, zero 401s, session survives repeated reloads.

Session bootstrap now shares the same single-flight promise as every other caller, and never tears down a session another caller established.

### Server admins locked out of the admin panel — high severity

The gateway's `READY` payload carries the *public* projection of your account — id, username, avatar, display name — and not private fields like `flags`. The client **replaced** its stored user with that projection, wiping `flags` the moment the gateway connected.

Since `flags` is what gates the control plane, a genuine server administrator would load `/app/admin` and be told **"Access denied."** Fixed on both sides: the client merges the `READY` projection into the authoritative profile instead of clobbering it, and the server includes the connecting user's own `flags` in `READY` so a cold start is correct too.

### Encryption claim on the sign-in screens

The login and register screens described end-to-end encryption in broader terms than the product delivers. The copy now states the actual guarantee: your data lives on a server you or a friend runs, direct messages can be end-to-end encrypted, and calls always are. `docs/known-limitations.md` remains the detailed reference.

---

## Upgrading from v1.0.0

1. **Back up first.** `paracord-server` writes backups to `backup.backup_dir`; take one before migrating.
2. **Start the new binary.** Migrations run automatically on both engines.
3. **Nothing is filtered until you say so.** AutoMod ships with zero rules; existing spaces behave exactly as before until an admin adds one.
4. **Muted spaces do not carry over.** Mutes moved from browser storage to the server, so existing local mutes are replaced by the server's set on first load. Re-mute anything you want quiet — it will follow you between devices from then on.
5. **Check Admin → Overview.** The findings list will tell you what this deployment still needs.

Schema rollback is not supported. Back up the database and media before applying migrations.

## API additions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/health` | Full health report and findings (admin) |
| `GET` `POST` | `/api/v1/guilds/{guild_id}/automod/rules` | List / create rules (`MANAGE_GUILD`) |
| `PATCH` `DELETE` | `/api/v1/guilds/{guild_id}/automod/rules/{rule_id}` | Update / delete a rule |
| `GET` | `/api/v1/guilds/{guild_id}/automod/hits` | Recent automated actions |
| `POST` | `/api/v1/guilds/{guild_id}/automod/test` | Dry-run a trigger against sample text |
| `GET` | `/api/v1/users/@me/notification-settings` | Every notification override you hold, both scopes |
| `PUT` `DELETE` | `/api/v1/guilds/{guild_id}/notification-settings` | Set / clear a space's notification settings |
| `PUT` `DELETE` | `/api/v1/channels/{channel_id}/notification-settings` | Set / clear a channel's notification settings |

A blocked message returns **403** with code `AUTOMOD_BLOCKED` and the operator's own reason as the message.

Notification settings take `level` (`0` all, `1` mentions, `2` nothing), `muted`, an optional `mute_duration_seconds` for a timed mute, and `suppress_everyone`. Responses include `muted_now`, which resolves a timed mute against the current time so a client never has to work out whether one has lapsed.

### Changes for direct API consumers

- **`POST /api/v1/auth/attach-public-key` requires the account password** (and a second factor when MFA is enabled). An attached key authenticates the account on its own, so adding one is treated as a credential change. The same route with `{"detach": true}` removes a key and revokes every session.
- **`avatar_hash` accepts an uploaded image or a `data:` URL.** Remote URLs are rejected, since avatars render automatically for every viewer.
- **Several endpoints now bound their input**: attachment and sticker id lists, sender-key envelope batches, space icons and settings blobs, and moderation-list applies. Forum posts, bans and events are paginated with a clamped `limit`/`offset`.

## PostgreSQL

PostgreSQL is a first-class deployment target in 2.0.0. All 87 migrations apply from scratch, and the SQLite → PostgreSQL migrator copies every table.

The whole `paracord-api` integration suite now runs against a real PostgreSQL server in CI on every change, not a handful of smoke tests. SQLite and PostgreSQL pass the same tests, which is what keeps engine-specific behaviour — length enforcement, boolean typing, aggregate types, temporal decoding — from diverging.

If you are moving an existing SQLite deployment across, `paracord-server migrate-to-postgres` performs the copy and verifies row counts per table.

## Verification

- `cargo test --workspace` — green.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `cargo fmt --all -- --check` — clean.
- **61 Rust suites / 1,238 tests** green on SQLite.
- Against a real `postgres:16`: the `paracord-api` integration suite (**349**) green. Both engines pass the same tests, and CI enforces it.
- Client: **169 files / 1,204 unit tests** green; `tsc --noEmit` clean; production build clean.
- The SQLite upgrade-from-tag smoke replays a populated v0.9.0 database through every migration.
- Both end-to-end suites green: the mocked smoke, and the real-server smoke against a freshly built release binary serving the embedded UI.
- Security fixes were validated by reverting each one and confirming its regression test detects the regression.
- The application was exercised as a user against a running server on both engines — registration, space creation, messaging, settings, thread moderation, timeouts and AutoMod — and once more against the published release binary serving the embedded UI at three viewport widths, with no server-side errors and no layout overflow.
- Every dependency advisory at moderate severity or above is cleared across the full tree.

## Known issues

- The support boundaries in [docs/known-limitations.md](docs/known-limitations.md) — platform capture support, federation maturity, macOS system audio — are unchanged from v1.0.0.
- Federation remains early. It is signed, replay-protected, and covered by tests, but it has not been exercised across a large network of independent servers.

---

Previous release notes: [v1.0.0 — Native Media, Zero-Config, Emerald Commons](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
