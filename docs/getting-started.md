# Getting Started

Paracord has no company server in the middle. Somebody in your group runs the
server on a computer that stays on, and everyone else joins with an invite link.
This page walks the person running the server through it. It takes a few minutes
and there is nothing to configure by hand.

If you were only **sent an invite**, you don't need this page: open the link,
press **Create an account to join**, and you're in. (Or install the
[desktop app](../../releases/latest) and paste the link there.)

## 1. Get the server

### Option A — one command (recommended)

**Linux or macOS**, in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.sh | sh
```

**Windows**, in any PowerShell window:

```powershell
irm https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.ps1 | iex
```

The installer downloads the latest release, sets the server up to start by
itself, starts it, and **opens the link that finishes setup in your browser**
(it prints the link too). If you used this option, skip to step 3.

- On Windows it asks for administrator permission itself. Say yes and Paracord
  is installed for the whole computer, starts with it, and the firewall is
  opened so friends can connect. Say no and it installs just for you.
- On Linux, run it with `sudo` for a whole-computer install with a system
  service; without it, it installs just for you and starts when you log in.
- Running the same command again later **updates** Paracord. Your accounts,
  messages and settings are kept.
- `PARACORD_NO_BROWSER=1` prints the setup link without opening a browser.
  Offline and pinned installs (`PARACORD_VERSION`, `PARACORD_LOCAL_ARCHIVE`) are
  described in the header of `scripts/install.sh`.

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

(Only if you did not use the installer — it already did this.)

```bash
# Linux / macOS, from the directory containing the binary
./paracord-server
```

```powershell
# Windows: double-click paracord-server.exe, or from a terminal:
.\paracord-server.exe
```

The first time it runs, the server creates everything it needs — its settings
file, its database and its own certificate — and prints two things worth
reading:

```
  ┌─ This server has no owner yet ─────────────────────
  │
  │  Finish setting up — open this link:
  │       https://192.168.1.50:8443/setup-server#claim=K4M7PQ2X…
  │
  └────────────────────────────────────────────────────

  ┌─ Next steps ───────────────────────────────────────
  │
  │  1. Finish setting up — open this link: …
  │  2. Invite friends:
  │     Friends anywhere can join at https://203.0.113.7:8443 …
  │
  └────────────────────────────────────────────────────
```

The link is also saved next to the settings file as
`first-owner-claim-link.txt`, readable only by the account that runs the server,
and is deleted once it has been used.

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

## 3. Finish setting up

Open the link from the installer or the server. It takes you straight to
creating **your** account — the owner's — then asks you to name things. That is
the whole setup.

Your browser may show a one-time security warning first, because the server made
its own certificate: choose **Advanced**, then **Continue**. The desktop app
never shows this.

The link works once and only for you. Until it has been used nobody can create
an account on your server, so somebody who finds the address before you cannot
take it over. Everyone who joins afterwards is an ordinary member.

If the link doesn't fill the code in by itself, the setup page has a box for it:
paste the long code from the end of the link, or from `first-owner-claim.txt`.

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

Open your server and press **Invite**. It gives you a link to send, and says
plainly who it will work for:

- **Anyone** — your router let Paracord open the way in, or you have a public
  address configured. Send the link to whoever you like.
- **Only people on the same Wi-Fi** — your router refused. Friends elsewhere
  can't connect until one setting is changed on the router;
  [Friends outside your network](port-forwarding.md) walks through it and shows
  how to check it worked.

The server asks the router by itself every time it starts (UPnP, then NAT-PMP).
To turn that off, set `auto_port_forward = false` under `[network]` in the
settings file.

A friend who opens the link in a browser presses **Create an account to join**
and lands in your server. A friend with the [desktop app](../../releases/latest)
pastes the same link into it. The browser shows the one-time certificate warning
described above; the desktop app does not.

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
