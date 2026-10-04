# IX-2 checkpoint: server hue and voice joined_at

Package IX-2 of [`index-plan.md`](../index-plan.md) §3, per
[`index-spec.md`](../../index-spec.md) §11. Server and contracts only.

## What exists now

**Schema** (`crates/paracord-db/migrations{,_pg}/20261004000001_index.sql`, the same
statements on both engines):

- `spaces.hue INTEGER NULL CHECK (hue IS NULL OR (hue >= 0 AND hue <= 359))`.
- `voice_states.joined_at TEXT NULL` (house `YYYY-MM-DD HH:MM:SS` UTC), added
  empty and then backfilled to `datetime('now')`. That is the constant-default
  path SQLite needs on a populated table; on PostgreSQL `datetime()` is the
  existing shim.

**Server behavior**

- `PATCH /api/v1/guilds/{id}` takes `hue`: a number from 0 to 359 sets it,
  `null` clears it, and leaving the field out keeps it. Out of range is a 400
  that the route raises before anything is written, so other fields in the same
  body are not applied either. A non-integer is refused by the body parser
  (4xx). Needs Manage Server, as every other field in this PATCH does (403). The
  audit entry records `hue`.
- `hue` is on every guild payload: `GuildSummary` (so also `GuildDetail` and the
  guild list), `ReadyGuildCore` over both the WebSocket gateway and SSE READY,
  and `GUILD_UPDATE` (which carries the `GuildDetail`). It is always present and
  is null when unset.
- `joined_at` is stamped on every join and listen join (native, LiveKit,
  federated and DM call joins, plus the legacy gateway and realtime upsert
  paths). It is kept on a repeat in the same channel (an in-place mode switch, a
  rejoin with a new receipt, a status update) and reset by a move to another
  channel or space. Leaving deletes the row, so coming back starts fresh.
- `joined_at` (RFC 3339) is carried on every voice-state snapshot: READY
  `guilds[].voice_states[]`, READY `dm_voice_states[]` (both transports), and
  every `VOICE_STATE_UPDATE` for someone in a channel (join, mode switch, flags,
  stream start and stop, stage).

**Rust API changes other code may care about**

- `SpaceRow.hue: Option<u16>`; `paracord_db::guilds::{set_space_hue, MAX_HUE}`.
  Every `spaces` query in `guilds.rs` selects `hue`.
- `VoiceStateRow.joined_at` and `VoiceStateWithUser.joined_at` are
  `DateTime<Utc>`, not `Option`. A NULL in the database is a decode error (the
  no-fallback policy). Every write path stamps the column and the migration
  backfills it, so a NULL would mean a corrupt row.
- `begin_voice_state_transition{,_with_mode}` now return a
  `VoiceStateTransition` whose `commit()` yields the stored `joined_at`
  (`RETURNING joined_at` from the upsert). Callers that ignore the value compile
  unchanged. `voice::commit_native_membership{,_with_mode}` return it too.
- `paracord_core::guild::update_guild` gained a trailing
  `hue: Option<Option<u16>>`.

**Contracts** (`contracts/api-contracts.json`, `client/src/api/generated/**`,
regenerated with `npm run contracts:generate`; `contracts:check` passes):

- `GuildSummary.hue`, `GuildDetail.hue`, `ReadyGuildCore.hue`: `number | null`,
  required, range 0 to 359. The wire type is `u32`, because the generator's Ajv
  only knows the `int32` and `uint32` formats (a `u16` emits `uint16`, which
  fails strict compilation).
- `UpdateGuildRequest.hue?: number | null` (`Option<Option<i32>>`, clearable).
- `VoiceStateSnapshot.joined_at: string | null`, required. It is null only on
  the legacy gateway status path when the flag write failed and no row for this
  channel could be read. Every other emitter sends a string.

## Decisions and deviations

- **Same channel keeps `joined_at`.** The spec says "set on every join and
  listen join (moving channels resets it)". I read the parenthetical as the only
  reset, so a listener who upgrades, or a client that rejoins after a network
  drop, keeps the room's "live N min" instead of restarting it. A new row (after
  a leave) is a new time.
