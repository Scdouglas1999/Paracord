# Getting Started

This is the step-by-step first-run walkthrough for standing up your own Paracord
server and inviting friends. Paracord is **zero-config**: there are no secrets to
generate by hand, no external voice server to provision, and no database to set up
before you start. The server creates everything it needs on first run.

Two things are true of every Paracord server and worth knowing up front:

- **The first account you register becomes the server owner/admin.** Register it
  yourself immediately after starting the server.
- **Voice and video use Paracord's own native QUIC media engine by default.**
  You do **not** need LiveKit or any external SFU. LiveKit is an optional
  fallback (see [Native media vs. LiveKit](#native-media-vs-livekit) below).

## 1. Get the server

Pick whichever is easiest for you.

### Option A — download a release

Grab the latest server build from the
[Releases page](../../releases/latest) and extract it:

```bash
# Linux
tar xzf paracord-server-linux-x64-*.tar.gz
chmod +x paracord-server
```

On Windows, download and extract `paracord-server-windows-x64-*.zip`.

### Option B — build from source

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord

# Build the web UI, then the server (the UI is embedded in the binary)
cd client && npm install && npm run build && cd ..
cargo build --release --bin paracord-server

# The binary is at target/release/paracord-server
```

## 2. Run it

```bash
# Linux (from the directory containing the binary)
./paracord-server
```

```powershell
# Windows: double-click paracord-server.exe, or from a terminal:
.\paracord-server.exe
```

On the very first run the server:

- writes its config to `config/paracord.toml`,
- generates a random JWT signing secret and persists it,
- creates the SQLite database under `./data/`,
- generates a self-signed TLS certificate under `./data/certs/`, and
- prints the URL to open/share plus a short **Next steps** block.

You'll see something like:

```
  ➜  Open / share:  https://192.168.1.50:8443

  ┌─ Next steps ───────────────────────────────────────
  │
  │  1. Open Paracord in your browser: https://192.168.1.50:8443
  │  2. Register the FIRST account — it becomes the server owner/admin.
  │  3. Invite others: share the URL, or create an invite link in-app.
  │  4. Voice & video run on Paracord's native QUIC engine — forward
  │     port 8443 (UDP + TCP) on your router for access off your network.
  │
  └────────────────────────────────────────────────────
```

### Want to generate the config first?

Run the one-shot initializer, read the printed instructions, then start the
server. `init` writes `config/paracord.toml` if it's missing (it never overwrites
an existing config) and exits without starting anything:

```bash
./paracord-server init            # write config + print next steps, then exit
./paracord-server init -c /etc/paracord/paracord.toml   # use a custom config path
./paracord-server                 # start the server
./paracord-server -c /etc/paracord/paracord.toml        # start with a custom config path
```

## 3. Open the URL and register the owner account

Open the **Open / share** URL from the console in your browser.

Because the native/binary server uses a **self-signed** certificate, your browser
shows a one-time security warning the first time you connect — accept it to
continue. (The desktop client auto-trusts the server's certificate, so it never
shows this warning.)

Register your account. **The first account registered is automatically the server
owner and admin** — so do this yourself before sharing the URL.

## 4. Invite your friends

- **Same network:** share the **Open / share** URL directly.
- **Over the internet:** forward **one port — `8443` over both TCP and UDP** — to
  the machine running the server, then share your public URL
  (`https://<your-public-ip>:8443`). TCP `8443` carries HTTPS (web UI + gateway);
  UDP `8443` carries native QUIC voice/video media. That single port covers both
  browser and desktop clients.
- **In-app invites:** once you're in a guild, create an invite link from any
  channel and send it to friends.

Friends can join two ways:

- **Desktop app** — install the [desktop client](../../releases/latest), paste the
  server URL, and create an account. The desktop client speaks raw QUIC directly
  and auto-trusts the self-signed certificate.
- **Browser** — open `https://<server-ip>:8443`, accept the self-signed
  certificate warning, and create an account.

## Native media vs. LiveKit

Paracord ships **two** media backends. You almost certainly want the default.

| | Native QUIC engine (default) | LiveKit SFU (optional) |
|---|---|---|
| Setup | None — on by default | Opt-in profile + config |
| Extra process | No | Yes (a LiveKit server) |
| Desktop transport | Raw QUIC | WebRTC |
| Browser transport | WebTransport (HTTP/3) | WebRTC |
| Best for | Almost everyone | Legacy WebRTC clients, very large SFU-scale rooms |

**When would you opt into LiveKit?** Only if you specifically need a traditional
WebRTC SFU — for example to scale a single room far beyond typical group sizes, or
to interoperate with existing WebRTC tooling. For self-hosted communities the
native engine is simpler and needs nothing extra.

To enable LiveKit under Docker Compose, start it with its profile and route voice
through it:

```bash
docker compose --profile livekit up -d
```

Then set `PARACORD_VOICE_NATIVE_MEDIA=false` on the `paracord` service (see
`docker-compose.yml`, `.env.example`, and [docs/docker-setup.md](docker-setup.md)).
For a binary deployment, set `native_media = false` under `[voice]` and configure
the `[livekit]` section in `paracord.toml`.

## A note on TLS (why HTTPS matters)

Browsers only grant microphone, camera, and screen-share access in a **secure
context** (HTTPS), and browser voice uses **WebTransport**, which requires TLS.

- **Native/binary server:** TLS is on by default. The server auto-generates a
  self-signed certificate and serves HTTPS on `8443`, so browser voice works out
  of the box (after you accept the certificate warning once).
- **Desktop clients:** connect over raw QUIC and pin the server's certificate via
  the `cert_hash` returned at voice-join time, so they work regardless of the
  browser's TLS requirements.
- **Docker stack:** serves plain HTTP on `8090` by default and expects TLS to be
  terminated at a reverse proxy. Browser mic/camera/screen-share only work once
  HTTPS is in front — see [docs/docker-setup.md](docker-setup.md) for a
  reverse-proxy example.

## Next steps

- Production hardening, reverse-proxy TLS, PUBLIC_URL, PostgreSQL, and backups:
  [docs/deployment.md](deployment.md).
- Full Docker configuration reference: [docs/docker-setup.md](docker-setup.md).
- Baseline profile values for dev / single-node / testbed:
  [docs/deployment-profiles.md](deployment-profiles.md).
- Current support boundaries: [docs/known-limitations.md](known-limitations.md).
