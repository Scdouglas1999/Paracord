## What's New in v0.9.0

> Version framing: `v0.9.0` is the release-candidate line. The overhaul on
> `overhaul/v1.0-shippable` targets **v1.0.0** as the first public tag; the
> version metadata across Cargo, npm, and Tauri is only bumped at tag time.

### Round 2 Overhaul

A second overhaul pass closed the remaining desktop-media gaps, added an
operational database-migration path, and tightened cross-platform build
hygiene. Highlights:

- **Scheduled-message editing**: A scheduled message's content and delivery time can now be edited before it fires, not only created and deleted.
- **Native output-device switching**: The Tauri audio pipeline can now switch the speaker/output device at runtime (previously input-only; the output path returned an error).
- **Native video decode on receive**: Incoming VP9 frames are now routed to per-SSRC decoders and rendered on the desktop client, completing the native receive path (frames were previously decrypted but dropped).
- **Media subscription negotiation**: The native transport now honors subscribe/unsubscribe control messages so a client only receives the tracks it asks for (the subscribe control message was previously a no-op).
- **SQLite → PostgreSQL migrator**: A new `paracord-server migrate-to-postgres` subcommand copies an existing SQLite database into a freshly migrated PostgreSQL database inside a single all-or-nothing transaction, verifying every table's row count against the source. See [docs/sqlite-to-postgres-migration.md](docs/sqlite-to-postgres-migration.md).
- **Cross-platform build hygiene**: The Windows-only libvpx (`VPX_*`) environment is no longer hard-coded into a global `.cargo/config.toml` (which leaked onto Linux/macOS builds); Windows developers now source `scripts/set-vpx-env.ps1`, while Linux/macOS discover libvpx through `pkg-config`. CI additionally lints the desktop crate (`cargo clippy -p paracord-desktop --all-targets`) and exercises the PostgreSQL migrator end-to-end against a live PostgreSQL service.

### Release Candidate Overhaul

Ahead of the public release candidate, the whole codebase went through a correctness, consistency, and test-hardening pass. No new runtime dependencies were added; the changes are refactors, real fixes, and coverage. Highlights:

- **Honest SSE resume/replay**: The realtime `GET /api/v2/rt/events` endpoint now replays events emitted during a reconnect gap from the advertised cursor, in order. This replaces the previous cosmetic `"cursor": 0` behavior that silently dropped events that occurred while a client was disconnected. Covered end-to-end by a new integration test that reconnects across an event gap and asserts the missed events are actually delivered.
- **Host-header injection fix for account emails**: Verification and password-reset links are now built only from a configured `public_url` or headers presented via a trusted proxy — never from a client-supplied `Host`/`X-Forwarded-Host` on an untrusted request. A poisoned `Host` header can no longer redirect a bearer/reset-token link to an attacker's origin. When no trusted origin is available the clickable link is omitted and the raw token is still included so the user can complete the reset manually.
- **Gateway client consolidation**: Four overlapping legacy gateway modules (`client.ts`, `protocol.ts`, `queue.ts`, `transport.ts`) were removed in favor of a single `dispatch` + `manager` + `events` + `types` layout, now backed by real unit tests for event dispatch. Dead client utilities (`lib/avatars.ts`, `lib/fetchWithTimeout.ts`) were deleted.
- **Centralized REST client resolution**: A single `getApi()` helper resolves the correct per-server axios instance at request time (falling back to the local-only client during login/registration bootstrap), and the API modules were updated to route through it instead of capturing a client at module load. This removes a class of "requests went to the wrong server after switching" bugs.
- **Snowflake generator hardening**: The ID generator now carries a monotonic guard so a backwards clock step cannot regress timestamps or mint duplicate IDs, yields instead of spinning while waiting for the clock to advance, saturates rather than panicking on clock errors, and takes an injectable clock so the skew/sequence-exhaustion paths are unit-tested.
- **Media E2EE crypto correctness**: The codec AES-GCM layer's nonce construction is now documented and guarded with a per-`(ssrc, epoch)` rollover counter, making every frame nonce unique within an epoch and tying epoch rotation to membership changes, with tests that exercise sequence-number wrap boundaries.
- **Per-user reactions index**: A new `idx_reactions_user` index (added to both the SQLite and PostgreSQL migration tracks) prevents per-user reaction cleanup and `ON DELETE CASCADE` from `users` from sequentially scanning the reactions table.
- **Internal refactors with coverage**: The permissions engine, the roles database layer, and the media storage backend were substantially cleaned up, and new Rust integration suites were added for role/member authorization, account/bot authorization, and channel message routes. Client-side additions include unit and accessibility tests for auth bootstrap, the message list, permission hooks, voice keybinds, sender-key exchange, typing state, and the active-client resolver.
- **Docker onboarding**: A blank `.env.example` (with fail-fast, non-empty secret requirements) and a CI audit-exception checker (`scripts/check_audit_exceptions.py`) were added.

