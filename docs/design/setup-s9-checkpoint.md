# S9 checkpoint: invite preview, limits, defaults, shared parser

Package S9 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §6.1 to §6.3. Branch `feat/setup`.

Commits: `b76cdbba` (parser, landed first for S11), `22a92637` (server),
`d1e28a44` (client call sites).

## 1. The parser (`client/src/lib/inviteLinks.ts`)

`parseInviteLink(input): { serverUrl, code } | null`. Accepted:

- `paracord://invite/<base64url(serverUrl|code)>` (decoded with
  `tryDecodePortableLink`; the server part may carry a scheme or not);
- `https://host[:port][/prefix]/invite/CODE` (a trailing slash, query or
  fragment is ignored);
- `host[:port][/prefix]/invite/CODE` (https, or http for a loopback host).

Plain `http` only for loopback (`localhost`, `127.0.0.0/8`, `::1`); user info,
other schemes, a code that is not `[A-Za-z0-9_-]{1,64}`, or any whitespace
returns null. `serverUrl` is scheme + host + port + optional path prefix, no
trailing slash. A bare token without the `paracord://invite/` prefix is no
longer accepted (the old `isPortableLink` did); a bare code is not a link.
`portableLinks.ts` keeps the encode/decode helpers. 37-row table test in
`inviteLinks.test.ts`.

Call sites switched:

- `ServerConnectPage.tsx` `parseInput` (parser import only).
- `useAddServer.ts`: `inviteCodeOf` is replaced by `inviteTargetOf` (link or
  bare code, else null) and `accountForInvite`. A link to the server in view
  or a bare code uses the account in view; a link to another saved server uses
  that server's signed-in account (`guildLandingPath` then activates it); an
  unknown or signed-out server stops with a plain sentence. A paste that is
  neither says "That is not an invite link or code."
- **Behavior change:** `https://host/CODE` (no `/invite/`) used to work by
  taking the last path segment; it now fails with that sentence. Server share
  links have always been `/invite/CODE`. The Join placeholder in
  `AddServerSheet.tsx` and the e2e in `index-dock.spec.ts` used the made-up
  `paracord.gg/hTKzmak` shape; the placeholder is now
  `https://chat.example.com/invite/hTKzmak`, the e2e types the bare code.

## 2. Preview (`routes/invites.rs` `get_invite`, `paracord-db/src/invites.rs`)

- `faces`: `list_invite_face_members(pool, guild, online_ids, 3)`: non-bot
  members (`users.flags & 2 = 0`), those in the guild's online set first, then
  the newest, newest first (`joined_at DESC, user_id DESC`). The wire carries
  `{ initial, hue }` only: the first grapheme (`unicode-segmentation`, so an
  emoji with modifiers stays whole) of nick, else display name, else username;
  hue is `paletteHue(id)` ported to Rust (the client's 11-hue list, last nine
  digits mod 11), so a person has the same hue on the card and in the app.
- `online_count`: the guild's members currently online from `online_users`
  (bots included, like `member_count`). `hue`, `expires_at`, `instance`: as S0,
  now `credential_version: 2` (S2 landed).
- Privacy test (`tests/invite_preview.rs`): exact key sets at every level, and
  the serialized body contains no username, display name, member id, inviter
  id, channel id or bot; the only id is the guild's.
- Dependency added: `unicode-segmentation = "1.12"` in `paracord-api`
  (already in `Cargo.lock`).

## 3. Rate limits (`paracord-api/src/lib.rs`, `rate_limit_middleware`)

For matched path `GET /api/v1/invites/{code}` only:

1. lockout check: a source with 20 misses in 10 minutes gets 429
   (`RATE_LIMITED`, `retry_after` = seconds left, up to 600) for 10 minutes;
2. bucket `http:invite:{ip}`: 30 per minute per source (IPv6 collapsed to /64
   like the other buckets);
3. after the handler, a 404 records a miss.

**Deviation from §6.2:** the spec names `rate_limits::increment_distinct_window_counter`
(a DB counter). The middleware has no `AppState`/DB handle, and every other
bucket in it is in memory, so the miss count is an in-memory moka cache
(`HttpRateLimiter::invite_misses`) beside `buckets`. Consequences: it resets on
restart and is per process, not shared across replicas. Counting is "20 404s
inside a 10 minute window", not distinct codes. Hits do not reset the count.
Misses during the lockout do not extend it.

Tests: `tests/invite_rate_bucket.rs` (30 ok, 31st 429, other routes fine),
`tests/invite_rate_lockout.rs` (19 misses + a hit + the 20th, then a real code
is 429 with `retry_after` 590 to 600), and two unit tests in `lib.rs`
(`invite_miss_tests`, injectable clock: lock, release after 10 minutes, slow
misses never lock). Each integration file is its own process because the
limiter is a process-wide static and every test request shares one source.

## 4. Defaults

`CreateInviteRequest` serde defaults: `max_age` 604800, `max_uses` 25
(`paracord-contracts/src/invite.rs`; doc comments updated, so
`CreateInviteRequest.ts` regenerated; `contracts:check` verifies 55 types).
`InviteModal.tsx`: Max uses starts at 25 (expiry was already 7 days). Explicit
`0` still means never/unlimited.

## 5. Gates

| Gate | Result |
|---|---|
| `cargo fmt` on touched crates | ok (`cargo fmt --all --check` shows other packages' files) |
| `cargo clippy -p paracord-api -p paracord-db -p paracord-contracts --all-targets -D warnings` | ok |
| `invite_preview` (3), `invite_rate_bucket` (1), `invite_rate_lockout` (1), `--lib invite_miss` (2) | pass |
| `invite_preview` on PostgreSQL 16 (`PARACORD_TEST_POSTGRES_URL`, docker, port 55439, stopped) | 3 passed |
| `--lib` (136), `coverage_gap_routes`, `contract_wire_shapes`, `realtime_*`, `registration_invite_only`, `srv_api6_account_bot_authz`, `rate_limit_regressions` | all pass |
| `npm run typecheck`, `contracts:check`, `test:tokens`, `test:motion-lint`, `lint` | ok (0 errors) |
| `npm run test:unit` (one run, before the final dock test edit) | 4792 passed, 1 failed (`AddServerSheet` Join test using the old `paracord.gg` shape), fixed and `src/components/ix/dock` re-run: 104 passed |
| Playwright `index-dock.spec.ts` | not run (edit is two string literals) |

Live (port 18490, `.live-env-s9` deleted, debug build copied from the shared
target, `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1` because S2 refuses `/auth/register`
otherwise; two accounts, one guild): invite created with `{}` came back
`max_age 604800, max_uses 25`; the anonymous preview returned
`{"faces":[{"initial":"s","hue":150}],"guild":{... "hue":null,"online_count":0},"expires_at":"2026-10-19T…","instance":{"name":"Paracord Server","version":"3.3.0","credential_version":2,"registration_mode":"open","require_email":true}}`;
20 bad codes were 404; the next request with the real code was 429
`retry_after 600` with a `retry-after: 600` header; `/users/@me` stayed 200.

## 6. Notes for others

- S11: use `parseInviteLink`; it never throws.
- S13: the preview JSON is final; the face `initial` is as typed (not
  uppercased), so style with CSS or uppercase in the component.
- A source behind a shared NAT/proxy shares one bucket; with
  `PARACORD_TRUST_PROXY` unset every request behind a reverse proxy looks like
  one source, as for the existing auth bucket.
