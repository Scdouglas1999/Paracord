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
- `PUT /api/v1/users/@me/keys`
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
- `POST /api/v1/channels/{channel_id}/messages/bulk-delete`
- `GET /api/v1/channels/{channel_id}/messages/search`
- `GET /api/v1/channels/{channel_id}/summary`
- `PATCH /api/v1/channels/{channel_id}/messages/{message_id}`
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
- `POST /api/v1/admin/restore`
- `GET /api/v1/admin/backups/{name}`
- `DELETE /api/v1/admin/backups/{name}`

## Invite Accept Contract

`POST /api/v1/invites/{code}` returns a guild object directly (not nested), plus:

- `default_channel_id`: first usable channel for post-join navigation.

## Gateway Contracts

### Opcodes (client -> server)

- `1`: HEARTBEAT
- `2`: IDENTIFY
- `3`: PRESENCE_UPDATE
- `4`: VOICE_STATE_UPDATE
- `6`: RESUME
- `9`: TYPING_START

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
