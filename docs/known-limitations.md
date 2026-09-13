# Known Limitations

This page documents support boundaries for the v2.0.0 release. Items here are not security exceptions; they are product or platform limitations that should be visible before publishing public artifacts.

## AutoMod

- AutoMod evaluates **human messages sent through the REST API**. Operator-authored paths — bots, webhooks, and scheduled-message delivery — are deliberately not filtered.
- Members holding `ADMINISTRATOR` or `MANAGE_GUILD` are never filtered by their own space's rules.
- Evaluation **fails open**: if a rule cannot be parsed, or evaluation errors, the message is delivered and the problem is logged. A broken filter must not take chat down.
- Regular expressions are compiled with Rust's `regex` crate (no backtracking, so no catastrophic-backtracking class of attack), with pattern length and compiled program size bounded. Patterns are validated at write time, not on the send path.
- A rule is capped at 200 keywords, and a space at 50 rules.
- Message-spam triggers count a member's messages **in the triggering channel**, not across the whole space.

## Direct Message Encryption

- Direct-message **text and attachments** are end-to-end encrypted. A file is encrypted on the
  sending device under its own AES-256-GCM key and uploaded as ciphertext with a generated
  `<32 hex>.bin` name and `application/octet-stream`; the file key, original filename, media
  type, plaintext length and plaintext SHA-256 travel inside the Signal-encrypted message. The
  recipient decrypts previews and downloads locally and verifies the hash before showing
  anything. The server derives no preview, thumbnail or dimensions for these objects, and
  never serves them inline.
- Server-side at-rest file encryption is irrelevant to these objects: they are already
  unreadable to the server when it receives them. It still applies to space/channel uploads.
- **What is still visible to the server**: that a direct message carried attachments, how many,
  when, between which accounts, and each object's ciphertext length (the plaintext length plus
  a 16-byte tag). Message size and timing are not padded.
- **Space and channel attachments are unchanged** and remain readable by the server. They keep
  the existing plaintext upload path, including the filename and media type the sender chose.
- Encrypted attachments are **not available in group direct messages** yet. Group-DM message
  encryption itself is still awaiting its account-owned migration, so the composer refuses
  attachments there with that reason rather than falling back to a plaintext upload.
- A direct message that carries attachments **cannot be edited**. An edit replaces the whole
  encrypted body, and a delivered message's attachment keys cannot be recovered from the
  server, so the edit action is withheld rather than silently discarding them. Deleting the
  message and sending a new one works.
- One encrypted message body is limited to about 12 KB, which bounds the text, the ten
  attachment descriptors a message may carry, and any inline preview thumbnails. Thumbnails
  are generated for images where they fit that budget and are dropped largest-first when they
  do not; a message with no room for its descriptors is refused with that explanation instead
  of being sent without them.
- An attachment uploaded to a direct message by any other path — an older client, or a direct
  API call — is stored opaquely by the server but its **bytes are not encrypted**. The
  recipient's timeline labels such an attachment as not end-to-end encrypted rather than
  presenting it beside genuinely encrypted files.
- Queued attachments live in the account's encrypted vault until delivery, so they survive a
  reload and are removed when the queued message is discarded. They are **not** synchronised
  between devices: a message queued on one device can only be sent from that device.

## Server Health

- The health report is a point-in-time read of local configuration and filesystem state. It is **not** a public reachability probe: it does not connect to the server from the outside, so it cannot confirm that port forwarding, DNS, or the native media UDP port actually work from anywhere but the server host. In particular, `Voice & video → Native media: On (UDP 8443)` means the listener was configured and bound locally, not that a caller elsewhere can reach it.
- To find out whether a *particular* client can actually reach voice, use the guided voice connection check in that client (Settings → Voice & Video → Run connection check, or the same action offered when a call fails to start). It attempts a real QUIC/WebTransport session from the user's own network and reports which step failed. See [Deployment §7](deployment.md#7-voice-troubleshooting-the-connection-check).
- Database size is reported for SQLite only (summing the database and its WAL/SHM sidecars). PostgreSQL deployments report no size; use your database tooling.

## Native Media

