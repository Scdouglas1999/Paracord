# Paracord 2.0.0 — AutoMod, Server Health, and a Server That Looks After Itself

**Paracord 2.0.0** is about the two things v1.0.0 left to the operator: keeping a community civil, and knowing whether the server behind it is actually healthy. v1 shipped a capable engine — native QUIC media, dual-database support, scheduled backups, federation — but gave the person running it four counters and a config file. This release turns that capability into something you can see and act on, and adds the content-moderation layer a public community needs.

It is also, honestly, a correctness release. Two full adversarial security reviews ran against the whole codebase — a ten-agent audit, then a seven-lens follow-up that found materially more — and every confirmed finding was fixed: thread permissions that let a denied member read private threads, a DM session-hijacking path, a heap overflow in the media decoder, thread locks that did nothing, and more. Separately, PostgreSQL turned out to be barely tested — the entire integration suite ran on SQLite, which cannot catch a PostgreSQL-only defect by construction. That suite now runs against a real PostgreSQL server in CI, and the six failures it found the first time are fixed.

Where this document previously said PostgreSQL was unusable and that two failing video tests were harmless, it was wrong on both counts. Both are corrected below, and both are fixed.

Full compare: **[v1.0.0...v2.0.0](https://github.com/Scdouglas1999/Paracord/compare/v1.0.0...v2.0.0)**

---

## Highlights at a Glance

| Area | What's new |
|------|------------|
| **Moderation** | **AutoMod** — keyword, pattern, link/invite, mention-flood, and spam rules that run on every message, with block / timeout / alert actions |
| **Operations** | **Server health** — a real diagnostics view that tells you what's wrong *and what to do about it*, replacing four bare counters |
| **Backups** | Automatic scheduled backups are now **on by default** |
| **Onboarding** | A **Get set up** checklist on Home, derived from live state — no more empty first screen |
| **Notifications** | **Per-space and per-channel** notification levels and mutes, stored server-side so they follow you between devices |
| **PostgreSQL** | PostgreSQL deployments **work** — and the whole integration suite now runs against a real server in CI, not four smoke tests |
| **Security** | Two full adversarial reviews and their remediation: media-key recovery, an account backdoor that survived password reset, revocation that did not close live connections, private threads exfiltrated by re-parenting, and more |
| **Availability** | Every resource one user could exhaust is now bounded — request shapes, uploads, storage, the media relay, and pre-auth QUIC state |
| **Reliability** | Fixed a refresh race that logged people out **at random on page load** |
| **Access** | Fixed server admins being **locked out of the admin panel** as soon as the gateway connected |
| **Honesty** | Corrected a false end-to-end-encryption claim shown on the login and register screens |

> Verified at release: **61 Rust suites / 1,238 tests** green on SQLite; the API suite (**349**) green against a real `postgres:16`; **169 client files / 1,204 tests** green; `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --check` clean; `tsc --noEmit` clean; both end-to-end suites passing. See [Verification](#verification).

---

## What's New

### AutoMod

`automod_rules` existed as a table in v1.0.0's very first migration and was never wired to anything — no evaluator, no routes, no UI. v2.0.0 makes it a real feature.

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
- **Hit history** — every automated action is recorded with the rule, the match, the actions taken, and an excerpt of the offending content, shown under Space Settings → AutoMod.
- **Audit-log entries** for rule create / update / delete.

**Design notes.** Patterns are compiled with Rust's `regex` crate, which has no backtracking, so a hostile pattern cannot cause exponential blowup; pattern length and compiled program size are bounded on top of that. Rules are validated once, on write — a stored rule that fails to parse is skipped and logged rather than failing the send. **AutoMod fails open**: if evaluation itself errors, the message goes through. A broken filter must never take chat down.

AutoMod is scoped to human messages sent through the REST API, plus webhook executions whose creator lacks `MANAGE_GUILD`. Bot messages and scheduled delivery are operator-authored and not filtered.

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

*One correctness note worth calling out: the pool runs SQLite in WAL mode, so the main `.db` file can sit at a few KB while megabytes of committed data live in the `-wal` sidecar. Reported database size sums the database and its sidecars — otherwise the panel would tell a busy operator their database was empty.*

### Automatic backups on by default

`backup.auto_backup_enabled` now defaults to **true** (24-hour interval, 10 retained, media included). In v1.0.0 a self-hoster got no backups at all unless they found the key in `config/paracord.toml`. Existing configs are untouched — this changes the default for new installs, and the health check flags the setting either way.

### Get set up

A new account's Home was a greeting, four small buttons, one sentence, and roughly three-quarters empty canvas — for exactly the people who needed guidance most.

Home now carries a **Get set up** checklist: create or join a space, set a display name and avatar, add a friend, start a conversation. Every row is derived live from store state rather than a stored flag, so a step un-checks itself if the underlying thing goes away, and the whole block disappears for good once the last step is done.

### Notification settings

Muting a space used to be a browser preference. It lived in `localStorage`, so it did not follow you to another device, did not survive clearing site data, and the server never knew about it — which meant nothing else could respect it. Channels could not be muted at all, so a member of one busy space had no way to quiet a single noisy channel short of leaving.

Notification settings are now **server-side, per space and per channel**:

- **A level** — every message, only mentions, or nothing.
- **A mute**, indefinite or timed (up to 28 days).
- **Suppress @everyone**, independently of the rest.

They resolve **channel → space → default**, which is what makes both real cases work: quiet one channel in a space you otherwise follow, and follow one channel in a space you muted.

A timed mute is resolved when it is read rather than swept by a job, so it lapses on its own instead of silently becoming permanent. Settings carry real foreign keys to their scope, so deleting a space or channel takes its settings with it rather than leaving rows pointing at ids that no longer resolve. The sidebar's existing mute keeps working exactly as before — it just writes through to the server now, optimistically, and rolls back if the write fails.

---

## Security

A ten-agent security and code-quality audit ran against the whole codebase, and every confirmed finding was fixed. Fixes were validated rather than accepted on report: each was mutation-tested — break the fix, confirm the exact failure returns, restore it.

**Access control.** Threads inherited nothing from their parent channel: overwrites and required roles were read from the thread's own row, so a member denied `VIEW_CHANNEL` on a private channel could still read and post in its threads through REST, the gateway, and SSE alike. Both permission paths now resolve the gate from `parent_id` and fail closed on a dangling parent. Separately, any user could delete any channel in any space via a body-supplied event channel id that was never validated; edit and delete skipped authorization entirely on the author path, so a kicked, banned, or timed-out user kept editing their messages; and economy level-roles skipped the role-assignability check, letting a `MANAGE_GUILD` moderator map `ADMINISTRATOR` to level 0 and self-promote.

**End-to-end encryption.** DM sessions could be hijacked: the peer identity key was taken from the attacker-supplied message header, never compared against the real peer, and the resulting session saved under the legitimate peer's key. Identity pinning existed and was tested but was wired only into the profile card, never the crypto path; it is now enforced fail-closed at bundle fetch, X3DH, group-DM wrap, and media sender-key wrap. Found while writing the regression test: `ratchetEncrypt` sealed with a stripped AAD while decrypt fed back the full wire header, so **the first message of every DM could never decrypt** — invisible because the existing test hand-rebuilt the header it was meant to be checking.

**Media.** Odd frame dimensions — legal H.264 via SPS cropping — made swscale write past a buffer sized with truncating halves, a heap overflow with attacker-controlled bytes. A 23-byte metadata tail guarded as 22 meant a 24-byte body panicked inside `Buf::advance`, killing the relay's forwarding task and all client media reception; it is now covered by a 40,000-case fuzz test. Frames were also routed by unauthenticated stream identity, so a subscribed peer could render video on another participant's tile.

**Moderation.** Locking a thread did nothing: the send path never read `thread_metadata`, so the padlock appeared, the audit log recorded the action, and members kept posting. `locked` also counted as a thread-*owner* right, so the member a thread was locked against could simply unlock it. And a timeout only covered `POST /messages`, so a timed-out member could still open threads and rename them — talking through the timeout via the title.

**AutoMod evasion.** Every accented substitution defeated the keyword filter — `bádword`, `badwörd`, `baḍword` all delivered. The fold applied NFKC, which *composes* a base character and its accent into a single precomposed code point of category `Ll`, so the combining-mark strip never saw it. It now applies NFKD, which decomposes instead.

### Native video decode

All native video decode was dead on any Linux machine whose NVIDIA kernel module and userspace libraries were at mismatched versions — the routine state between a driver update and the next reboot. `av_hwdevice_ctx_create` and `avcodec_open2` both succeed there, and a hardware frames context even allocates, so construction selected NVDEC and reported itself hardware-accelerated. The lie only surfaced on the first `avcodec_send_packet`. Nothing fell back, so every VP9/H.264/AV1 frame failed for the whole session and screen share rendered nothing.

Construction cannot detect this, so the capability check now finishes on the first packet: a hardware backend that fails before it has ever produced a frame was never usable, and the decoder reopens on the software backend once, loudly. Past the first decoded frame the flag clears and later failures propagate as the real errors they are.

### A second review, and what it found

The audit above was followed by a seven-lens adversarial review — authentication, authorization, injection, cryptography, availability, the federation trust boundary, and secrets — run against the whole codebase with each finding required to carry a working attack rather than a suspicion. It found materially more than the first pass. Everything below is fixed, mutation-tested, and re-verified against a running server.

**A media encryption key could be recovered.** The web client's media path reused an AES-GCM `(key, nonce)` pair. The publisher advanced its sequence counter once per *frame* while each frame emitted one packet per fragment at `seq + fragmentIndex`, so consecutive frames overlapped — and the rollover counter only advanced when a sequence moved strictly backwards, so an exact repeat produced a byte-identical nonce. Under a fixed per-epoch key that leaks the XOR of two plaintexts *and* the GHASH subkey, which is enough to forge authenticated frames for the rest of the epoch. The Rust encryptor refuses this case outright; the TypeScript port had dropped the guard. Both halves are fixed: callers advance by a shared span helper, and a repeat now fails the send loudly. The desktop path was never affected.

**Adding a login key needed no password, and nothing ever removed it.** An attached Ed25519 key authenticates an account on its own, indefinitely — and attaching one required only a live session. It survived a password change, a password reset, and "sign out everywhere", and the owner could not see that it existed. Attaching now re-authenticates, the key is cleared by a password change *and* a reset, `GET /users/@me` reports whether one is attached, and there is a detach flow that revokes every session. Key login also skipped MFA entirely, so a second factor was enforced on the password path and ignored on the key path; both now share one gate. The MFA check itself failed *open* on a database error.

**Revoking a session did not close its live connection.** The gateway checked the token once, at connect, and never again, so a logged-out attacker kept receiving messages and DMs — and kept writing — for as long as they sent heartbeats. Realtime session ids were also guessable and claimable, which could divert a victim's DMs to someone else's stream. Both closed.

**Private threads could be published by moving them.** A thread's parent channel *is* its access control, and the channel-reordering route wrote `parent_id` straight from the request body with no validation. Re-pointing a private channel's thread at a public one exposed its contents. Alongside it: moderation reports were broadcast to every member of a space rather than its moderators, de-anonymising reporters to the people they reported; a channel-level `MANAGE_WEBHOOKS` deny was unenforceable; and the bot install-permission cap was bypassed on roughly two dozen guild gates, so a bot installed with no permissions exercised whatever a role gave it.

**A federated peer could reach every connected client.** A signed message whose guild could not be resolved fell through to a global dispatch, delivering peer-controlled content to every session on the server regardless of membership. Separately, outbound forwarding ignored the federation allowlist completely — every message in every local space, including private channels, was transmitted to any trusted peer.

**The desktop app leaked its home credential.** Attachment requests took their URL from the *active* server and their bearer token from the *home* server, so viewing a channel on another server sent that server your home token — on image render, with no click. The release workflow also exposed the update-signing key to all six of its jobs, and the web UI was served with no security headers at all, leaving the authenticated interface frameable.

### Availability

Separately from confidentiality, a single authenticated user could exhaust the server. Message sends accepted an unbounded, undeduplicated list of attachment ids and issued one query per entry — ninety-five thousand repeats of one id against a five-connection pool. A space icon was unbounded and re-broadcast to every connected session. Uploads were buffered entirely into memory before their size was checked. There was no request timeout anywhere, and no storage quota by default.

In the media stack, caches keyed by a peer-chosen SSRC grew without limit, control-plane identifiers were bounded only by the frame size while the hot path deep-cloned the entire room, and — the only unauthenticated case — QUIC connection state was allocated before any address validation, so a spoofed source could pin memory. A page containing certain Unicode could panic the link-preview task.

All of it is bounded now, and every bound ships with a test asserting that ordinary use is unaffected: a normal message, a normal inline icon, a full fifty-participant call reconnecting at once, a client heartbeating at its advertised interval.

---

## Fixes

### Random logout on page reload — high severity

The client had three code paths that refreshed the session. Two carried careful single-flight guards; the **session bootstrap path did not**. On every page load it raced the request interceptor's refresh.

The server rotates the refresh token on each use, so the loser of that race presented an already-rotated token and got a 401. Worse, the bootstrap path's error handler nulled the access token **even when the other refresh had just succeeded** — destroying a session that was actually valid.

Observed before the fix: two refresh calls per load, one 401, and an intermittent kick to `/login` behind four red "unauthorized" toasts. After: one refresh call, zero 401s, session survives repeated reloads.

Session bootstrap now shares the same single-flight promise as every other caller, and never tears down a session another caller established.

### Server admins locked out of the admin panel — high severity

The gateway's `READY` payload carries the *public* projection of your account — id, username, avatar, display name — and not private fields like `flags`. The client **replaced** its stored user with that projection, wiping `flags` the moment the gateway connected.

Since `flags` is what gates the control plane, a genuine server administrator would load `/app/admin` and be told **"Access denied — the control plane is limited to server administrators."** Fixed on both sides: the client now merges the `READY` projection into the authoritative profile instead of clobbering it, and the server includes the connecting user's own `flags` in `READY` so a cold start is correct too.

### False end-to-end-encryption claim

The login and register screens told every visitor:

> "Messages and calls are end-to-end encrypted by default — the server relays ciphertext it can never read."

That is not what Paracord does, and the project's own `docs/known-limitations.md` and README said so: space and channel messages are readable by the server, and end-to-end-encrypted DMs are opt-in. The claim has been replaced with an accurate description of the actual guarantee — your data lives on a server you or a friend runs, DMs *can* be end-to-end encrypted, and calls always are.

---

## Upgrading from v1.0.0

1. **Back up first.** `paracord-server` writes backups to `backup.backup_dir`; take one before migrating. This release repairs two upgrade-path migrations that were destructive on populated SQLite databases, but a backup is still the rule.
2. **Start the new binary.** Migrations run automatically on both engines — 84 in total, of which these are new since v1.0.0: `automod_rule_scoping`, `federation_epoch_default_overflow`, `pg_text_timestamps`, `hot_path_missing_indexes`, `varchar_limits_match_validation`, and `notification_settings`.
3. **Nothing is filtered until you say so.** AutoMod ships with zero rules; existing spaces behave exactly as before until an admin adds one.
4. **Muted spaces do not carry over.** Mutes used to live in browser storage and are now stored server-side; existing local mutes are replaced by the server's set on first load. Re-mute anything you want quiet — it will follow you between devices from then on.
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

Two behaviour changes worth knowing about if you drive the API directly:

- **`POST /api/v1/auth/attach-public-key` now requires the account password** (and a second factor when MFA is enabled), because an attached key authenticates the account on its own. The same route with `{"detach": true}` removes a key and revokes every session.
- **`avatar_hash` no longer accepts a remote URL** — an uploaded image or a `data:` URL only. Avatars render automatically for every viewer, so a remote one beaconed each viewer's address to a host the *other* user chose.
- Several endpoints now bound their input rather than accepting any length: attachment and sticker id lists, sender-key envelope batches, space icons and settings blobs, and moderation-list applies. Forum posts, bans and events are paginated with a clamped `limit`/`offset`.

## Verification

- `cargo test --workspace` — green.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `cargo fmt --all -- --check` — clean.
- **61 Rust suites / 1,238 tests** green on SQLite.
- Against a real `postgres:16`: the `paracord-api` integration suite (**349**) green. Both engines now pass the *same* tests, and CI enforces it.
- Client: **169 files / 1,204 unit tests** green; `tsc --noEmit` clean; production build clean.
- The SQLite upgrade-from-tag smoke replays a populated v0.9.0 database through every migration.
- Both end-to-end suites green: the mocked smoke, and the real-server smoke against a freshly built release binary serving the embedded UI.
- Fixes were **mutation-tested** rather than accepted on a green suite: each one was reverted, the exact original failure confirmed to return, and then restored.
- The app was additionally driven as a user — registering, creating a space, sending messages, changing settings, locking threads, timing members out, and exercising AutoMod — against a running server on both SQLite and PostgreSQL. Several of the fixes in this release were found that way and by nothing else.
- Before release the whole flow was run once more against the **release binary serving the embedded UI**: register, create a space, open a channel, post, open space settings and AutoMod, change user settings, at three viewport widths. Zero server-side errors, zero 5xx, zero panics, no horizontal overflow. The original attack payloads from both reviews were replayed against that same binary and refused.

## PostgreSQL

PostgreSQL deployments could not start when this release was first tagged: a
migration applied JSONB operators to a `TEXT` column and aborted. That is fixed,
and so is everything found behind it.

The deeper problem was that **PostgreSQL was barely tested**. Every integration
test ran against in-memory SQLite, and CI ran four narrow PostgreSQL smokes.
SQLite cannot catch a PostgreSQL-only defect by construction — it ignores
`VARCHAR(n)` lengths, accepts an integer where a `BOOLEAN` belongs, and has
different type semantics for aggregates — so an entire class of bug was
invisible.

The whole `paracord-api` integration suite now runs against a real PostgreSQL
server, in CI, on every change. Each test provisions its own database cloned
from a migrated template, so isolation matches SQLite's. Turning it on the first
time surfaced six real failures, all fixed in this release:

- **Group E2EE sender keys were entirely broken** — integer `0`/`1` bound into a
  `BOOLEAN` column, which PostgreSQL rejects outright.
- **Bot review summaries failed to decode** — `AVG()` over a `SMALLINT` returns
  `NUMERIC`, which the sqlx `Any` driver cannot decode, and one bad column fails
  the entire row.
- **Saving a space icon or an inline avatar was an unconditional 500** —
  `avatar_hash` and `icon_hash` accept an inline `data:` URL despite their names
  but were declared `VARCHAR(64)`. Six columns in total were narrower than the
  limit their own handler accepts.
- **Federation identifiers were never length-checked** — they arrive from a
  remote peer, and an over-long one inserted fine on SQLite and 500'd here.
- **Scheduled messages were never delivered** — the worker's query still
  projected two columns through a `TIMESTAMPTZ`-era expression after they became
  `TEXT`, so every poll failed and simply refilled the log.
- **Timestamps carrying an offset would not parse**, so rows containing one
  failed to decode.

83 migrations apply from scratch, and the SQLite → PostgreSQL migrator copies
every table. Two SQLite *upgrade-path* migrations that were destructive on
populated databases are also fixed — but take a backup before upgrading
regardless, as the upgrade section advises.

## Known issues

- The support boundaries in [docs/known-limitations.md](docs/known-limitations.md) — platform capture support, federation maturity, macOS system audio — are unchanged from v1.0.0.
- Federation remains early. It is signed, replay-protected, and covered by tests, but it has not been exercised across a large network of independent servers.

---

Previous release notes: [v1.0.0 — Native Media, Zero-Config, Emerald Commons](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