### Native QUIC Media Engine

A custom media transport layer built on QUIC (via `quinn`) has been added alongside the existing LiveKit integration. LiveKit code is untouched and remains fully functional.

**Server-side architecture:**

When `native_media = true`, the server starts one unified UDP media endpoint:
- Raw QUIC clients authenticate via JWT in a control stream
- WebTransport/HTTP3 clients authenticate via a JSON auth message on the first bidi stream

Both endpoints feed into a shared relay that routes encrypted datagrams between participants in the same room. The relay includes room management, participant tracking, and voice activity (speaker) detection.

**New server crates:**
- `paracord-transport` -- QUIC endpoint, WebTransport server, datagram bridge, file transfer protocol
- `paracord-relay` -- Media room management, relay forwarder, participant tracking, speaker detection
- `paracord-codec` -- Opus audio encoding/decoding, VP9 video encoding/decoding (behind `vpx` feature), RNNoise noise suppression, jitter buffering, audio capture/playback via cpal
- `paracord-media-dev` -- Development utility for testing the media server independently

**New client media library** (`client/src/lib/media/`):
- Abstract `MediaEngine` interface with two implementations:
  - `BrowserMediaEngine` -- Full WebTransport + WebCodecs implementation (~1000 lines). Handles audio capture/playback, Opus encode/decode, VP9 video, E2EE encryption, jitter buffering, and canvas rendering entirely in the browser.
  - `TauriMediaEngine` -- Thin IPC wrapper that delegates to the native Rust audio pipeline in the Tauri binary.
- Transport layer: WebTransport client, datagram bridge with QSID framing, file transfer protocol
- E2EE sender key exchange with epoch rotation

**Desktop native audio pipeline (Tauri):**

The Tauri binary includes a fully functional native audio pipeline:
- Microphone capture via cpal -> RNNoise noise suppression -> Opus encoding -> AES-GCM encryption -> QUIC datagram transmission
- Receive path: QUIC datagram -> AES-GCM decryption -> Opus decoding -> jitter buffer -> cpal speaker output with multi-source mixing
- Mute/deaf toggling via atomic flags, input device switching at runtime
- E2EE sender key announcement over QUIC control stream
- VP9 video encoding/decoding available when built with the `vpx` feature flag

**What is not yet complete on the desktop path:**
- Output device switching (returns an error; input device switching works)
- Video subscription negotiation (subscribe control message is a no-op)
- Video decode on receive (frames are decrypted but not yet routed to per-SSRC decoders)

**Server configuration:**
```toml
[voice]
native_media = true    # Enable native QUIC media server (default: false)
port = 8443            # Unified UDP port for raw QUIC and WebTransport/HTTP3
max_participants_per_room = 50
audio_bitrate = 96000
e2ee_required = true
```

