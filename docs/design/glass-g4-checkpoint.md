# WP-G4 checkpoint: channel previews

Status: done, not committed. Branch `design/glass`.

## Endpoint

`GET /api/v1/guilds/{guild_id}/channel-previews` → `ChannelPreviewList`
(a JSON array of `ChannelPreview`, ordered by channel id). Non-members get 403.

One entry per channel that

- is a text-like type: text (0), voice (2, its text chat), announcement (5) or
  stage (13). Categories and forums hold no messages of their own; threads are
  not rows of the places panel, so they are left out;
- the caller can read: `VIEW_CHANNEL` **and** `READ_MESSAGE_HISTORY`, the pair
  `GET /channels/{id}/messages` requires (a preview is the newest message of the
  history, so VIEW alone would leak history to a member who may only see live
  messages);
- has at least one message. An empty channel has no entry; the client treats a
  missing entry as "nothing yet".

```ts
interface ChannelPreview {
  channel_id: string;          // decimal snowflake
  message_id: string;
  message_type: number;        // 0 default, 20 poll, …
  author_id: string;           // see author_kind
  author_kind: 'user' | 'webhook' | 'feed' | 'anonymous';
  author_name: string | null;  // guild nick > display name > username; webhook/feed name; anonymous alias
  content: string | null;      // ≤ 140 chars, see below; null if encrypted or no text
  truncated: boolean;
  encrypted: boolean;
  created_at: string;          // RFC 3339
  media: { attachment_id: string; content_type: string | null; filename: string;
           width: number | null; height: number | null } | null;
  attachment_count: number;
  has_sticker: boolean;
}
```

Decisions:

- **Text.** The server collapses whitespace runs (newlines included) to single
  spaces and cuts to at most 140 characters including a trailing `…`
  (`truncated: true`). A cut never ends inside a `<@…>`, `<#…>`, `<:…>`, `<a:…>`
  or `<t:…>` token; the half token is dropped. Markdown is **not** stripped:
  mentions, spoilers and emphasis are rendered by the client, which already
  resolves `<@id>` and knows the viewer's spoiler settings. (140 follows the
  plan's contract in glass-plan.md §3; the WP brief said "~120".)
- **Media.** `media` is the message's first attachment (lowest id) whenever the
  message has one, not only when it is media-only: the row can lead with a
  thumbnail either way, and `content === null` tells the client it is
  media-only. The client builds the URL from `attachment_id`, as elsewhere.
- **Encrypted messages** (`MESSAGE_FLAG_DM_E2EE`): `content` and `media` are
  null, `encrypted: true`; ids, author and time remain (the message routes
  expose the author of an encrypted message too). No server-side decryption.
- **Author identity** matches what the message itself reads as
  (`build_message_json`): a webhook post as the webhook, a feed post as the
  feed, and an anonymous message as `anon:{channel_id}:{alias}` with the alias as
  name, unless the viewer has `MANAGE_MESSAGES` or `MANAGE_GUILD` in that
  channel, who get the real user id (kind stays `anonymous`, name stays the
  alias).
- **Not included:** unread/mention state (comes from read states, as the spec
  says), and "the last speakers' faces" (several recent authors). G9 can keep
  its own recent-author list from `MESSAGE_CREATE`; if a server list is wanted
  later it is a follow-up field.

## Query and index

`paracord_db::channel_previews::latest_messages_for_channels(pool, guild_id,
channel_ids)` answers every readable channel in **one query** (chunks of 500
channel ids; a guild with ≤ 500 channels is one round trip). Per channel, the
newest message is an `ORDER BY x.id DESC LIMIT 1` subquery on
`messages WHERE channel_id = c.id`, joined to `messages` by primary key; users,
the guild's `members` row (nickname), `webhook_messages`/`webhooks`,
`feed_messages` and `anonymous_messages` are left-joined by key; attachment and
sticker counts are correlated `COUNT(*)`s on `attachments(message_id)` and
`message_stickers(message_id, …)`; the first attachment is a primary-key join
on a `LIMIT 1` subquery. Permissions come from the existing
`compute_all_channel_permissions` + `seed_channel_permissions` (as
`GET /guilds/{id}/channels` does).

The newest message is read from `messages`, not from `channels.last_message_id`,
so a drifted tail can never point a preview at a missing row.

**Index:** no migration. `idx_messages_channel_created ON messages(channel_id,
id DESC)` exists on both engines (initial schema, re-created in
`guilds_to_spaces`), and `idx_attachments_message_id` exists too.