- The voice connection check reports a real transport attempt from the client's network, but it deliberately stops short of authenticating with the relay: a diagnostic session carries no call token, and the relay only acknowledges tokens bound to an active call. A passing transport step therefore proves the UDP path, the QUIC handshake and the certificate — not that a join would be authorised.
- Inside the desktop app the media connection is opened by the native QUIC stack in the Tauri binary, which has no probe that avoids joining a call. The desktop check reports the transport step as skipped, with that reason, instead of guessing. Running the same check from a browser against the same server does exercise the UDP path.
- Browser voice needs a browser that can pin a self-signed certificate by fingerprint (`serverCertificateHashes`). Chromium-based browsers implement it; Firefox and Safari do not, so they cannot join native-media calls on a self-hosted server. The connection check reports this at the certificate step rather than letting the connection fail opaquely.
- Native QUIC/WebTransport media is the default voice/video path (`[voice] native_media = true`). LiveKit is an optional fallback for legacy WebRTC interop or SFU-scale rooms; set `native_media = false` and configure LiveKit to use it.
- Desktop native input and output device switching both work at runtime; switching the speaker/output device rebinds the active playback sinks in place.
- Native video receive routes each remote track to its own per-SSRC decoder. VP9 frames are decoded to raw I420 in the Tauri binary; codecs without a native backend (AV1/H.264) are passed through encoded for the frontend to decode.
- Native media subscription negotiation is wired end-to-end: subscribe/unsubscribe control messages are honored by the relay, so a client only receives the tracks it asks for.
- VP9 support depends on libvpx. Do not disable the `vpx` feature to work around build issues because that breaks video/screen-share behavior.

## Platform Capture Support

- Windows screen capture and system audio are the primary supported native capture path for this release candidate.
- Linux screen-share capture is functional: the PipeWire/portal encoding pipeline handles non-16:9 and odd capture dimensions and honors portal chunk offsets/stride. It still depends on desktop portal/PulseAudio availability, so validate it on the target distribution — and run a live multi-peer call/stream test — before publishing Linux artifacts.
- macOS system audio capture is not implemented; the app falls back to browser-style capture behavior where available.

## Federation

- Federation is disabled by default for new installs.
- Treat federation as an explicit trust relationship. Enable it only after configuring trusted peers, signing keys, DNS/URL policy, and operational key rotation.
- Federation media and feature parity are still evolving; validate every advertised cross-server flow in staging before enabling public federation.

## Scheduled Messages

- Scheduled messages support create, list, edit (content and delivery time), cancel, background delivery, and delivery after server restart. A `PATCH` on the scheduled-message resource updates a pending message before it fires; the desktop composer exposes an inline edit flow.

## Desktop Updater

- The Tauri updater is only usable for official signed releases when updater signatures and `latest.json` are generated by the release workflow.
- Unsigned/local builds should not advertise automatic updates as available.

## Docker

- The Docker quick start is HTTP-only inside the container by default (`PARACORD_TLS_ENABLED=false`). Terminate TLS at a reverse proxy for production; browsers block mic/camera/screen-share on plain HTTP, so browser voice needs HTTPS in front of the stack.
- Docker Compose is zero-config: no `.env` and no secrets are required. The server generates and persists a random `jwt_secret` into the `/data` volume on first run and reuses it across restarts. Native QUIC/WebTransport voice is the default; LiveKit is an opt-in profile (`docker compose --profile livekit up -d`). The LiveKit shared secret (`PARACORD_LIVEKIT_API_SECRET`) defaults to a local dev value and should be overridden in `.env` before exposing LiveKit to a network.

## Database And Upgrades

- SQLite is supported for small/self-hosted instances. PostgreSQL is recommended for sustained multi-user production deployments.
- The `paracord-server migrate-to-postgres` subcommand copies an existing SQLite database into a freshly migrated PostgreSQL database, verifying copied row counts and committing tail repair plus a new database history epoch with the copied rows. Target schema migrations and seed rows run first and remain applied on later failure or `--dry-run`; dry runs copy no source rows. It is an offline maintenance-window tool: stop the server and keep the SQLite file idle while it runs. It does not perform live/zero-downtime replication.
- Schema rollback is not supported. Back up the database and media before applying migrations.
- Current local upgrade evidence includes synthetic SQLite tag-schema validation from `v0.9.0`; a real released user database snapshot still needs to be validated before public release.

## Backup Recovery

- Archive recovery uses the offline `restore-backup` CLI and a new recovery directory; PostgreSQL additionally requires a separate empty, isolated database. The admin restore endpoint provides instructions and does not replace the live database.
- Original config/environment, at-rest master key and separate TLS/federation key files must be retained. S3 and database-only archives require an explicit matching local media export. Unsupported encryption, missing media or failed verification prevents publication of an activation config.
- Verification authenticates encrypted server attachments/secrets and checks attachment sizes/hashes, with a 1 GiB per-attachment verification limit. It does not reconstruct client vault/session keys for end-to-end encrypted history. See [backup recovery](backup-recovery.md) for evidence, supported inputs and cutover requirements.