The voice join endpoint returns native media connection details when `native_media` is enabled:
```json
{
  "native_media": true,
  "media_endpoint": "https://host:8443/media",
  "media_token": "<jwt>",
  "cert_hash": "<sha256>",
  "room_name": "guild_id:channel_id",
  "session_id": "<uuid>"
}
```
The `cert_hash` field provides the SHA-256 fingerprint of the server's self-signed TLS certificate for WebTransport certificate pinning. When LiveKit is also available, its fields are returned alongside (purely additive). Clients can request explicit LiveKit fallback via `?fallback=livekit`.

### Guild File Storage Management

Server administrators and guild owners can now manage file storage policies per guild.

**New API endpoints:**
- `GET /api/v1/guilds/{id}/storage` -- View storage usage and policy
- `PATCH /api/v1/guilds/{id}/storage` -- Update storage policy (quotas, retention period, MIME type restrictions)
- `GET /api/v1/guilds/{id}/files` -- List attachments with pagination
- `DELETE /api/v1/guilds/{id}/files` -- Bulk delete attachments (up to 100)

**New admin settings:**
- `max_guild_storage_quota` -- Server-wide limit on per-guild storage
- `federation_file_cache_enabled`, `federation_file_cache_max_size`, `federation_file_cache_ttl_hours` -- Control federated file caching behavior

**Database migrations** add `guild_storage_policies` table, `content_hash` column on attachments (SHA-256), and `federation_file_cache` table. Uploads are now validated against guild policies (max file size, allowed/blocked MIME types, storage quota) before being stored, using the active-content-downgraded MIME type so forged `Content-Type` values cannot bypass allowlists.

### Federation File Sharing

Files can now be accessed across federated servers. When a user views a message from a remote server that includes attachments, the local server proxies the file download with token-based authentication and optional local caching.

**New federation endpoints:**
- `POST /_paracord/federation/v1/file/token` -- Request a download token for a remote file
- `GET /_paracord/federation/v1/file/{attachment_id}?token=...` -- Download a federated file

**New client endpoint:**
- `GET /api/v1/federated-files/{origin_server}/{attachment_id}` -- Proxy endpoint for clients to download federated files through their local server

### Gateway Media Signaling

Six new WebSocket opcodes support native media session negotiation:

| Opcode | Name | Direction | Purpose |
|--------|------|-----------|---------|
| 12 | `MEDIA_CONNECT` | Client -> Server | Initiate media session |
| 15 | `MEDIA_SESSION_DESC` | Server -> Client | Relay endpoint and peer list |
| 14 | `MEDIA_KEY_ANNOUNCE` | Client -> Server | Announce E2EE sender keys |
| 16 | `MEDIA_KEY_DELIVER` | Server -> Client | Deliver sender keys to peers |
| 13 | `MEDIA_SUBSCRIBE` | Client -> Server | Subscribe to peer media tracks |
| 17 | `MEDIA_SPEAKER_UPDATE` | Server -> Client | Broadcast active speaker changes |

### Desktop App (Tauri) Improvements

- **Native audio pipeline**: Full mic capture -> Opus encode -> E2EE -> QUIC send pipeline, plus the reverse receive path with jitter buffering and speaker mixing
- **Screen capture infobar suppressed**: The Chromium "is sharing a window" bar is now auto-hidden using the WebView2 `ICoreWebView2_27` ScreenCaptureStarting API
- **Production-ready packaging**: Dev console no longer opens on launch; `console.log`/`console.info` calls are stripped from production builds
- **Diagnostics logging**: Voice session events are logged to `%LOCALAPPDATA%/Paracord/logs/client-voice.log` for troubleshooting
- **QUIC file transfer**: Upload and download files over QUIC datagrams via Tauri IPC commands
- **Windows installers**: Inno Setup `.exe` installer in release artifacts, plus Tauri `.msi` bundles

### Stream Viewer Fixes

- **LIVE badge in sidebar**: Starting a stream now immediately shows the LIVE indicator next to your name in the voice channel participant list (previously required waiting for a gateway event)
- **Stream stop reliability**: Stopping a stream no longer hangs for 15 seconds; re-entrancy guard prevents duplicate stop calls
- **Auto-watch on stream start**: Starting a stream automatically sets you as the watched streamer so the StreamViewer renders immediately
- **Voice channel navigation**: Clicking a voice channel you're already in navigates back to it instead of disconnecting

