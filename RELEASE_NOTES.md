# Paracord 2.0.0 — AutoMod, Server Health, and a Server That Looks After Itself

**Paracord 2.0.0** is about the two things v1.0.0 left to the operator: keeping a community civil, and knowing whether the server behind it is actually healthy. v1 shipped a capable engine — native QUIC media, dual-database support, scheduled backups, federation — but gave the person running it four counters and a config file. This release turns that capability into something you can see and act on, adds the content-moderation layer a public community needs, and fixes two bugs that were quietly breaking real sessions.

Full compare: **[v1.0.0...v2.0.0](https://github.com/Scdouglas1999/Paracord/compare/v1.0.0...v2.0.0)**

---

## Highlights at a Glance

| Area | What's new |
|------|------------|
| **Moderation** | **AutoMod** — keyword, pattern, link/invite, mention-flood, and spam rules that run on every message, with block / timeout / alert actions |
| **Operations** | **Server health** — a real diagnostics view that tells you what's wrong *and what to do about it*, replacing four bare counters |
| **Backups** | Automatic scheduled backups are now **on by default** |
| **Onboarding** | A **Get set up** checklist on Home, derived from live state — no more empty first screen |
| **Reliability** | Fixed a refresh race that logged people out **at random on page load** |
| **Access** | Fixed server admins being **locked out of the admin panel** as soon as the gateway connected |
| **Honesty** | Corrected a false end-to-end-encryption claim shown on the login and register screens |

> Verified at release: full `cargo test --workspace` green, **1,129 client unit tests** green, `cargo clippy --workspace -- -D warnings` clean, `cargo fmt --check` clean, production client build clean. See [Verification](#verification).

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

1. **Back up first.** `paracord-server` writes backups to `backup.backup_dir`; take one before migrating.
2. **Start the new binary.** One new migration (`20260725000001_automod_rule_scoping`) runs automatically on SQLite and PostgreSQL. It adds exemption and timestamp columns to the existing `automod_rules` table and creates `automod_hits`.
3. **Nothing is filtered until you say so.** AutoMod ships with zero rules; existing spaces behave exactly as before until an admin adds one.
4. **Check Admin → Overview.** The findings list will tell you what this deployment still needs.

Schema rollback is not supported. Back up the database and media before applying migrations.

## API additions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/health` | Full health report and findings (admin) |
| `GET` `POST` | `/api/v1/guilds/{guild_id}/automod/rules` | List / create rules (`MANAGE_GUILD`) |
| `PATCH` `DELETE` | `/api/v1/guilds/{guild_id}/automod/rules/{rule_id}` | Update / delete a rule |
| `GET` | `/api/v1/guilds/{guild_id}/automod/hits` | Recent automated actions |
| `POST` | `/api/v1/guilds/{guild_id}/automod/test` | Dry-run a trigger against sample text |

A blocked message returns **403** with code `AUTOMOD_BLOCKED` and the operator's own reason as the message.

## Verification

- `cargo test --workspace` — green.
- `cargo clippy --workspace -- -D warnings` — clean.
- `cargo fmt --all -- --check` — clean.
- Client: **1,129 unit tests** green; `tsc --noEmit` clean; production build clean.
- **23 new automated tests** — 13 covering the AutoMod rule engine (whole-word boundaries, allowlisted domains, distinct-mention counting, validation rejections), 10 covering the health advice engine (including that a loopback dev server is not flagged for plaintext, and that PostgreSQL deployments skip SQLite advice), plus client regression tests for both bugs above.
- AutoMod and the health endpoint were additionally exercised end-to-end against a running server: rule creation, blocking, whole-word near-misses, admin bypass, hit recording, link allowlists, dry runs, permission enforcement, channel alerts, and member timeouts.

## Post-release audit — PostgreSQL is not usable in v2.0.0

A full security and code-quality audit run immediately after this release found
that **PostgreSQL deployments cannot start**. `migrations_pg/20260708000001`
applies JSONB operators (`->>`, `?`) to `user_settings.notifications`, which is
declared `TEXT`, so migrations abort with `operator does not exist: text ->> unknown`
and startup fails. The fix is in the working tree but is not part of this tag.

Further Postgres-only defects were confirmed behind that one: seven federation
column defaults overflow `int4`, a `MAX(a, b)` call uses SQLite scalar semantics
where Postgres has only the aggregate, and roughly 21 tables declare native
`TIMESTAMP` columns that the sqlx `Any` driver cannot decode.

**Treat SQLite as the only supported engine for v2.0.0.** Disregard the
PostgreSQL recommendation elsewhere in these notes until a follow-up release
lands the fixes. Two SQLite *upgrade-path* migrations were also found to be
destructive on populated databases — take a backup before upgrading, which the
upgrade section already advises.

## Known issues

- Two VP9 decode unit tests (`native_media::video_pipeline`) fail on this Linux/libvpx build with `NeedKeyframe`. **This is pre-existing and not introduced by this release** — it was reproduced identically on a clean `v1.0.0` checkout. Screen share and video calls are unaffected in normal operation, but the decode path should be validated on your target distribution before publishing Linux artifacts.
- The support boundaries in [docs/known-limitations.md](docs/known-limitations.md) — platform capture support, federation maturity, macOS system audio — are unchanged from v1.0.0.

---

Previous release notes: [v1.0.0 — Native Media, Zero-Config, Emerald Commons](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