- **Client READY mapping.** `gateway/dispatch.ts` builds the `Guild` from
  explicit READY core fields. I added one line (`hue: core.hue`) so the hue
  reaches `guildStore` from READY, plus the comment "six-field" became
  "seven-field". `GUILD_UPDATE` already merges the whole payload.
- **`types/voice.types.ts`.** Added `joined_at?: string | null` to `VoiceState`
  (one field, as the plan allows). `types/guild.types.ts` needed nothing, because
  `Guild` derives from the generated `GuildDetail`.

## Files touched outside the row's list (each a small, additive change)

- `crates/paracord-core/src/guild.rs`: hue parameter and validation.
- `crates/paracord-core/src/voice_events.rs`: `joined_at` on the two shared
  snapshot builders.
- `crates/paracord-api/src/routes/{dms,realtime,stage}.rs`: `joined_at` on the
  payloads they build; `hue` on SSE READY.
- `crates/paracord-ws/src/session.rs`: `ReadyGuild.hue`.
- `crates/paracord-db/src/messages.rs` (test helper only): `setup_channel`
  inserted its space through `guilds::create_guild`, which now selects `hue`. The
  migration tests call it on a pre-Index schema, so it inserts the row with raw
  SQL now.
- `crates/paracord-ws/tests/gateway_integration.rs`: a new gateway READY test,
  plus one assertion in the DM-call READY test.
- Client test fixtures, needed because the validators now require `hue`:
  `src/test/guildContractFixtures.ts` (`hue: null`, overridable),
  `e2e/fixtures/glass/install.ts` (READY guild `hue: null`),
  `src/api/{readyGuildContract,responseContracts}.test.ts`,
  `src/gateway/dispatch.test.ts`.

## For the next packages

- **Strict validators.** `isGuildDetail`, `isGuildSummaryList` and
  `isReadyGuildCore` now reject a guild without `hue`. A mocked server must send
  `hue` (`null` is fine), so use `guildDetailFixture`/`guildSummaryFixture`.
  IX-0's `e2e/fixtures/index` already does.
- **IX-7 ("live N min").** Use `min(joined_at)` over the room's current voice
  states. All of them carry it. Do not invent a time on the client.
- **IX-10 (Server color).** `PATCH /guilds/{id}` with `{ hue }` or
  `{ hue: null }`. The response and `GUILD_UPDATE` echo the stored value.
- **IX-4 tints.** Use `serverHue(guild)`. `guild.hue` arrives from READY, REST
  and `GUILD_UPDATE`.

## Verification

- `cargo test -p paracord-api --test index_hue_joined_at` (7 tests). It covers
  set, keep, clear, the 0 and 359 boundaries, out of range (400, nothing
  written), non-integer (4xx), the column CHECK, 403 without Manage Server,
  `GUILD_UPDATE`, REST detail and list, and SSE READY. On the voice side it
  covers `joined_at` on listen join, in-place switch, same-channel rejoin, full
  join, move, leave and rejoin, the legacy upsert path, DM call join, and READY
  voice states. It also checks the migration backfill by running every migration
  before `20261004000001`, inserting a live voice state, then migrating. It
  passes on SQLite and on PostgreSQL 16.
- Gateway: `ready_carries_the_server_hue_and_voice_joined_at`.
- Contracts: `hue_is_a_present_nullable_wheel_angle_and_a_clearable_patch`,
  plus the updated READY core and voice snapshot tests.
- `cargo test --workspace` on SQLite is green. On PostgreSQL 16 (throwaway
  docker container): the IX-2 file, `postgres_route_smoke`,
  `voice_listen_view{,_sse}`, `dm_call_streams`, `contract_wire_shapes`,
  `realtime_voice_receipts`, then the full `paracord-api` and `paracord-db`
  suites.
- `cargo fmt --all -- --check` and `cargo clippy --workspace -- -D warnings` are
  clean.
- Client: `npm run typecheck` is clean, `npm run lint` has 0 errors, and
  `contracts:check` passes. `npm run test:unit` has 3 failures:
  `stageTransition.test.tsx`, `useGlassKeybinds.test.tsx` and `AppShell.test.tsx`
  (theater chat hiding). They fail the same way on a clean checkout of HEAD
  without IX-2, so they are pre-existing and not from this package.