### Client UI and Accessibility

- **Create server flow**: The create-server modal now covers create, join-by-invite, and template-based creation flows with template preview details, announced API-detail loading/error feedback, accessible template selection, first-channel selection, and post-create navigation.
- **Channel management feedback**: Server channel/category and permission-overwrite admin actions now preserve concrete API error details, announce inline failures, and report announcement-channel follow/unfollow failures instead of dropping rejected requests.
- **Developer command builder feedback**: Bot command create/update failures now show concrete API validation details, and nested option controls expose explicit accessible names.
- **Bot authorization feedback**: Bot OAuth authorization pages now announce load, authorize, and review submission failures with concrete API error details instead of generic or inconsistent messages.
- **Composer attachment flow**: Message composer uploads now preserve selected-file previews, allow removing staged files through named controls, upload attachments before sending, and send attachment IDs with the message payload.
- **Scheduled-message composer**: When scheduling is enabled, the composer primary action now exposes schedule-specific labels/icons, validates that the send time is in the future before calling the API, disables while the schedule request is in flight, and keeps content/date visible if the server rejects the schedule.
- **Composer media feedback**: Sticker and GIF quick-send failures now show announced inline API error details instead of generic composer errors.
- **Invite link flow**: Invite pages now have coverage for preview failure feedback, unauthenticated login routing, verification acknowledgement/answers, and post-accept guild/channel navigation.
- **Invite modal**: Failed invite generation now shows an inline error and keeps copy controls disabled instead of placing error text into the copyable invite-link field.
- **Shared upload controls**: Standalone upload surfaces are keyboard-reachable, expose named upload/remove actions, and forward file selection through the hidden input without relying on pointer-only interaction.
- **Moderation template actions**: Guild settings now allow applying a saved moderation template to a target user with optional reason and DM overrides, including disabled-submit and result feedback states.
- **Account recovery and unlock flows**: Local identity setup now trims account names, keeps the recovery phrase review step acknowledgement-gated, the recovery form trims recovered usernames and validates exact 24-word phrases before restoring and navigating to the app, and locked-account unlock keeps recovery/import links, announced error feedback, cooldown feedback, and stored-server reconnect behavior covered.
- **Registration flow**: Account creation now requires password confirmation, trims account text fields before submission, preserves connected-server registration behavior, and still attaches an unlocked local public key after signup.
- **Home dashboard**: Opening an online friend from the dashboard now shows a clear error if the DM cannot be created instead of silently doing nothing.
- **User profile actions**: Profile-popup DM, friend-request, block, and report failures now show announced API-detail feedback instead of generic action errors.
- **Friends list**: Friend search now has an explicit accessible label, DM-open failures show inline feedback, and add-friend submission is trimmed and guarded against duplicate sends while the request is pending.
- **Channel and server actions**: Inline guild-channel creation now has labeled controls, updates the visible channel list from the channel store on success, and shows an error toast instead of silently ignoring create failures. Clipboard-backed copy actions now use a shared checked helper, so server/channel/member copy-ID, username, message, code, invite, webhook, bot-token, and verification-payload copies show user-visible failures instead of silently failing; leave-server failures in server menus show the API error instead of closing with no feedback.
- **Message search**: Search and author-filter controls now have explicit labels, close actions have stable accessible names, the global overlay announces in-progress searches, and search failures are announced instead of appearing as unstructured text.
- **Channel summaries**: Summary failures now show an announced inline error with the API error detail instead of a generic unannounced message.
- **Pinned messages**: Failed pin loads now show an inline error instead of looking like an empty channel, and failed unpin requests keep the pinned message visible with a specific retryable error.
- **Inbox**: Failed unread-state loads now stay in the inbox dialog as an inline error instead of showing the misleading caught-up state.
- **Announcement channel follows**: Follow and unfollow failures in the top-bar channel-follow manager now stay in the dialog as inline alerts instead of disappearing after the button returns to idle.
- **Direct-message calls**: Failed DM voice-call joins now show a user-visible error toast instead of only writing diagnostics.
- **Diagnostics privacy**: Desktop diagnostic logs and API timing/error request labels now redact sensitive keys, bearer/JWT-like tokens, webhook/interaction token path segments, and token-bearing query parameters before writing client-side troubleshooting data.
- **LiveKit proxy log privacy**: Token-validation failures no longer include token length, secret length, or API-key length metadata in server logs.
- **LiveKit proxy URL redaction**: Request URI query values, backend target query strings, and embedded backend target URLs in HTTP forwarding errors are covered by unit tests so access tokens are not exposed in proxy log labels.
- **LiveKit HTTP proxy hardening**: The LiveKit validation proxy now uses an explicit 10-second HTTP timeout, disables automatic redirects, caps inbound proxy request bodies at 10 MiB, and enforces a 1 MiB upstream response cap while reading the response stream.
- **LiveKit admin client hardening**: LiveKit admin API calls now use the workspace rustls-backed HTTP client, disable automatic redirects, cap streamed upstream response bodies that Paracord reads at 64 KiB, and surface client-construction failures instead of falling back to default network behavior.
- **Admin backup safety**: Backup download, delete, and restore routes now reject path-traversal and header-unsafe filenames before touching disk or building response headers.
- **Message components**: Bot message buttons and select menus now show user-visible failure feedback, entity selects show an inline alert if user/role/channel options cannot load, unsafe link-button URLs are rejected by the API and blocked in the client before opening a browser window, and bot interaction/followup components persist through message history reloads.
- **External URL and image safety**: Bot link buttons, bot OAuth redirects, message embeds and embed images, GIF selections, GitHub webhook cards, updater release-note links, ErrorBoundary bug-report links, file previews/downloads, image lightbox resources, pinned-message avatars, sticker images, custom emoji images, message sticker/attachment images, screen-share thumbnails, profile linked accounts, and Markdown autolinks now use shared URL gates; server-controlled resource URLs no longer accept `blob:` strings; selected-file previews and inline attachment previews use the shared safe raster-image MIME allowlist instead of broad `image/*`; profile linked accounts are filtered on the server before being returned and again in the client before rendering; custom emoji/sticker image asset routes support scoped query-token image loading and return `nosniff`.
- **Forum view**: Forum search, sorting, tag, and post-creation failures now preserve concrete API error details in user-visible feedback.
- **Sticker picker feedback**: Sticker load failures now show retryable inline API error details instead of a generic static message.
- **Message history actions**: Reaction, pin/unpin, and thread restore/delete failures now show explicit API-detail feedback instead of being swallowed or reduced to generic toasts.
- **Scheduled events UI**: Event list load failures now show retryable inline API error details instead of the empty-events state, RSVP/status failures preserve concrete toast details, and calendar export/per-event iCal links encode dynamic path segments before opening same-origin download URLs.
- **Stored image data URL safety**: Guild hub banners, server hub banner uploads/previews, guild settings icon saves, sidebar/home/discovery/welcome guild icons, user profile banners, bot-store icons, pinned-message author avatars, and bot entity-select avatars now render only safe raster data URLs and fall back instead of requesting unresolved legacy image endpoints or external avatar URLs.
- **Guild webhook settings**: Webhook URL copy, refresh, and test-execute failures now preserve concrete clipboard/API error details in the settings error banner.
- **Developer bot portal**: Bot developer pages now have labeled create-app controls with trimmed submission, API error details for app actions, named command delete actions, install counts, active guild counts, ratings/reviews, event buckets, refresh behavior, token-copy failure feedback, and fallback messaging when metrics fail to load.
- **Developer token copy**: Bot token copy failures now preserve the concrete clipboard error detail in the visible developer-page error banner.
- **Bot store settings**: Public bot-store load failures now show retryable inline API details, and bot add/install/remove/save failures preserve concrete API details in user-visible toasts.
- **User settings feedback**: Profile saves, app settings saves, device crypto security toggles, and MFA status/setup/verify/disable failures now preserve concrete API details in announced user-visible feedback instead of falling back to generic messages.
- **Template Gallery**: Template create/apply/delete failures now show concrete API error details, and deleting the selected template keeps the detail pane on a valid remaining template instead of falling into an unselected state.
- **Accessibility hardening**: Static and unit coverage now guard icon-only accessible names, tooltip-backed controls, modal dialog roles/names, app confirmation dialogs instead of native browser prompts, focus traps, Escape close, focus restore, and several empty/loading/error states across core client flows.
- Public discovery now shows retryable inline load errors with concrete API details instead of presenting network failures as an empty server directory, and its icon-only back action has an explicit accessible name.
- Public discovery joins now work for authenticated non-members: private guild invite lists remain manager-only, public guilds can expose usable invite codes to the discovery join flow, and failed invite lookup/accept requests preserve concrete error details in toast feedback.
- Invite creation now rejects negative or out-of-range `max_uses`/`max_age` values, and the invite modal sends explicit `0` values for "No limit" and "Never" so unlimited invites are not accidentally created with the default 24-hour expiry.