- SQLite: `paracord-db` unit test
  `sqlite_plan_seeks_the_newest_message_through_an_index` runs
  `EXPLAIN QUERY PLAN` and asserts the plan uses `idx_messages_channel_created`
  and contains no table scan.
- PostgreSQL 16 (manual `EXPLAIN ANALYZE`, 200 channels, 200 000 messages): the
  subplan is `Index Only Scan using idx_messages_channel_created … Limit`, then
  `messages_pkey`; all 200 channels in 1.4 ms.

## Files

Server:
- `crates/paracord-contracts/src/channel.rs` (new): `ChannelPreview`,
  `ChannelPreviewMedia`, `ChannelPreviewAuthorKind`.
- `crates/paracord-contracts/src/lib.rs`: `pub mod channel`, the two schemas,
  one contract unit test.
- `crates/paracord-db/src/channel_previews.rs` (new) + `pub mod` in `lib.rs`.
- `crates/paracord-api/src/routes/channels/previews.rs` (new) + `mod`/`pub use`
  in `routes/channels/mod.rs`.
- `crates/paracord-api/src/lib.rs`: one `.route(…)`.
- `crates/paracord-api/tests/channel_previews.rs` (new, 6 tests).

Contracts and client:
- `contracts/api-contracts.json` (regenerated).
- `client/src/api/generated/ChannelPreview.ts`, `ChannelPreviewList.ts` (new),
  `validators.js`, `validators.d.ts` (regenerated; the large diff in
  `validators.js` is renumbering, since the new names sort early).
- `client/src/api/channels.ts`: `channelApi.getChannelPreviews(guildId, config?)`
  → `AxiosResponse<ChannelPreviewList>`, validated against the generated
  validator (throws `ApiContractError` on a bad body). It loads the validator
  through `loadValidators()` because `contractValidators.ts` was outside this
  package's file list; whoever next touches that file can add
  `isChannelPreviewList` there and switch this to `responseContract`.

## Commands

| Command | Result |
|---|---|
| `pc-cargo.sh check -p paracord-contracts -p paracord-db -p paracord-api --tests` | pass |
| `cargo fmt --all -- --check` | pass |
| `pc-cargo.sh clippy -p paracord-api -p paracord-db -- -D warnings` | pass |
| `pc-cargo.sh clippy -p paracord-api -p paracord-db -p paracord-contracts --tests -- -D warnings` | pass |
| `pc-cargo.sh test -p paracord-api --test channel_previews` (SQLite) | 6/6 pass |
| same with `PARACORD_TEST_POSTGRES_URL` (PostgreSQL 16) | 6/6 pass |
| `… --test postgres_route_smoke` with the PG URL | 2/2 pass |
| `pc-cargo.sh test -p paracord-db --lib channel_previews` | 2/2 pass |
| `pc-cargo.sh test -p paracord-contracts` | 5/5 pass |
| `pc-cargo.sh test -p paracord-api --lib` | 128/128 pass |
| `… --test contract_wire_shapes --test channel_message_routes` | 6/6, 24/24 pass |
| `export-contracts --check contracts/api-contracts.json` | pass |
| `npm run contracts:check` | pass (29 types) |
| `npm run typecheck`, `npx eslint src/api/channels.ts` | pass |

The full workspace suite (`cargo test --workspace`) was not run.

## PostgreSQL coverage

No PostgreSQL is installed on the box. The tests ran against a throwaway
`postgres:16-alpine` Docker container (tmpfs data, removed afterwards) through
the harness's `PARACORD_TEST_POSTGRES_URL`, which reruns the whole
`channel_previews` suite on PostgreSQL (confirmed: the harness created its
`pctpl_…` template database in that server). `postgres_route_smoke` was not
extended (outside this package's files); the preview suite itself is the PG
coverage for this route. CI runs it on PG only where that variable is set.

## Tests in `channel_previews.rs`

1. Newest message per text-like channel (text and voice), author id/kind/name,
   whitespace collapse, RFC 3339 time; empty channel and category absent; guild
   nickname wins over the username.
2. Long text cut to ≤ 140 chars with `…`; deleting the newest message falls back
   to the one before.
3. Permission filtering: a channel with VIEW denied and one with
   READ_MESSAGE_HISTORY denied are absent for a member (and their text is not in
   the body), present for the owner; a non-member gets 403.
4. Media-only message: `content` null, first attachment as `media`,
   `attachment_count` 2.
5. Encrypted message: `encrypted` true, `content` and `media` null, no
   ciphertext or file name in the body; ids and time present.
6. Anonymous message: members see `anon:…` and the alias, never the real id or
   username; the owner sees the real id.

Every response entry is also deserialized into the Rust `ChannelPreview`
contract type.
