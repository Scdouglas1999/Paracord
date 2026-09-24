# Paracord API and Gateway Contracts (v1)

This document defines the baseline contracts for Paracord server and clients.

The canonical route inventory is generated at runtime from the Axum router:

- `GET /api/docs` - Swagger UI
- `GET /api/docs/openapi.json` - generated OpenAPI 3.1 route inventory with path parameters and auth/rate-limit metadata

Keep this document focused on stable resource shapes and higher-level contracts; use the generated OpenAPI document for the complete route list.

## Resource Shapes

### Channel

- `id`: string snowflake
- `guild_id`: string or null
- `type`: number (`channel_type` is also sent for compatibility)
- `name`: string or null
- `position`: number
- `parent_id`: string or null

### Message

- `id`: string snowflake
- `channel_id`: string
- `author`: `{ id, username, discriminator, avatar_hash }`
- `content`: string or null
- `type`: number (`message_type` is also sent for compatibility)
- `timestamp`: ISO-8601 string (`created_at` also sent)
- `edited_timestamp`: ISO-8601 string or null (`edited_at` also sent)
- `reference_id`: string or null
- `attachments`: list of attachment objects
- `reactions`: list of reaction aggregates (`emoji`, `count`, `me`)

### DM Channel

- `id`: string snowflake
- `type`: `1`
- `recipient`: `{ id, username, discriminator, avatar_hash }`
- `last_message_id`: string or null

### Read State

- `channel_id`: string
- `last_message_id`: string
- `mention_count`: number

## REST Endpoints (v1)

### Auth

- `POST /api/v1/auth/register`
  - body: `{ email, username, password, display_name? }`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/options`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/challenge`
- `POST /api/v1/auth/verify`
- `POST /api/v1/auth/attach-public-key`
  - Requires a live tracked session and current password, plus MFA when enabled.
  - Attach body: `{ public_key, nonce, timestamp, signature, password, mfa_code?, expected_public_key? }`.
  - Omitted or null `expected_public_key` requests first enrollment. Replacing an existing key requires its exact previous value (hex case is ignored); stale expectations return `409`. Reattaching the current key preserves existing sessions.
  - Successful changes return the replacement authentication response and cookies. Key ownership, old-session revocation, and replacement-session creation commit together; storage failures roll back all three.
  - Detach body: `{ detach: true, password, mfa_code? }`. Key removal and session revocation commit together.