### Release Hardening Fixes

- Exhausted invites are now hidden from preview/list endpoints and rejected consistently after their max-use limit is reached.
- Browser session restore now works after a hard reload or direct authenticated route entry such as `/app/templates`; the CSRF cookie is readable from app routes so refresh requests can include `X-Paracord-CSRF` instead of bouncing the user back to login.
- Non-full-mesh federation relay now keeps forwarding room events to peers that have accepted prior room membership events, so A-to-B-to-C topologies continue receiving message/edit/delete/reaction traffic after member joins.
- SQLite poll responses now decode `voted` flags correctly through SQLx `Any`, fixing poll detail/vote endpoints on SQLite-backed servers.
- SQLite custom emoji create/list/update responses now decode static/animated flags correctly, fixing PNG/GIF emoji upload responses on SQLite-backed servers.
- SQLite voice-state queries now decode mute/deaf/stream/video/suppress flags correctly through SQLx `Any`, fixing native-media active voice-state resolution on SQLite-backed servers.
- New guilds are private by default for public discovery. Server owners with `MANAGE_GUILD` can explicitly publish/unpublish a guild and manage normalized discovery tags.
- Guild template application now validates stored role/channel data before creating a guild, rejecting malformed JSON, unsafe role/channel names, invalid role permissions, and invalid channel types without leaving partial guilds behind.
- Guild templates created from Paracord forum channels now apply correctly by accepting Paracord's `Forum = 7` channel type instead of the stale Discord-style forum type `15`.
- The server crate now forwards the optional `s3` feature to `paracord-media`, so documented S3-compatible storage builds work through `paracord-server`.
- S3-compatible storage now requires explicit `access_key_id`/`secret_access_key` by default. AWS SDK env/profile/SSO/instance-role credential discovery is available only when the admin explicitly sets `use_aws_credential_chain = true`.
- Local filesystem upload storage remains the default, and S3-related environment variables do not switch the backend to S3 unless `storage_type = "s3"` / `PARACORD_STORAGE_TYPE=s3` is explicitly configured.
- OpenGraph link previews now block additional reserved/documentation/multicast IP ranges plus metadata/local-domain aliases before fetching user-posted URLs, and response reads stop at the configured parse cap instead of buffering the full body first.
- Federation RPC, federated discovery, and moderation-list sync fetches now disable automatic HTTP redirects, preventing a validated public URL from redirecting to private/internal infrastructure without a fresh validation step. Federated discovery also caps streamed peer JSON responses at 512 KiB.
- Federated file downloads now follow redirects manually so every redirect target receives DNS/private-network validation before the next request is sent.
- Fixed vendor calls for Tenor GIF search/trending and startup public-IP detection now use explicit short HTTP client timeouts instead of relying on default network behavior. Tenor requests also disable automatic redirects, cap streamed provider JSON responses at 1 MiB, and avoid logging upstream URLs/bodies that could contain the configured API key; public-IP detection disables redirects, caps the response at 128 bytes, and accepts only syntactically valid IP addresses.
- Operator-configured LiveKit admin and HTTP proxy calls now use explicit timeouts, no automatic redirects, and bounded proxy request/response body behavior.
- Operator-configured AI provider base URLs must be absolute HTTP(S) URLs without embedded credentials; AI requests now disable automatic redirects and cap streamed provider JSON responses at 1 MiB.
- Expanded the release load smoke to include native voice participants and a native stream start/stop phase, with RSS captured after idle, chat load, and voice load phases.
- Expanded the release log-leak smoke to exercise the Tenor upstream-failure path with a fake API key and assert the captured server logs do not expose it.
- Added a real-browser release UI smoke that starts the release server and verifies login, hard-route session restore for `/app/templates`, app navigation, message send, composer image upload, image rendering, image-viewer open/close behavior, Template Gallery create/preview/apply behavior, public discovery search/filter/join behavior, channel settings dialog open/close behavior, admin dashboard entry, every visible admin settings field save/reload path, admin user/guild deletion confirmations, federation peer add/inspect/remove, backup create/download/restore/delete, and backup security-event filtering, pagination, and details expansion through Chromium.
- Fixed login public-key attachment so the client adopts the server-rotated access/refresh tokens returned after session revocation, preventing the app from continuing with stale credentials.
- Fixed admin dashboard discoverability for admin users after login and hardened GuildHub rendering for self-hosted/federated server URLs stored as `host:port` without a scheme.
- Admin security events now support paged browsing and expandable event details in the dashboard instead of only showing a fixed recent-event table.
- Fixed admin federation management requests to use the server-root `/_paracord/...` endpoint instead of the `/api/v1` API base, added Vite proxy/PWA exclusions for those routes, and hardened the embedded UI fallback so reserved API/realtime paths do not return the SPA shell as a false successful response.
- Fixed the admin settings update response to return the same complete settings shape as settings load, so saving no longer clears storage/cache fields from the UI.
- Gateway reconnects now treat `RESUMED` as a successful lifecycle event, resetting reconnect backoff and flushing queued presence/voice updates after a same-session resume.
- PostgreSQL route validation now covers scheduled messages, group DMs, webhook execution, and economy XP/leaderboard behavior. The pass found and fixed group DM recipient inserts on PostgreSQL, PostgreSQL economy timestamp binding/projection, and no-nonce message side-effect gating so XP, dispatch, and thread counters run for ordinary new messages.
- Scheduled event updates now reject unsafe description/location markup, and completed auto-created event channels are detached from the event before deletion so the worker does not leave stale event chat channels behind.
- Scheduled events now have a client edit dialog for event details in addition to existing RSVP, status, iCal, and delete controls; edits can also clear nullable details such as description, end time, location, recurrence, and reminder.
- Group DM E2EE now rotates the local sender key when membership or recipient identity keys change, preventing newly added members or old recipient identities from decrypting messages under the wrong sender-key epoch.
- Group DM E2EE sender-key recovery now allows an authenticated recipient to re-fetch their own acknowledged sender-key envelopes by epoch if local secure storage is lost, while the default sender-key fetch remains pending-only.
- Native direct-message voice now issues media tokens for the same canonical `0:{channel_id}` room ID enforced by the media accept guard, creates a revocable DB voice state before handing out the token, emits recipient-scoped realtime voice-state updates on native join and active leave, keeps no-op leaves for other DMs silent, forbids non-member DM voice leave, and clears that state only when the caller leaves the active DM voice channel. Native guild/DM voice joins also fail closed on voice-state write errors and clean up the just-created voice-state row if native room admission fails.
- Tauri's Rust-side `probe_server` and `native_fetch` paths are now restricted to loopback or exact trusted server origins before using the self-signed-certificate HTTP client, and the renderer-facing trusted-server sync command verifies non-loopback candidates through `/health` before storing them. This matches the scoped WebView2 certificate override instead of allowing arbitrary renderer-supplied HTTPS targets.
- README screenshots now use current checked-in release-candidate imagery and no longer show unverified voice/streaming screenshots before real media validation.
- Tauri desktop bundle identifier is now `com.paracord.desktop`, avoiding the previous `.app` suffix warning during packaging.
- GitHub CI Ubuntu jobs that run workspace Rust checks or coverage now install the required Tauri/WebKit/GTK/audio/libvpx native packages before invoking Cargo, preventing CI failures caused by missing desktop system libraries rather than code regressions.
- The Windows release workflow now installs and locates Inno Setup before building the `.exe` installer instead of assuming `ISCC.exe` is preinstalled on the runner.
- The CI security gate now reads a public `docs/security-release-gate.md` P0 status file, with the private local security tracker retained only as a developer fallback.
- The migration sanity CI job now builds the production client before running default-feature workspace Cargo checks, so `rust-embed` has current UI assets on a fresh checkout.
- The release workflow now validates that the tag version matches Cargo, npm, Tauri, README, and release-note metadata, reruns Rust/client/SDK dependency audits plus release checklist, line-ending, helper-script syntax, shell-script syntax, and workflow-lint guards before building artifacts, preserves downloaded artifacts while checking out release notes, and fails required artifact uploads/release creation when expected server or desktop outputs are missing.
- `scripts/setup.sh` no longer points at the removed `docker/docker-compose.yml`, no longer tries to apply SQLite migrations through `psql`, and now builds client assets before checking the Rust workspace.
- CI now syntax-checks `scripts/setup.sh`, `scripts/backup-db.sh`, and `scripts/restore-db.sh` so shell-script regressions are caught on Linux runners.
- `scripts/backup-db.sh` and `scripts/restore-db.sh` now redact database passwords when printing the target `PARACORD_DATABASE_URL`.
- Docker Compose now pins LiveKit to `livekit/livekit-server:v1.9.11`, matching the bundled release workflow version instead of pulling a mutable `latest` image.

