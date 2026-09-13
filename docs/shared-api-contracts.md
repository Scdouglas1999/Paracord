# Shared wire contracts

`crates/paracord-contracts` holds the Rust types serialized by contracted HTTP
handlers and gateway metadata projections. Database rows, READY and HTTP detail
have distinct contracts. Do not describe a partial READY object as a full HTTP
detail.

Run from `client/`:

```sh
npm run contracts:generate
npm run contracts:check
```

Generation exports `contracts/api-contracts.json` from Rust, then writes types and
standalone validators into `client/src/api/generated/`. To verify the Rust side
without modifying files, run from the repository root:

```sh
cargo run --locked -p paracord-contracts --bin export-contracts -- --check contracts/api-contracts.json
```

CI checks both sides. Do not edit generated files or add client default values to
make an invalid response pass validation. `responseContract` preserves transport
errors and response metadata and rejects incompatible data without including
payload content in diagnostics. Production guild list/detail/create/update,
public-join and ownership-transfer responses use this boundary, as do:

- Users: `GET`/`PATCH /users/@me`, `POST /users/@me/avatar`,
  `GET`/`PATCH /users/@me/settings`, `GET /users/{user_id}/profile`. Responses
  are `CurrentUser`, `UpdatedCurrentUser`, `UserSettingsResponse`, and
  `PublicUserProfile`; `theme`/`status` are opaque server-stored strings, and
  profile extras (`bio`, `pronouns`, `linked_accounts`) are required nullable
  fields.
- Relationships: `GET /users/@me/relationships` returns `RelationshipList`
  (decimal-string ids, both `type` and `rel_type`, nested `RelationshipUser`).
  `POST /users/@me/relationships` takes `CreateRelationshipRequest`; the PUT and
  DELETE relationship routes return 204 with no body.
- Invites: `POST /channels/{id}/invites` → 201 `GuildInvite`,
  `GET /invites/{code}` → `InvitePreview` (nullable `guild`),
  `POST /invites/{code}` → `InviteAcceptResponse` (`{guild}` wrapper; the JSON
  request body is optional), `GET /guilds/{id}/invites` → `GuildInviteList`.
- Emojis: `GET /guilds/{id}/emojis` → `GuildEmojiList`,
  `POST /guilds/{id}/emojis` (multipart) → 201 `GuildEmoji`,
  `PATCH /guilds/{id}/emojis/{emoji_id}` → `GuildEmoji`. Deletes return 204.

Focused tests exercise the real domain APIs and ensure malformed snapshots
preserve the cache. The app projection derives known fields from generated
detail while allowing partial READY data; it is not used as an HTTP response
type.

Both SSE and WebSocket READY serialize `ReadyGuildCore` for the six persisted
metadata fields: ID, owner ID, name, nullable icon, creation time and member count.
The generated validator requires those fields, rejects blank identifying text and
checks the integer count range. The client additionally checks that the creation
time parses as a date. Rosters and channel projections are outside this small
metadata contract; accepting the core does not validate those extensions. READY
updates only its metadata fields, preserving settings confirmed by REST.

Schemas use explicit JSON Schema 2020-12 and separate serialize/deserialize modes.
Response `Option` fields without a skip attribute are required nullable fields;
request options can be omitted. Numeric formats are annotations backed by explicit
integer/range constraints. Unknown formats fail strict validator compilation.
Settings retain their extension fields while checking known fields. Decimal IDs
stay strings, preserving values beyond JavaScript's safe integer range.

OpenAPI embeds these exact schemas beneath named components and rebases local
`$defs` references. Each operation's `x-contract-coverage` distinguishes typed
requests/success responses from the remaining route inventory. Do not infer
complete API coverage from the existence of the OpenAPI endpoint. Guild, user,
relationship, invite, and emoji routes publish typed contracts; other domains
and structured error contracts remain open.

The implementation follows the primary documentation for
[Schemars serialization contracts](https://docs.rs/schemars/1.2.1/schemars/generate/struct.SchemaSettings.html),
[JSON Schema to TypeScript](https://github.com/bcherny/json-schema-to-typescript),
and [Ajv standalone validation](https://ajv.js.org/standalone.html). The generated
validators are bundled at build time; clients do not compile remote schemas.