- `GET /api/v1/auth/sessions`
- `DELETE /api/v1/auth/sessions/{session_id}`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`
- `POST /api/v1/auth/verify-email`
- `POST /api/v1/auth/mfa/setup`
- `POST /api/v1/auth/mfa/verify`
- `POST /api/v1/auth/mfa/disable`
- `GET /api/v1/auth/mfa/status`
- `POST /api/v1/auth/mfa/login`

Identity key ownership is case insensitive. Migration
`20260909000004_identity_key_case_uniqueness` adds a unique index over
`lower(public_key)` on both database engines and preserves existing key spelling.
If older data contains multiple owners for the same key, the migration stops
without selecting or deleting an owner. An administrator must resolve those
conflicting account identities before retrying the upgrade; changing hex case
cannot resolve a cryptographic ownership conflict.

### Users

- `GET /api/v1/users/@me`
- `PATCH /api/v1/users/@me`
- `PUT /api/v1/users/@me/password`
- `PUT /api/v1/users/@me/email`
- `GET /api/v1/users/@me/data-export`
- `GET /api/v1/users/@me/export`
- `POST /api/v1/users/@me/import`
- `GET /api/v1/users/{user_id}/profile`
- `GET /api/v1/users/@me/settings`
- `PATCH /api/v1/users/@me/settings`
- `GET /api/v1/users/@me/guilds`
- `GET /api/v1/users/@me/dms`
- `POST /api/v1/users/@me/dms`
- `GET /api/v1/users/@me/read-states`
- `GET /api/v1/users/@me/relationships`
- `POST /api/v1/users/@me/relationships`
- `DELETE /api/v1/users/@me/relationships/{user_id}`
- `GET /api/v1/users/@me/keys` — authenticated public-key snapshot; does not consume prekeys. Returns `identity_key`, nullable `signed_prekey`, remaining `one_time_prekeys`, and nullable `last_resort_prekey`.
- `PUT /api/v1/users/@me/keys` — validates the complete request before atomically publishing its keys. Signed-prekey and one-time-prekey IDs belong to each account.
  Replay-safe publications include `request_id` (UUID) and `expected_identity_key`
  (the enrolled identity as lowercase hex). The response echoes `request_id`.
  Reusing an ID with different key material, or publishing after the enrolled
  identity changes, returns 409. An exact retry returns its original receipt
  without restoring consumed keys or replacing newer keys. Older requests that
  omit both fields retain their previous API contract; the new enrollment client
  requires an acknowledged publication ID.
- `GET /api/v1/users/@me/keys/count`
- `GET /api/v1/users/{user_id}/keys`

### Guilds

- `POST /api/v1/guilds`
- `GET /api/v1/guilds/{guild_id}`
- `PATCH /api/v1/guilds/{guild_id}`
- `DELETE /api/v1/guilds/{guild_id}`
- `POST /api/v1/guilds/{guild_id}/owner`
- `GET /api/v1/guilds/{guild_id}/channels`
- `GET /api/v1/guilds/{guild_id}/channels/visible`
- `POST /api/v1/guilds/{guild_id}/channels`
- `GET /api/v1/guilds/{guild_id}/members`
- `PATCH /api/v1/guilds/{guild_id}/members/{user_id}`
- `DELETE /api/v1/guilds/{guild_id}/members/{user_id}`
- `DELETE /api/v1/guilds/{guild_id}/members/@me`
- `GET /api/v1/guilds/{guild_id}/roles`
- `POST /api/v1/guilds/{guild_id}/roles`
- `PATCH /api/v1/guilds/{guild_id}/roles/{role_id}`
- `DELETE /api/v1/guilds/{guild_id}/roles/{role_id}`
- `GET /api/v1/guilds/{guild_id}/bans`
- `PUT /api/v1/guilds/{guild_id}/bans/{user_id}`
- `DELETE /api/v1/guilds/{guild_id}/bans/{user_id}`
- `GET /api/v1/guilds/{guild_id}/invites`
- `GET /api/v1/guilds/{guild_id}/audit-logs`
- `GET /api/v1/guilds/{guild_id}/economy/me`
- `GET /api/v1/guilds/{guild_id}/economy/leaderboard`
- `GET /api/v1/guilds/{guild_id}/economy/level-roles`
- `PUT /api/v1/guilds/{guild_id}/economy/level-roles`
- `GET /api/v1/guilds/{guild_id}/emojis`
- `POST /api/v1/guilds/{guild_id}/emojis`
- `PATCH /api/v1/guilds/{guild_id}/emojis/{emoji_id}`
- `DELETE /api/v1/guilds/{guild_id}/emojis/{emoji_id}`
- `GET /api/v1/guilds/{guild_id}/emojis/{emoji_id}/image`
- `GET /api/v1/guilds/{guild_id}/stickers`
- `POST /api/v1/guilds/{guild_id}/stickers`
- `DELETE /api/v1/guilds/{guild_id}/stickers/{sticker_id}`
- `GET /api/v1/guilds/{guild_id}/stickers/{sticker_id}/image`
- `GET /api/v1/guilds/{guild_id}/events`
- `POST /api/v1/guilds/{guild_id}/events`
- `GET /api/v1/guilds/{guild_id}/events.ics`
- `GET /api/v1/guilds/{guild_id}/events/{event_id}`
- `PATCH /api/v1/guilds/{guild_id}/events/{event_id}`
- `DELETE /api/v1/guilds/{guild_id}/events/{event_id}`
- `GET /api/v1/guilds/{guild_id}/events/{event_id}/ical`
- `PUT /api/v1/guilds/{guild_id}/events/{event_id}/rsvp`
- `DELETE /api/v1/guilds/{guild_id}/events/{event_id}/rsvp`
- `GET /api/v1/guilds/{guild_id}/onboarding`
- `PATCH /api/v1/guilds/{guild_id}/onboarding`
- `GET /api/v1/guilds/{guild_id}/onboarding/me`
- `PUT /api/v1/guilds/{guild_id}/onboarding/me`
- `GET /api/v1/guilds/{guild_id}/storage`
- `PATCH /api/v1/guilds/{guild_id}/storage`
- `GET /api/v1/guilds/{guild_id}/files`
- `DELETE /api/v1/guilds/{guild_id}/files`
- `GET /api/v1/guilds/{guild_id}/vanity-url`
- `PATCH /api/v1/guilds/{guild_id}/vanity-url`
- `GET /api/v1/guilds/{guild_id}/reports`
- `POST /api/v1/guilds/{guild_id}/reports`
- `PATCH /api/v1/guilds/{guild_id}/reports/{report_id}`
- `GET /api/v1/guilds/{guild_id}/moderation/templates`
- `POST /api/v1/guilds/{guild_id}/moderation/templates`
- `DELETE /api/v1/guilds/{guild_id}/moderation/templates/{template_id}`
- `POST /api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply`

### Channels

- `GET /api/v1/channels/{channel_id}`
- `PATCH /api/v1/channels/{channel_id}`
- `DELETE /api/v1/channels/{channel_id}`
- `GET /api/v1/channels/{channel_id}/messages`
- `POST /api/v1/channels/{channel_id}/messages`
- `POST /api/v1/channels/{channel_id}/message-deliveries/{nonce}/resolve`
  - Authenticated, with channel visibility or DM membership. Sending permission is not required. No request body.
  - This operation permanently seals a missing delivery nonce against future creation; it is not a read-only lookup. The nonce must be nonempty, at most 64 bytes, and have no surrounding whitespace.
  - Response: `{ channel_id, author_id, nonce, state: "cancelled" }` if resolution wins before creation. A delayed POST with that nonce receives `410` with code `DELIVERY_CANCELLED`.
  - If creation committed first: `{ channel_id, author_id, nonce, state: "delivered", message_id }`. If that message has since been deleted, `state` is `"deleted"` and the same `message_id` remains. IDs are decimal strings.
  - Scope is the authenticated author plus channel and nonce. Repeated requests return the current durable outcome. Existing messages are never changed; ordinary message edit/delete authorization still applies.
  - Clients must retain uncertain prepared requests until the resolution and any affected encryption generation are reconciled atomically in local storage. A canceled initial X3DH request cannot simply be removed while later messages reuse its unestablished generation.
- `POST /api/v1/channels/{channel_id}/messages/bulk-delete`
- `GET /api/v1/channels/{channel_id}/messages/search`
- `GET /api/v1/channels/{channel_id}/summary`
- `POST /api/v1/channels/{channel_id}/messages/{message_id}/edits/{edit_nonce}/resolve`
  - Resolves the authenticated actor's edit nonce under current channel visibility. The response identifies `channel_id`, `actor_id`, `message_id`, `edit_nonce`, and `state` (`cancelled`, `applied`, or `deleted`).
  - An absent operation is atomically sealed as canceled. A delayed PATCH using that nonce cannot change the target; a live target returns `410 EDIT_CANCELLED`. A successful receipt stays applied, even if newer edits exist. If its target was deleted, resolution returns deleted. No content, history, or moderation verdict is changed by resolution.
  - Nonces are scoped to actor and channel, have the same 1-64-byte bounds as PATCH, and bind one target. A different target conflicts. Resolution remains available during a timeout, but loss of channel visibility denies access. Its actor-owned cancellation does not authorize a future edit.
  - Before replacing an uncertain PATCH, clients must persist the replacement intent and resolve the preceding edit. This seals a missing operation so that its delayed first attempt cannot overwrite the replacement. A storage or HTTP failure is not a cancellation acknowledgment.
- `PATCH /api/v1/channels/{channel_id}/messages/{message_id}`
  - Accepts `content`, optional `e2ee`, and optional `edit_nonce`. A replayable edit must provide a nonempty nonce of at most 64 bytes without surrounding whitespace, and retain its original request on retry.
  - Successful nonce-bearing responses include `edit_nonce` and boolean `edit_replayed`. Receipts are scoped to channel, authenticated actor and nonce, and bind the target message plus the complete content/encryption payload. Reusing one for a different mutation returns `409 CONFLICT`.
  - Matching retries return `200` with the current message and `edit_replayed: true`. That message may contain a subsequent edit; the earlier request is acknowledged without overwriting it, changing its edit timestamp, adding history, or repeating successful moderation effects/events.
  - New mutations require current edit authority. Replays require channel visibility or DM membership and the same actor's matching receipt, so a timeout does not prevent acknowledgment of an already committed edit. A deleted target returns `404`; receipts survive deletion and do not recreate the message.
  - Accepted edits commit the body/encryption metadata, preceding-content snapshot, moderation hits and receipt atomically. A persistence failure rolls them all back. Rejected operations are not recorded as successful edits.
  - AutoMod evaluation and hit-persistence failures now reject edits, sends and webhook execution instead of silently allowing unfiltered content. Moderator alerts, timeouts and gateway/federation fan-out retain their existing post-commit delivery behavior; this protocol does not add a durable event dispatcher.
- `DELETE /api/v1/channels/{channel_id}/messages/{message_id}`
- `GET /api/v1/channels/{channel_id}/features`
- `PATCH /api/v1/channels/{channel_id}/features`
- `GET /api/v1/channels/{channel_id}/scheduled-messages`
- `POST /api/v1/channels/{channel_id}/scheduled-messages`
- `DELETE /api/v1/channels/{channel_id}/scheduled-messages/{scheduled_message_id}`
- `GET /api/v1/channels/{channel_id}/anonymous/deanonymize/{message_id}`
- `GET /api/v1/channels/{channel_id}/e2ee/sender-keys`
- `POST /api/v1/channels/{channel_id}/e2ee/sender-keys`
- `POST /api/v1/channels/{channel_id}/e2ee/sender-keys/ack`
- `GET /api/v1/channels/{channel_id}/messages/{message_id}/edits`
- `POST /api/v1/channels/{channel_id}/polls`
- `GET /api/v1/channels/{channel_id}/polls/{poll_id}`
- `PUT /api/v1/channels/{channel_id}/polls/{poll_id}/votes/{option_id}`
- `DELETE /api/v1/channels/{channel_id}/polls/{poll_id}/votes/{option_id}`
- `GET /api/v1/channels/{channel_id}/pins`
- `PUT /api/v1/channels/{channel_id}/pins/{message_id}`
- `DELETE /api/v1/channels/{channel_id}/pins/{message_id}`
- `POST /api/v1/channels/{channel_id}/typing`
- `PUT /api/v1/channels/{channel_id}/read`
- `GET /api/v1/channels/{channel_id}/overwrites`
- `PUT /api/v1/channels/{channel_id}/overwrites/{target_id}`
- `DELETE /api/v1/channels/{channel_id}/overwrites/{target_id}`
- `PUT /api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me`
- `DELETE /api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me`
- `GET /api/v1/channels/{channel_id}/threads`
- `POST /api/v1/channels/{channel_id}/threads`
- `GET /api/v1/channels/{channel_id}/threads/archived`
- `PATCH /api/v1/channels/{channel_id}/threads/{thread_id}`
- `POST /api/v1/channels/{channel_id}/forum/posts`
- `GET /api/v1/channels/{channel_id}/forum/tags`
- `POST /api/v1/channels/{channel_id}/forum/tags`
- `DELETE /api/v1/channels/{channel_id}/forum/tags/{tag_id}`
- `PATCH /api/v1/channels/{channel_id}/forum/sort`
- `GET /api/v1/channels/{channel_id}/followers`
- `PUT /api/v1/channels/{channel_id}/followers/{target_channel_id}`
- `DELETE /api/v1/channels/{channel_id}/followers/{target_channel_id}`

### Invites

- `POST /api/v1/channels/{channel_id}/invites`
  - `max_uses`: `0` means unlimited; otherwise must be between `1` and `100`.
  - `max_age`: `0` means never expire; otherwise must be between `1` and `604800` seconds.
- `GET /api/v1/invites/{code}`
- `POST /api/v1/invites/{code}`
- `DELETE /api/v1/invites/{code}`

### Voice and Streaming

- `GET /api/v1/voice/{channel_id}/join`
- `POST /api/v1/voice/{channel_id}/leave`
- `POST /api/v1/voice/{channel_id}/stream`
- `POST /api/v1/voice/{channel_id}/stream/stop`
- `POST /api/v1/voice/livekit/webhook`
- `POST /api/v1/dms/{channel_id}/voice/join`
- `POST /api/v1/dms/{channel_id}/voice/leave`
- `GET /api/v1/voice/transport-diagnostics`
  - Side-effect free: reports the configured call transport, the media endpoint
    and (native path) the certificate pin a browser needs for
    `serverCertificateHashes`. It never creates voice state and never probes
    reachability.
- `GET /api/v1/voice/{channel_id}/media-stats`
  - Side-effect free, gated by the same `VIEW_CHANNEL` + `CONNECT` permissions a
    join is. Reports who currently holds a live media connection to the room and
    the cumulative datagram/byte counters of each, so a silent call can be told
    apart from an unjoined one. `transport` is `"quic"` (native desktop) or
    `"webtransport"` (browser); counters restart on reconnect and `session_id`
    identifies the call each row belongs to.

### Attachments

1. Upload through `POST /api/v1/channels/{channel_id}/attachments`.
2. Send message through `POST /api/v1/channels/{channel_id}/messages` with `attachment_ids`.
3. Download bytes through `GET /api/v1/attachments/{id}` (authorized and channel-scoped).

Pending uploads are stored with `message_id = NULL` until linked during message creation.

### Templates, Discovery, Bots, And Integrations

- `GET /api/v1/discovery/guilds`
- `GET /api/v1/guilds/{guild_id}/template`
- `GET /api/v1/templates`
- `GET /api/v1/templates/{template_id}`
- `POST /api/v1/templates/{template_id}/apply`
- `GET /api/v1/bots/applications`
- `POST /api/v1/bots/applications`
- `GET /api/v1/bots/applications/{bot_app_id}`
- `PATCH /api/v1/bots/applications/{bot_app_id}`
- `DELETE /api/v1/bots/applications/{bot_app_id}`
- `PATCH /api/v1/bots/applications/{bot_app_id}/public`
- `POST /api/v1/bots/applications/{bot_app_id}/token`
- `POST /api/v1/bots/applications/{bot_app_id}/installs`
- `GET /api/v1/bots/applications/{bot_app_id}/metrics`
- `GET /api/v1/bots/store`
- `GET /api/v1/bots/store/featured`
- `GET /api/v1/bots/store/categories`
- `GET /api/v1/bots/store/{bot_app_id}/reviews`
- `POST /api/v1/bots/store/{bot_app_id}/reviews`
- `DELETE /api/v1/bots/store/{bot_app_id}/reviews/@me`
- `GET /api/v1/applications/{app_id}/commands`
- `PUT /api/v1/applications/{app_id}/commands`
- `POST /api/v1/applications/{app_id}/commands`
- `PATCH /api/v1/applications/{app_id}/commands/{cmd_id}`
- `DELETE /api/v1/applications/{app_id}/commands/{cmd_id}`
- `GET /api/v1/applications/{app_id}/guilds/{guild_id}/commands`
- `PUT /api/v1/applications/{app_id}/guilds/{guild_id}/commands`
- `POST /api/v1/applications/{app_id}/guilds/{guild_id}/commands`
- `PATCH /api/v1/applications/{app_id}/guilds/{guild_id}/commands/{cmd_id}`
- `DELETE /api/v1/applications/{app_id}/guilds/{guild_id}/commands/{cmd_id}`
- `GET /api/v1/guilds/{guild_id}/commands`
- `POST /api/v1/interactions`
- `POST /api/v1/interactions/{interaction_id}/{token}/callback`
- `PATCH /api/v1/interactions/{app_id}/{token}/messages/@original`
- `DELETE /api/v1/interactions/{app_id}/{token}/messages/@original`
- `POST /api/v1/interactions/{app_id}/{token}/followup`
- `GET /api/v1/oauth2/authorize`
- `PUT /api/v1/bots/@me/presence`
- `GET /api/v1/tenor/search`
- `GET /api/v1/tenor/trending`

### Admin And Operations

- `GET /health`
- `GET /metrics`
- `GET /api/v1/admin/stats`
- `GET /api/v1/admin/security-events`
- `GET /api/v1/admin/settings`
- `PATCH /api/v1/admin/settings`
- `GET /api/v1/admin/users`
- `PATCH /api/v1/admin/users/{user_id}`
- `GET /api/v1/admin/guilds`
- `PATCH /api/v1/admin/guilds/{guild_id}`
- `POST /api/v1/admin/restart-update`
- `POST /api/v1/admin/backup`
- `GET /api/v1/admin/backups`
- `POST /api/v1/admin/restore` — returns `offline_restore_required` with CLI preparation instructions; does not replace live data
- `GET /api/v1/admin/backups/{name}`
- `DELETE /api/v1/admin/backups/{name}`

## Invite Accept Contract

`POST /api/v1/invites/{code}` returns `{ "guild": {…} }` — the guild card nested
under `guild`, including:

- `default_channel_id`: first usable channel for post-join navigation.

## Gateway Contracts

### Opcodes (client -> server)

- `1`: HEARTBEAT
- `2`: IDENTIFY
- `3`: PRESENCE_UPDATE
- `4`: VOICE_STATE_UPDATE
- `6`: RESUME
- `9`: TYPING_START
- `18`: VOICE_SPEAKING (see Voice speaking signal)

### Opcodes (server -> client)

- `0`: DISPATCH
- `7`: RECONNECT
- `9`: INVALID_SESSION
- `10`: HELLO
- `11`: HEARTBEAT_ACK

### Core Dispatch Events

- `READY`
- `RESUMED`
- `GUILD_CREATE` / `GUILD_UPDATE` / `GUILD_DELETE`
- `CHANNEL_CREATE` / `CHANNEL_UPDATE` / `CHANNEL_DELETE`
- `GUILD_MEMBER_ADD` / `GUILD_MEMBER_UPDATE` / `GUILD_MEMBER_REMOVE`
- `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`
- `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE`
- `CHANNEL_PINS_UPDATE`
- `PRESENCE_UPDATE`
- `TYPING_START`
- `VOICE_STATE_UPDATE`
- `GUILD_ROLE_CREATE` / `GUILD_ROLE_UPDATE` / `GUILD_ROLE_DELETE`
- `GUILD_BAN_ADD` / `GUILD_BAN_REMOVE`
- `INVITE_CREATE` / `INVITE_DELETE`
- `VOICE_SPEAKING`

### Voice speaking signal

Speaking is detected on each client by its own media engine, so the people in a
call see who is talking and nobody else does. To let the server home's Live now
card and the sidebar's voice rows show it too, a client in a server voice channel
reports its own speaking edges and the server relays them.

- Report (the sender's own edge only): WebSocket op `18`
  `{"channel_id": "…", "speaking": true|false}`, or the command bus
  `POST /api/v2/rt/commands` with `type: "voice_speaking"` and the same payload.
  Clients send "started" after ~300 ms of speech, "stopped" after ~800 ms of
  silence or at once on mute, leave or disconnect, at most one edge per 500 ms,
  and re-send "started" every 10 s while still talking.
- A "started" is accepted only from a user whose voice state is in that channel
  and who is not self-muted, deafened, server-muted or suppressed on a stage; on
  the command bus anyone else gets `403`. A "stopped" is always accepted (it can
  only clear the sender's own flag). Edges over the per-user budget (a burst of
  three, then one per 400 ms) are dropped quietly; the gateway never answers op 18.
- The server keeps current speakers in memory and clears one when they leave or
  move, mute, or send no refresh for 20 s.
- `VOICE_SPEAKING` `{guild_id, channel_id, user_id, speaking}` is dispatched to
  guild members who can view that channel (the same VIEW_CHANNEL gate as
  `VOICE_STATE_UPDATE`). READY's `voice_states` carry `speaking: true|false` so a
  fresh page shows a current speaker.

Privacy: this reveals only "is talking now", and only to people who can already
see who is in that voice channel. No audio, level or timing beyond the edges
leaves the call, and nothing is stored.


## Conversation action discovery

`GET /api/v1/channels/{channel_id}/capabilities` requires authentication and
channel visibility. Version 1 returns `channel_id` and the authenticated
`user_id` as strings, `encrypted`, `own_identity_enrolled`, `peers_ready`, and
an `actions` object with these keys: `send`, `poll`, `schedule`, `attach`,
`summary`, `voice`, `video`, and `screen_share`.

Each action contains `supported`, `allowed`, and `reason`. An allowed action
must be supported and have a null reason. A denied action has a nonempty
explanation. `supported: false` represents a channel type or server configuration
that cannot provide the feature; `supported: true, allowed: false` represents
current permissions or moderation restrictions. Encrypted DMs do not support
server-readable polls or summaries. Summary availability validates provider
configuration without contacting that provider or returning credentials.

These decisions are advisory snapshots. Endpoints still enforce their own
permissions when called. Clients must verify the returned channel and account,
discard responses after account revocation, and refresh after permission or
relationship changes. The client also applies local encryption, device, and
feature availability. Server permission alone does not mean that a particular
client can produce a valid encrypted attachment or scheduled message.

Encryption readiness reports server-side enrollment and peer key inventory;
it does not prove possession of the local private key, cryptographic validity
of a peer bundle, or readiness of an existing local ratchet. The sending
implementation must verify those independently. Capability discovery does not
consume peer one-time prekeys.

### Message attention targets

`GET /api/v1/channels/{channel_id}/messages/attention?kind=mention|unread&after={message_id}`
requires channel visibility and message-history permission. The optional `after`
is a decimal snowflake (zero is allowed); the effective lower bound is the larger
of that device cursor and the server's stored read cursor. The request never
acknowledges or marks messages read. It returns the earliest matching unread
message, using the same message serializer as history:

```json
{"channel_id":"200","user_id":"42","kind":"mention","message":null}
```

`message` is a normal message object when a target exists, otherwise `null`.
The client validates the response's account, channel, kind, and target cursor
before presenting it or appending `?message=` to an owned conversation route.
Thread rows use the first unread message in that thread; mention rows use the
first message recorded as notifying the authenticated recipient. They do not
substitute the most recent unrelated message when no target exists.

Mention recipients commit with the message and delivery receipt. Direct mentions,
permitted mentionable roles, and authorized mass mentions are deduplicated; the
author and people unable to view the channel are excluded. Editing the text or
changing a role later does not rewrite the original notification audience.
Deleting the message cascades its mention records. New unread counts derive from
records above the read cursor, so replay and stale/partial acknowledgments do not
inflate counts or clear newer mentions.

After a new message commits, `MESSAGE_MENTION` is dispatched only to its recorded
recipients, with `channel_id` and `message_id` strings. It contains no text or
recipient roster. Clients coalesce these events into an account-owned read-state
refresh, performing a subsequent refresh when an event arrives during an older
snapshot. Replayed events never increment a client-side guessed count.

Before this migration, read state stored only an aggregate mention count. Those
legacy counts are retained until acknowledged; their originating message IDs
cannot be reconstructed reliably, especially for historical role or mass mentions.
They are not invented during migration. A legacy-only mention row explicitly
reports that no unread mention target is available and leaves the conversation
accessible. New mention records supply exact targets and counts immediately.

Webhook and interaction messages use the same committed audience rules. Scheduled
messages use a stable delivery identity so replay cannot notify recipients twice.
Crossposts retain only source recipients who can view the destination; copied text
does not acquire a new audience. Quarantine approval uses the audience captured at
quarantine, with no invented pings for older records. Built-in bot/moderation log
messages use explicitly intended recipients. Federation reads structured
`m.mentions` identities and resolves local or mapped accounts rather than treating
arbitrary remote numeric IDs as local users. The shared publisher sends targeted
`MESSAGE_MENTION` events after `MESSAGE_CREATE` for these producers too.

## Ordered channel message activity

Channel list/detail/DM responses include `message_revision` as a canonical decimal
string. Migration 20260909000010 initializes existing channels at zero. A committed
message creation advances the revision in the same transaction as the channel tail;
deletions advance it with tail repair. Replays, denied deletion and missing-message
deletion do not advance it. Values are bounded by signed 64-bit integers; exhausting
the revision rejects and rolls back the mutation rather than storing an imprecise value.

`MESSAGE_CREATE`, `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK` carry:

```json
{
  "channel_activity": {
    "channel_id": "123",
    "guild_id": "456",
    "last_message_id": null,
    "revision": "42"
  }
}
```

`guild_id` is null for direct/group direct conversations. `last_message_id` is the
highest surviving message ID or null for an empty channel. The activity snapshot is
read after commit and may include subsequent mutations; it must not be inferred from
the message body's ID or event publication order. The shared event publisher retains
the producer's original guild/user audience and never emits guessed activity if its
snapshot query fails. Such failures are logged; durable publication recovery remains
part of the realtime lifecycle work.

Clients key activity by authenticated server/account/channel, compare revisions as
integers without floating-point conversion, and retain the greatest known revision
across events, in-flight collection journals and full snapshots. Equal revisions do
not replace an established tail with conflicting content. Ordinary channel metadata
updates preserve known activity. Malformed, out-of-range or mismatched activity
envelopes cannot mutate it. Revision ordering applies within one database history,
identified by the epoch below. Activity received before channel metadata is bounded
per account and retained across older snapshots; an authoritative visibility list
prunes older activity for channels outside that list. Overflow cancels the owning
snapshot and requires a fresh load.

## Database history identity

`server_settings.database_history_epoch` is a canonical UUIDv4 shared by instances
using the same database. Ordinary migrations and server restarts preserve it.
SQLite-to-PostgreSQL import and isolated archive recovery rotate it after repairing
derived channel tails. Operators must stop every instance using the old database
before activating a recovery generation; see [Backup recovery](backup-recovery.md).

Authenticated WebSocket and SSE `READY`/`RESUMED` frames and
`POST /api/v2/rt/session` publish `database_history_epoch`. HTTP responses publish
`X-Paracord-History-Epoch`; CORS permits and exposes that header. A request carrying
a different epoch receives HTTP 409 with code `HISTORY_CHANGED` before handler
execution. Invalid or duplicate epoch headers receive 400. Omission is supported
for bootstrap and legacy clients; it provides no protection against stale requests.

The client accepts an epoch only from its currently owned, authenticated gateway
handshake. It persists this public metadata by server/account. A changed handshake
expires captured operations before clearing that account's channel, guild, member,
message, read-state and permission projections. Other accounts remain intact and
lower channel revisions can then populate the replacement history. Same-epoch
resumes retain caches. A changed `RESUMED` requires a fresh `READY` before replay.

Realtime replay counters are process-local and may restart independently of the
database epoch. SSE treats a cursor beyond its current head as a full resync,
advertising the current head in READY before accepting subsequent live events.
Otherwise an old counter could suppress updates after a restart or restore.
WebSocket RESUMED advertises the client's completed sequence, then emits the
missed dispatches in order; it does not acknowledge the server's replay head in
advance. A WebSocket resume beyond the cached head requires fresh identification.

Captured HTTP operations pin their accepted epoch, including token refresh, and
validate response ownership before changing state or credentials. An unexpected
response epoch requests a fresh handshake; it never authorizes automatic adoption
or resending into the replacement history. Corrupt local metadata prevents owned
requests until a valid handshake repairs it. Migration of remaining unowned API
workflows and persisted legacy queues is still in progress; this protocol does not
make legacy queues safe to resend after restore.

## Durable message deletion

`DELETE /api/v1/channels/{channel_id}/messages/{message_id}` accepts an optional
JSON body containing only `delete_nonce`, a canonical nonnil UUID. An empty body
retains the legacy 204 response. Every nonempty body is validated, including when
Content-Type is omitted; malformed bodies cannot become legacy deletions.

A durable deletion returns 200:

```json
{"channel_id":"200","message_id":"300","actor_id":"42","delete_nonce":"7257b8f7-610e-4a8b-a20c-5a94a7b98428","state":"deleted","delete_replayed":false}
```

Deletion, audience cleanup, channel-tail repair/revision advancement and the owned
receipt commit together. Retrying the same actor/channel/nonce/message returns the
receipt with `delete_replayed:true`, without duplicate events. Retargeting that
nonce to another message is a conflict. Current visibility is required even to read
a receipt; new deletions additionally require authorship or management permission.
The receipt survives deletion of the target message.

`POST /api/v1/channels/{channel_id}/messages/{message_id}/deletions/{delete_nonce}/resolve`
returns the same identities with `state:"deleted"` when a receipt exists, or
`state:"pending"` when the authorized target still exists. Resolution does not
reserve, cancel or delete anything. A missing target without a matching receipt is
404 and cannot prove that this particular deletion committed.
