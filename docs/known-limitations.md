# Known Limitations

This page documents support boundaries for the v3.1.0 release. Items here are not security exceptions; they are product or platform limitations that should be visible before publishing public artifacts.

## AutoMod

- AutoMod evaluates REST message submissions and webhook sends/edits. Webhooks recheck creator membership, channel visibility and send permission. Creator timeouts block sends and edits; locked threads block new deliveries.
- Members holding `ADMINISTRATOR` or `MANAGE_GUILD` are never filtered by their own space's rules.
- Evaluation **fails closed**: invalid stored rules and evaluation errors are returned to the caller instead of permitting unfiltered content.
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
- **Group direct messages are end-to-end encrypted too**, under a sender-key scheme: each
  member mints a symmetric key, wraps it once per peer under a pairwise X25519 secret derived
  from the two identity keys, and seals every message under their own key. Text and attachments
  both travel this way, so a group attachment is the same opaque ciphertext a 1:1 attachment is.
  Three properties are worth stating because a naive sender-key design lacks them:
  - **Every message is signed.** The sender key is held by every member, so its AEAD tag proves
    only that *somebody in the group* wrote the message. Each message additionally carries an
    Ed25519 signature over the channel, the authenticated header and the ciphertext, checked
    against the sender's *pinned* identity key. The client also refuses a message whose signed
    sender is not the account the server attributed it to.
  - **The header is authenticated.** `sender_id`, the epoch and the membership fingerprint are
    the AEAD's additional data, and a header carrying any field outside that set is refused
    rather than passed along unauthenticated.
  - **Keys rotate with membership, and the server enforces it.** The epoch turns over whenever
    the membership fingerprint changes — somebody joining or leaving, or *any* member's identity
    key rotating — so the key a departed member holds is never the key the next message uses.
    Publishing a key names the membership version it was minted against, and the server, which
    owns the recipient list, refuses a publish whose version has moved: a client whose roster is
    behind cannot hand the group key to somebody who has already left, even by accident. The
    refusal names the current version, and the client refetches the roster and mints again.
    Recipients additionally decline a key minted for a roster naming anybody they can no longer
    see.
- **What group encryption trusts the server for**: who is in the channel. The server decides
  membership, as it does for every other channel, so it can add an account to a group and that
  account will receive keys for messages sent afterwards. It cannot read anything sent before,
  and it cannot forge a message from an existing member: that takes an identity private key,
  which never leaves the device. Members see roster changes in the conversation.
- A group conversation refuses to send while **any** member has not published an identity key,
  and names who it is waiting on. There is no plaintext fallback.
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

## Linux desktop app

- **WebKit's GPU compositing is turned off on NVIDIA's proprietary driver.** On
  those machines WebKitGTK either aborts the Wayland connection
  (`Gdk-Message: Error 71 (Protocol error)`) or segfaults inside
  `libnvidia-eglcore` as soon as it composites, and the window never paints a
  pixel. A twenty-line GTK + WebKit program reproduces it with none of Paracord
  involved, so the app detects the NVIDIA EGL vendor at startup and sets
  WebKit's `hardware-acceleration-policy` to `Never`. Note that the older
  `WEBKIT_DISABLE_COMPOSITING_MODE` and `WEBKIT_DISABLE_DMABUF_RENDERER`
  environment variables do **not** control this in WebKitGTK 2.4x — only the
  settings property does.
- This costs GPU compositing of the **interface** only. Video still decodes and
  renders on the GPU: it goes through the `gtk::GLArea` underlay, which owns its
  own GL context and is unaffected.
- `PARACORD_WEBKIT_ACCELERATION=never|ondemand|always` overrides the choice, for
  a machine whose driver has since been fixed or one that misbehaves without
  NVIDIA. Everything else on Linux keeps WebKit's own default (`ondemand`).
- The published **AppImage** is a separate problem and is still affected: it
  bundles its own WebKit, which aborts with `EGL_BAD_ALLOC` before any of the
  above applies. Build from source on such a machine, or install the `.deb`,
  which links the host `webkit2gtk-4.1`.

## Server Health

- The health report is a point-in-time read of local configuration and filesystem state. It is **not** a public reachability probe: it does not connect to the server from the outside, so it cannot confirm that port forwarding, DNS, or the native media UDP port actually work from anywhere but the server host. In particular, `Voice & video → Native media: On (UDP 8443)` means the listener was configured and bound locally, not that a caller elsewhere can reach it.
- To find out whether a *particular* client can actually reach voice, use the guided voice connection check in that client (Settings → Voice & Video → Run connection check, or the same action offered when a call fails to start). It attempts a real QUIC/WebTransport session from the user's own network and reports which step failed. See [Deployment §7](deployment.md#7-voice-troubleshooting-the-connection-check).
- Database size is reported for SQLite only (summing the database and its WAL/SHM sidecars). PostgreSQL deployments report no size; use your database tooling.

## Native Media

