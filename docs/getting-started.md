# Getting Started

This is the step-by-step first-run walkthrough for standing up your own Paracord
server and inviting friends. Paracord is **zero-config**: there are no secrets to
generate by hand, no external voice server to provision, and no database to set up
before you start. The server creates everything it needs on first run.

Two things are true of every Paracord server and worth knowing up front:

- **A new server has no owner until you claim it, and refuses registrations
  until then.** Starting it prints a one-time claim token; you paste that at
  `<server URL>/setup-server` to create the owner account, name the server and
  open its first space. Nobody who finds the address before you can take it.
- **Voice and video use Paracord's own native QUIC media engine by default.**
  You do **not** need LiveKit or any external SFU. LiveKit is an optional
  fallback (see [Native media vs. LiveKit](#native-media-vs-livekit) below).

## 1. Get the server

Pick whichever is easiest for you.

### Option A — one-command installer (recommended)

**Linux** — this downloads the latest release, installs it, generates the
config, and prints the URL to open:

```bash
curl -fsSL https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.sh | sh
```

- With `sudo` it installs system-wide under `/opt/paracord`, creates a
  `paracord` service user, and registers a hardened, auto-restarting
  **systemd service** — the server is already running when the script exits.
- Without root it installs under `~/.local/share/paracord` and sets up a
  per-user systemd service when a user manager is available (or prints the
  exact command to run).
- Re-running the same command **upgrades** the binary while preserving your
  config and data; the previous binary is kept under `backups/`.
- Offline/pinned installs: `PARACORD_VERSION=2.0.0`, or
  `PARACORD_LOCAL_ARCHIVE=./paracord-server-linux-x64-2.0.0.tar.gz` — see the
  header comment in `scripts/install.sh` for every override.

**Windows** — in an elevated PowerShell:

```powershell
irm https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Elevated, it installs under `%ProgramFiles%\Paracord`, registers an auto-start
scheduled task (running as `SYSTEM`, restarting on crash), and opens inbound
firewall rules for TCP and UDP `8443`. Without elevation it installs under
`%LOCALAPPDATA%\Paracord` with Start Menu and logon-startup shortcuts.

### Option B — download a release

Grab the latest server build from the
[Releases page](../../releases/latest) and extract it:

```bash
# Linux
tar xzf paracord-server-linux-x64-*.tar.gz
chmod +x paracord-server/paracord-server
cd paracord-server
```

On Windows, download and extract `paracord-server-windows-x64-*.zip`.

### Option C — build from source

```bash
git clone https://github.com/Scdouglas1999/Paracord.git
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
  │  2. Claim the server: open https://192.168.1.50:8443/setup-server
  │     and paste the one-time claim token printed above. That
  │     creates the OWNER account, names the server and makes
  │     its first space.
  │  3. Invite others: share the URL, or create an invite link in-app.
  │     They register normally and join as members, not operators.
  │  4. Voice & video run on Paracord's native QUIC engine — forward
  │     port 8443 (UDP + TCP) on your router for access off your network.
  │
  └────────────────────────────────────────────────────
```

Above that block the server prints the claim token itself:

```
  ┌─ This server has no owner yet ─────────────────────
  │
  │  Claim it at:
  │       https://192.168.1.50:8443/setup-server
  │
  │  One-time claim token (generated for this first run):
  │       K4M7PQ2XВ…
  │
  │  Also saved (owner-readable only) at:
  │       config/first-owner-claim.txt
  │
  │  Until it is claimed, nobody can register an
  │  account here — including anyone who finds this
  │  address before you do.
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

## 3. Open the URL and claim the server

Open the **Open / share** URL from the console in your browser.

Because the native/binary server uses a **self-signed** certificate, your browser
shows a one-time security warning the first time you connect — accept it to
continue. (The desktop client auto-trusts the server's certificate, so it never
shows this warning.)

The sign-in page sends you straight to **Set up your Paracord server**, because
this server has no accounts yet. Paste the claim token from the console (or from
`config/first-owner-claim.txt`), pick a username and password, name the server,
and name its first space. That one step creates the **owner** account — the
person who runs this machine — and lands you in the new space.

The token works once. After the claim, `/setup-server` redirects to sign-in, and
ordinary registration opens: everyone who joins later is a **community member**,
not an operator.

**Pinning the token in advance.** Provisioning systems and CI can set the token
rather than reading it from the console — in the config:

```toml
[setup]
claim_token = "at-least-32-random-characters-here"
```

or as `PARACORD_SETUP_CLAIM_TOKEN`. For a fully unattended deployment where a
script you control creates the first account, set `require_claim = false` (or
`PARACORD_SETUP_REQUIRE_CLAIM=false`) and the **first account registered** owns
the server, as older Paracord releases behaved. The server logs a warning when
it starts that way, because anyone who reaches it first would own it.

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