### PostgreSQL Support

Six missing PostgreSQL migrations have been added to bring `migrations_pg/` in sync with SQLite:
- `messages_nonce_dedup` -- Nonce deduplication unique index
- `guild_storage_policies` -- Storage policy table
- `attachment_content_hash` -- SHA-256 hash column
- `federation_file_cache` -- Federation file cache (uses `BIGSERIAL` for PG)
- `storage_settings_seed` -- Default storage settings
- `hub_settings` -- Hub settings column on spaces table

### Build Configuration

- **esbuild optimizations**: `debugger` statements dropped and `console.log`/`console.info` marked as pure (tree-shaken) in production builds
- **CSP relaxed**: `img-src` and `media-src` allow `https:` and `http:` for remote media content
- **PWA service worker cleanup**: Tauri builds automatically unregister stale service workers to prevent cached asset issues

### New Workspace Dependencies

- `quinn` 0.11 -- QUIC protocol implementation
- `h3` 0.0.8 / `h3-quinn` 0.0.10 -- HTTP/3 and WebTransport support
- `audiopus` 0.3.0-rc.0 -- Opus codec bindings
- `nnnoiseless` 0.5 -- RNNoise-based noise suppression
- `cpal` 0.15 -- Cross-platform audio I/O
- `rubato` 0.15 -- Audio sample rate conversion

### Breaking Changes

- Voice join response may now include `native_media`, `media_endpoint`, `media_token`, `cert_hash` fields alongside existing LiveKit fields
- Native media can be enabled as the primary voice path while LiveKit remains available as fallback
- Windows release artifacts now include the Inno Setup `.exe` installer and Tauri `.msi`; Linux release artifacts include `.deb` and `.AppImage`

### Known Limitations

See [docs/known-limitations.md](docs/known-limitations.md) for the current support boundaries around native media, platform capture support, federation, updater artifacts, Docker, and database upgrades.