- The voice connection check reports a real transport attempt from the client's network, but it deliberately stops short of authenticating with the relay: a diagnostic session carries no call token, and the relay only acknowledges tokens bound to an active call. A passing transport step therefore proves the UDP path, the QUIC handshake and the certificate — not that a join would be authorised.
- Inside the desktop app the media connection is opened by the native QUIC stack in the Tauri binary, which has no probe that avoids joining a call. The desktop check reports the transport step as skipped, with that reason, instead of guessing. Running the same check from a browser against the same server does exercise the UDP path.
- Browser voice needs a browser that can pin a self-signed certificate by fingerprint (`serverCertificateHashes`). Chromium-based browsers implement it; Firefox and Safari do not, so they cannot join native-media calls on a self-hosted server. The connection check reports this at the certificate step rather than letting the connection fail opaquely.
- The media certificate is **short-lived by necessity**. Chromium accepts a `serverCertificateHashes` pin only for an ECDSA P-256 certificate whose total validity window is at most 14 days, so the server issues one valid for 13 days (back-dated an hour for clock skew) and rotates it roughly every 7 days while it runs. Rotation swaps the certificate the media port presents and republishes the fingerprint atomically; calls already in progress are unaffected, because QUIC authenticates once at handshake. This is entirely internal to the media port — an operator running a reverse proxy in front of Paracord never supplies, renews or sees this certificate, and a CA-issued certificate configured for HTTPS is never presented on the QUIC media port.
- Because the fingerprint changes, it is a **fresh** fact rather than a per-server constant. Clients read it on every voice join and again before every reconnect, and a handshake refused with a fingerprint that turns out to be stale is retried once against the freshly published one. A fingerprint copied out of a log or pinned in external tooling will stop matching within days; read it from `GET /api/v1/voice/transport-diagnostics` instead.
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
- File downloads require both the short-lived file token and a signed HTTP GET from the trusted peer to which it was issued. Updated senders can download from older receivers, but older senders must upgrade before downloading from an updated receiver. An unsigned fallback would restore the stolen-token vulnerability.
- Federation QUIC handshake signatures bind the handshake role, protocol version and both peers to the TLS connection. Both media peers must run this handshake version; old unbound signatures are rejected. This does not change ordinary client voice/video packet formats.
- A federation request is **addressed to the peer's `server_name`**, not to the hostname in
  its `federation_endpoint`, and the receiver refuses anything addressed to a name it does
  not answer to. Register a peer under the `server_name` that peer publishes at
  `/.well-known/paracord/server`; a peer registered under a made-up name will be refused
  with `403` and a `destination binding mismatch` warning in the receiver's log naming both
  values. A receiver also accepts the host of its own `PARACORD_PUBLIC_URL` as an alias for
  itself, which is what lets a pre-3.0.0 sender keep delivering during a rolling upgrade.

## Multi-Server From A Browser

- Adding a **second** server from a browser-served Paracord requires that server's
  operator to allow this page's origin. The browser sends the connect probe and every
  later API call cross-origin with credentials, and a credentialed cross-origin request
  is only answered for an origin on the target server's allowlist. Paracord ships that
  allowlist closed (the Tauri origins and the Vite dev servers, plus
  `PARACORD_PUBLIC_URL`), because the alternative — reflecting whatever `Origin` arrives
  and answering with `Access-Control-Allow-Credentials: true` — would let *any* website
  a signed-in user visits drive their Paracord server with their cookies.
- The fix is one setting on the **server being added**, not on the one serving the page:

  ```bash
  # On the server being added. Comma-separated; scheme + host + port, no trailing slash.
  PARACORD_CORS_ALLOWED_ORIGINS=https://chat.example.com,http://127.0.0.1:18240
  ```

  `PARACORD_PUBLIC_URL` is allowed automatically, so a server that already sets it accepts
  its own origin without further configuration.
- **The desktop app is not affected.** Tauri issues requests from a fixed
  `tauri://localhost` origin that is always on the allowlist, so multi-server works between
  any two reachable servers with no configuration at all. This limitation is specific to the
  browser-served build.
- When a browser connect is refused this way, the connect wizard now says so by name —
  which host refused, the setting its operator needs, and that the desktop app is unaffected
  — instead of reporting a generic network failure. It distinguishes the two by repeating the
  probe in `no-cors` mode: a response that arrives at all proves the host is up and it was
  the allowlist that refused.

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

## Sessions and sign-in (3.1.0)

- When the instance refuses the session a desktop client saved, the client discards the credential but can stay in the app shell showing "Unknown user" and no servers, rather than reaching the sign-in screen. Logging out from Settings and signing in again recovers it. Seen once on Linux against a local instance on 2026-09-20; the cause of the refusal was not established.

## Looks (3.1.0)

- Dusk sky and Paper & ink switch to solid panels and drop the paper grain while a native video underlay is active on the Linux desktop client. The rules are keyed off the same attribute that opens the underlay, but have not been exercised against a live native stream.
