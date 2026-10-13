# First-run setup: spec

The contract for Paracord's guided first run: hosting a server from the desktop
app, joining friends from an invite, one password, and privacy defaults that
are on from the start. The build plan is
[`docs/design/setup-plan.md`](design/setup-plan.md).

- **Approved design:** `output/design-reference/setup/paracord-first-run.html`
  (clickable; both paths, router allows/refuses) and the screenshots beside it.
  Visual and behavioral parity with it is the bar, built in the Index language
  (`client/src/components/ix`, [`docs/index-spec.md`](index-spec.md)).
- **Brand mark:** `client/src/components/brand/CordMark.tsx` (motions
  `none | draw | loading | working`, tones `ember | mono`). The prototype uses
  exactly these; so does the build.
- **Base:** `main` at `a1853e93`. Line numbers below are from that commit.

Owner goal: *"guided, quick, as easy as possible, and with as much automated as
possible ... privacy, security ... on and set up by default where possible ...
from open source project to an app the average person can set up."*

---

## 0. Rules that apply everywhere

1. **One deterministic path per capability. No fallbacks, no silent
   degradation.** When something cannot be done (no keychain, no systemd user
   session, older server, router refused), the UI says so in plain words, says
   what would fix it, and does not quietly do something weaker. Where two paths
   exist (an older server), the choice is made from a detected server version,
   not from a failure, and the UI names it (the `serverFeatures` pattern,
   `client/src/lib/serverFeatures.ts:21-99`, `isMissingRoute` in
   `client/src/api/client.ts:167-175`).
2. **Vocabulary.** "Server" is the community. The machine is "this computer";
   the hosted process is "Paracord on this computer". "Instance" appears only in
   admin/technical surfaces. Never "room", "building", "space" in UI copy.
   American English.
3. **Honesty about reach.** Never say friends can reach the server beyond what
   the router reported or a real outside connection proved (§5).
4. **Performance.** No polling loops when nothing is on screen; the KDF runs in
   a worker; the boot and setup motion is CSS only (CordMark never runs script
   per frame); the hosted server adds no work to the app when the window is
   closed beyond what the server itself does.
5. **Motion.** Prototype curves (`--spring: cubic-bezier(.32,.72,0,1)`,
   `--ease: cubic-bezier(.2,.8,.2,1)`) map onto the Index motion tokens
   (index-spec §5). Durations follow the Index speed-up (owner: snappy):
   screen swaps 200 ms, preview transforms 360 ms, sheet enter 220 ms. The
   launch sequence (§1.2) keeps its prototype timing because it is the mark
   drawing itself; it runs only on a first launch and is skippable.
6. **Reduced motion** (`lib/motion/reducedMotion`): every transition becomes a
   crossfade of ≤ 80 ms, CordMark shows the still mark, the launch sequence is
   replaced by the still welcome screen.

---

## 1. Screens and states

### 1.1 Frame

The first run owns the whole window (it does not render inside `IxFrame`). It
supersedes index-spec §6.14 for the first-run routes only.

| Part | Spec (prototype CSS in parentheses) |
|---|---|
| Ground | `#0e0f11` with two hue glows (`.glow`): 760×520 at 78% 46%, `hsl(var(--hue) 60% 42% / .2)`; 620×380 at 8% -10%, `/ .1`. `--hue` animates 700 ms ease when it changes |
| Title bar (64 px) | `CordMark size=24` + "Paracord" 15/650 left; progress segments centered (28×4, gap 6, fill animates `scaleX` with the spring); "Sign in instead" text button right. Hidden on Welcome. On desktop the title bar is also the window drag region (`data-tauri-drag-region`) |
| Flow column | Left 584 px; screen padding 132/56/48/76. h2 34/620, `-0.025em`; sub 16/1.5 ink-2, max 42ch. Footer pinned bottom: text "Back" (46 tall) + cream primary (46 tall, radius 13, 15/700, trailing arrow) |
| Live preview | The app at 1280×800 scaled .5 at (612,176), radius 28, ring `0 0 0 2px rgba(255,255,255,.1)`, "Preview" badge top-right (§1.9) |
| Screen change | Leaving screen slides −16 px and fades; entering from +16 px; 200 ms, entering delayed 40 ms |
| Progress | `n = steps − 1` segments (host 5, join 4); segment `k` is filled when `k < index` |
| Width < 1040 px or height < 680 px | Single column: preview hidden, flow column centered at max 520 px. Phone width (web): 16 px gutters, footer sticky |
| Keyboard | Enter = primary when enabled; Esc = close sheet, else Back; focus moves to the first input of a screen after its entrance (≈ 220 ms); Tab order: fields, then Back, then primary |

Fields: 48 tall, radius 13, `rgba(255,255,255,.06)` with a hairline; focus ring
`inset 0 0 0 1.5px hsl(var(--hue) 70% 72% / .7)`. The big name field is 62 tall,
26/600. These become `components/firstRun/primitives.tsx` (§9.6), built on
Index tokens; no literal colors outside tokens (`npm run test:tokens`).

### 1.2 Launch (first launch only)

`boot` → `word` at 900 ms → `out` at 1700 ms → `gone` at 2280 ms:
`CordMark size=168 motion=draw` at (556,250); the wordmark resolves (blur 8 → 0,
350 ms) at 900 ms with "Just a moment…" under it; at 1700 ms the background
clears and the mark glides `translate(0,-130px) scale(.5714)` (550 ms spring)
onto the welcome mark position (96 px); at 2280 ms the welcome mark replaces it
(`CordMark size=96`, still). Welcome content fades in 400 ms with a 100 ms delay.

- Runs only when the app has no saved servers and `firstRun.launchSeen` is
  unset (versioned storage key). Later launches use `BrandSplash` unchanged.
- Any key or click skips to `gone`. Reduced motion: no launch, still welcome.
- If a deep link (§6.4) is pending at launch, the launch still plays, then the
  app goes straight to the join step (prototype note: "A paracord:// invite
  link ... skips this screen").

### 1.3 Welcome

Copy (exact): **Welcome to Paracord** / "A place to talk with your people, on a
server you or a friend runs. Private by default." Two cards (330 wide, gap 16):

- **Host a server**, glyph hue 18: "Run it from this computer. Setup takes
  about a minute, and encryption is on from the start."
- **Join friends**, glyph hue 200: "Have an invite link? Paste it and you'll be
  talking in a few seconds."

"Already have an account? **Sign in**" → §1.12. Footer fine print with icons:
"End-to-end encrypted messages and calls" · "No ads, no tracking" · "Open source".

Real behavior:
- **Host a server** is shown only in the desktop app. Clicking it starts
  `host_preflight` (§2.3) in the background and moves to Name. If preflight
  says hosting is impossible here, the Name screen shows a blocking notice in
  place of the fields (§2.3 lists every reason and its copy) and Continue is
  disabled. On the web the card is replaced by nothing: the web Welcome shows
  only Join and Sign in, centered.
- **Clipboard invite** (desktop only, §6.5): on Welcome mount and on window
  focus while Welcome is visible, the clipboard is read once; if it holds an
  invite, the app moves to the Join step with the "There's an invite on your
  clipboard" banner showing (not auto-filled).

### 1.4 Host › Name (`h-name`)

"What should we call your server?" / "This is the name your friends will see.
You can change it any time." Big field, placeholder "Friday Night Crew",
`maxlength=32`. "Color": eight hue swatches `[18, 350, 38, 150, 172, 200, 220, 0]`
(34 px circles; the selected one has the double ring). Default hue 18.

- Continue enabled when the trimmed name has ≥ 2 characters.
- Typing updates the preview live: server mark letter (first letter, uppercase),
  name, the "Welcome to …" heading, and `--hue` for the whole stage.
- The name becomes both `instance_name` and the first server's name; the hue
  becomes `spaces.hue` (`migrations/20261004000001_index.sql`).
- Footer link (secondary, under the swatches): "Restore from a backup instead"
  (§4.8). It is shown only when preflight found no existing host data.

### 1.5 Join › Invite (`j-invite`)

"Paste your invite" / "Ask the friend who runs the server for a link."

| State | Shows |
|---|---|
| Empty | Field placeholder `https://…/invite/…`; Continue disabled |
| Clipboard found | Banner (hue-tinted): clipboard icon, "There's an invite on your clipboard." + chip **Use it** (fills the field). Hidden once the field has a valid invite |
| Checking | Below the field: `CordMark size=18 motion=loading tone=mono` + "Checking the invite…". Starts 250 ms after the last keystroke when the text parses as an invite (§6.3) |
| Card | Server card slides in (8 px, spring): `ServerMark` 48 with the server's hue, name 18, green dot + "{online} online · {members} members", up to three faces (initial + hue). Trust row (§7): shield-check, **Connected securely to {host}.** "We remembered this server's identity and will warn you if it ever changes." and the four words in caps-spacing (`ember · quarry · lantern · osprey`). Continue enabled |
| CA-verified host | Trust row reads **Connected securely to {host}.** "Its certificate is issued by a public certificate authority." No words |
| Invalid / used up / expired | Field error under the field: "This invite doesn't work anymore. Ask for a new link." (404 from the preview) |
| Can't reach | "Can't reach {host}. Check the link, or ask your friend whether their server is running." + chip **Try again** |
| Identity changed | The identity-changed sheet (§7.4) opens over the step; Continue stays disabled |
| Older server | "{Server name or host} runs an older version of Paracord. Ask the person who runs it to update, then try again." Continue disabled (§3.12) |
| Not desktop and cross-origin | Web join only works on the server's own page (§6.6); on the web this step never appears |

The preview (§1.9) switches to the join model when the card shows: the stage
`--hue` becomes the server's hue, and the preview's main area blurs (3 px).

### 1.6 Account (`account`)

"Make your account". Sub: host "You'll be the owner of **{name}**."; join
"You're joining **{server}**. Already have an account there? **Sign in**"
(→ §1.12 with the server prefilled).

| Field | Rule |
|---|---|
| Your name | Display name, placeholder "Sam". Updates the preview's dock avatar (hidden until non-empty) |
| Username | `@` prefix. Auto-filled from Your name until edited: lowercase, keep `[a-z0-9_.]`, cut to 20. Validated client-side against the server's username rules (mirror `paracord_util::validation`) |
| Email | Shown only when the server's `GET /auth/options` says `require_email: true`. The host profile never requires it |
| Password | Placeholder "At least 10 characters". 4-segment meter + help line (below). Show/hide eye button (not in the prototype; required for accessibility) |

Meter score (prototype `score()`): 0 when empty; else `≥10 chars +1`,
`≥14 +1`, mixed case `+1`, digit/symbol/space `+1`, clamped 1..4. Help text:
empty → "Use a phrase you'll remember, like three or four unrelated words.";
`< 10` → "{n} more characters"; else `["Okay. A longer phrase is stronger.",
"Good.", "Strong.", "Very strong."][score-1]`. Additionally, a password that
appears in the bundled 10k common-password list or equals the username/display
name shows "That one is too easy to guess." and blocks Continue.

The one-password card: lock icon (ok color), **One password does it all.** "It
signs you in and locks your private messages. Your device turns it into
separate keys, so the server can never read what it locks."

Continue enabled when username ≥ 2, password ≥ 10 UTF-8 bytes, not common,
email valid when shown. Pressing it does no network call; the account is made
during Setup. If Setup later reports a field problem (username taken, invite
used up, email refused), the flow returns here with the error under the field
and Setup resets.

### 1.7 Setup (`setup`)

`CordMark size=56` above the title (`working` motion while rows run, still when
done). Title host "Setting up your server", join "Getting you in". Sub "This
takes a few seconds. There's nothing you need to do." Rows are 28 px status
circle + title 15/600 + detail 13 ink-3; states:

| State | Circle | Row |
|---|---|---|
| waiting | 1.5 px ring, row opacity .35 | detail shows the pending line |
| run | `CordMark size=18 motion=loading tone=mono` | background `rgba(255,255,255,.04)` |
| ok | green tint + check (scale-in, spring) | detail becomes the done line |
| warn | amber tint + "!" | detail becomes the warn line, chips under it |
| fail | danger tint + "×" | detail is the reason; chips **Try again** and **Show details** (log tail, §2.8) |

No Back on this screen. Continue is enabled when no row is waiting/run/fail.
"See what's protected" (shield icon, ok color) fades in when all rows are done
and opens §1.10. The rows run in order; each row's real work and copy:

**Host rows** (sources in §2.6):

| # | Title | Pending | Done | Warn / fail |
|---|---|---|---|---|
| 1 | Starting Paracord on this computer | It keeps running in the background, even with this window closed. | same | fail: the step that failed, in words (§2.6) |
| 2 | Encrypting everything it stores | Messages and files are encrypted on disk. The key is kept in your system keychain. | same | fail: "Paracord on this computer is running without encryption." (never expected; it means the server ignored its config; setup stops) |
| 3 | Creating your encryption keys | Private messages, voice and video are end-to-end encrypted. | same | fail: claim/credential error |
| 4 | Letting friends reach you | Asking your router to open a port. | per §5.4 | warn per §5.4, chips **Show me how** (opens §1.11) and **Try again** |
| 5 | Turning on daily backups | Kept on this computer for 14 days. | same | fail: first backup error |

The preview's status line follows row 1: "Not running yet" → "Starting…" (row 1
run) → green dot "Online · just you" (row 1 ok).

**Join rows**:

| # | Title | Done line |
|---|---|---|
| 1 | Connecting securely | Your connection to {server} is encrypted. |
| 2 | Creating your encryption keys | Private messages, voice and video are end-to-end encrypted. |
| 3 | Joining {server} | Getting channels and who's around. |

Timing budget (not padding): rows complete as soon as their work does. Each row
is shown in `run` for at least 300 ms so the sequence reads; nothing else is
artificially delayed. Expected total: host ≈ 8–18 s (server start, scrypt,
router ≤ 8 s), join ≈ 3–5 s.

### 1.8 Recovery phrase (`phrase`)

"Save your recovery phrase" / "If you forget your password or lose this
computer, these 24 words get your account back. Nobody can reset them for you,
so keep them somewhere safe."

- 24 words in a 4-column numbered grid, blurred (`filter: blur(7px)`,
  `user-select:none`) under a **Show words** button until pressed.
- Chips: **Copy** (desktop: written via the clipboard plugin and cleared 60 s
  later if the clipboard still holds it; web: `navigator.clipboard`, no clear),
  **Save as file** (desktop: save dialog, default name
  `Paracord recovery phrase.txt`, content = header line, numbered words, the
  account `@username` and server, one line of instructions; web: Blob
  download), **Print** (ghost; a print-only stylesheet prints the numbered
  words, username and server, nothing else).
- Copy, Save and Print reveal the words if hidden.
- Checkbox "I saved my recovery phrase somewhere safe" enables Continue. Join
  path's primary reads "Open {server}" (and finishes, §1.13); host path's reads
  "Continue".
- On Continue: `POST /users/@me/key-backup/recovery-confirmed` (§9.1).
- The words are the identity private key (§3.6). They are held in memory only;
  the page never writes them to storage. If the app quits before the checkbox,
  the next unlock shows this screen again (the account's
  `recovery_confirmed` is still false), because the phrase is derived from the
  key and can be shown again.

### 1.9 Live preview

The right side is the app's own shell at 1280×800, scaled .5, made from real
Index components (`ServerMark`, `Avatar`, sidebar rows, `Welcome` cards, the
composer bar) fed by a static model (`firstRun/preview/model.ts`), not by the
live stores, so it costs nothing while typing.

- **Host model:** server mark/name/hue from Name; status line from row 1; text
  channels `general` ("Say hi to everyone"), `clips` ("Share highlights and
  screenshots"), `plans` ("What's happening this week"); voice channels
  `Lounge`, `Gaming`; main "general" / "The first channel in {name}"; welcome
  block "Welcome to {name}" / "It's ready. Here are a few good first steps." +
  three cards (Invite friends / Hop in Lounge / Make it yours). These are the
  channels the claim really creates (§2.7), so the preview is literal.
- **Join model:** server mark, name, hue, online count from the invite preview.
  The channel list and messages are **placeholder shapes** (rounded bars, no
  text) because the invite preview does not and must not reveal channel names
  or messages to non-members; the main area is blurred as in the prototype.
  This is the one deliberate deviation from the prototype.
- Before an invite is chosen on the join path the preview is desaturated and
  dimmed (`saturate(.2) brightness(.6)`).
- The dock shows the server mark (selected underline) and the account avatar
  once Your name is typed.

### 1.10 "What's protected" sheet

Centered sheet 560 wide, radius 24, `#17181b`-equivalent token, scrim
`rgba(5,6,8,.55)`. Title "What's protected", sub "These are on for everyone from
the start. You can change the ones with a switch later in Settings." Rows:

| Row | Right side | Source / action |
|---|---|---|
| Private messages — End-to-end encrypted. Only the people in the chat can read them. | lock + "Always on" | static |
| Voice, video and screen share — End-to-end encrypted on every call. | lock + "Always on" | static (native media E2EE, docs/encryption.md) |
| *(host)* Stored messages and files — copy by key source (§4.6) | lock + "On" | `host_status.storage` |
| *(host)* Who can join — Only people with an invite link you made. | "Invite only" | `registration_mode` |
| Link previews — The server fetches them, so websites never see your address. | switch (on) | user setting `link_previews` (§8.3) |
| Show what I'm playing — Off until you turn it on. | switch (off) | `activityDetectionEnabled` (§8.4) |
| *(host)* Daily backups — Kept on this computer for 14 days. | switch (on) | `PATCH /admin/backups` (§8.5) |

Switches apply immediately (the account exists by the time the sheet can open)
and show an inline error on failure, reverting the switch. Done closes. The
same sheet is reachable later from Settings › Privacy ("What's protected").

### 1.11 "Let friends in" sheet (router refused / no answer)

"Let friends in" / "Your router blocked the automatic setup. You can open the
way yourself in about two minutes." (no-answer variant: "Your router didn't
answer the automatic setup. …"). Ordered steps:
1. "Open your router's page at `{gateway_ip}` and sign in. The password is often
   on a sticker on the router." (`gateway_ip` from §5; when unknown: "Open your
   router's page (usually `192.168.0.1` or `192.168.1.1`) …")
2. "Find **Port forwarding**. It is sometimes under Advanced or NAT."
3. "Forward port `{port}`, both TCP and UDP, to this computer: `{lan_ip}`."

Then "Paracord checks again every minute and tells you when friends can get in.
Until then, people on your home network can still join." **Got it** closes.

The shared-address variant (§5.4) has its own body; it gives no port steps.

### 1.12 Sign in (`sign-in`, not in the prototype; same frame)

"Sign in" / "Use the server address or an invite link from your server."
Fields: Server (address or invite; prefilled from deep link/clipboard/join
step; the trust row from §1.5 appears under it once probed), Username or email,
Password. "Forgot your password? **Use your recovery phrase**" (→ §3.8 flow in
the same frame). On submit: §3.3 sign-in. MFA: a 6-digit code field slides in
with "Enter the code from your authenticator app." Legacy account (v1): the
migration screen (§3.11). Success goes to the app (no phrase screen unless
`recovery_confirmed` is false). The preview shows the server (host-less join
model) once probed.

### 1.13 Host › Invite (`h-invite`) and Done

"Invite your friends" / "Anyone with this link can join **{name}**. It opens in
Paracord, or in any browser."

- Link row (56 tall): the invite URL `{share_url}/invite/{code}` + cream chip
  **Copy link** → "Copied" (green tint) for 1.6 s.
- `share_url` comes from the share address (§5.6): the router-reported public
  address when reach is `internet`, else the LAN address with the amber note
  "Works on your home network until your router lets friends in. Paracord keeps
  trying." The link updates live if reachability changes while this screen is
  open (gateway event, §5.5).
- QR (132 px, cream, `CordMark size=28` centered in a 36 px dark tile) encodes
  the same https link (`qrcode` package, error correction H so the center mark
  does not break decoding).
- Options: "Expires in 7 days" **Change** (menu: 1 hour, 1 day, 7 days — 7 days
  is the server maximum, `MAX_INVITE_AGE_SECONDS`, `routes/invites.rs:20-21`);
  "Up to 25 people" **Change** (1, 5, 10, 25, 100); "Scan with a phone to join
  there"; "You can find this link again under Invite." Changing an option
  revokes the old invite and creates a new one.
- The invite is created when this screen first appears:
  `POST /guilds/{id}/invites {max_age: 604800, max_uses: 25}`.
- Primary "Open {name}" finishes.

**Done** (both paths): the flow column fades left 40 px; the preview grows from
its .5 rect to the full window (FLIP, 360 ms spring, radius 28 → 0); at the end
the real `AppShell` (mounted underneath at opacity 0 once the phrase step was
reached) crossfades in over 120 ms and the preview unmounts. Toast (Index toast,
§5.18): host "{name} is live", join "You joined {server}". Route lands on the
server's `general` channel.

### 1.14 Routes

| Route | Page |
|---|---|
| `/welcome` | First run (desktop: when there are no servers; web: only reached from `/invite/:code` and `/setup-server`) |
| `/welcome/host/:step`, `/welcome/join/:step`, `/welcome/sign-in` | Steps; the step in the URL is for back/forward and tests, the state lives in `firstRunStore` |
| `/setup-server` | Claim mode of the host flow for a headless install (§2.11) |
| `/invite/:code` (web) | Join flow on the server's own page (§6.6) |
| `/connect` | Desktop with no servers → `/welcome`; otherwise the dock's Add server sheet, Join tab |
| `/setup` | Only the v1 → one-password move (§3.11); no longer reachable from DMs |
| `/unlock`, `/recover` | Unlock with the one password; recovery phrase flow (§3.8) |

`OnboardingWizard` (`components/onboarding/OnboardingWizard.tsx`) and the
"Set up encryption" composer link (`MessageInput.tsx:1613`) are retired.

---

## 2. Hosting from the desktop app

### 2.1 What ships

- A second binary target in `crates/paracord-server`: **`paracord-host`**,
  the same `main` as `paracord-server` with two differences: on Windows it is
  built with `windows_subsystem = "windows"` (no console window when Task
  Scheduler starts it), and it accepts `--log-file` (all builds accept it; the
  host profile always passes it). It embeds the web UI like the server does.
- The desktop bundle carries it as a Tauri sidecar:
  `tauri.conf.json › bundle.externalBin: ["binaries/paracord-host"]`, built per
  target triple (`binaries/paracord-host-x86_64-unknown-linux-gnu`,
  `-aarch64-apple-darwin`, `-x86_64-apple-darwin`,
  `-x86_64-pc-windows-msvc.exe`). Today nothing is bundled
  (`tauri.conf.json` has no `externalBin`; `installer/paracord-client.iss:39`
  ships only `paracord-desktop.exe`). The Inno Setup script adds the sidecar.
- Release workflow (`.github/workflows/release.yml` desktop jobs at L415, L523,
  L634): build `client/dist` → build `paracord-host` for the bundle target →
  copy into `client/src-tauri/binaries/` → `tauri build`. Server archives stay
  as they are.
- Dev: `client/scripts/stage-host-sidecar.mjs` builds a debug `paracord-host`
  and stages it. `tauri dev`/`tauri build` fail with a clear message if the
  file is missing ("run npm run host:stage").

### 2.2 Where things live

Host root = Tauri `app_local_data_dir()/host`:

| OS | Host root |
|---|---|
| Linux | `$XDG_DATA_HOME/com.paracord.desktop/host` (default `~/.local/share/com.paracord.desktop/host`) |
| macOS | `~/Library/Application Support/com.paracord.desktop/host` |
| Windows | `%LOCALAPPDATA%\com.paracord.desktop\host` |

This never collides with `scripts/install.sh` (`/opt/paracord` or
`~/.local/share/paracord`, L348-356), `install.ps1` (`%ProgramFiles%\Paracord` or
`%LOCALAPPDATA%\Paracord`, L313-321) or the owner's installed client
(`~/.local/share/paracord-client`).

```
host/
  bin/paracord-host[.exe]           stable path (firewall rules and keychain ACLs key on it)
  bin/paracord-host.previous[.exe]  the binary before the last update
  config/paracord.toml              0600, absolute paths only
  config/first-owner-claim.txt      0600, exists until the claim (server deletes it)
  config/host-control.token         0600, 32 random bytes base64url (§2.5)
  data/paracord.db                  SQLCipher
  data/uploads/ data/files/         AES-GCM files (PRCENC02)
  data/backups/                     daily, 14 kept
  data/certs/cert.pem key.pem       self-signed (rcgen), key 0600
  logs/server.log (+ .1 … .7)       daily rotation, 7 kept
  storage-key.escrow                §4.7
```

App-side state: `app_local_data_dir()/host.json` (0600):
`{ version: 1, enabled, port, installed_version, setup: { completed_steps[] }, autostart }`.
Directories are created 0700 on Unix; on Windows they inherit the user profile ACL.

### 2.3 Preflight (`host_preflight`)

Runs when the user picks Host. Returns `{ ok: true, port } | { ok: false, reason, detail }`.
Each reason has fixed copy on the Name screen (blocking notice, no Continue):

| Check | Reason code | Copy |
|---|---|---|
| Linux: `systemctl --user show-environment` succeeds (a systemd user manager exists) | `no_user_services` | "Hosting from this computer needs systemd user services, which this system doesn't run. You can still host with the server installer: paracord.chat/docs/host." |
| OS keychain answers a write/read/delete roundtrip under a probe entry (Secret Service on Linux via D-Bus; Keychain; Credential Manager) | `no_keychain` | "Paracord keeps the key that encrypts your server in your system keychain, and this computer doesn't have one running. Install or turn on GNOME Keyring or KWallet, then try again." |
| A Paracord server already answers `/health` with `service:"paracord"` on 127.0.0.1:8443 (e.g. an `install.sh` server) | `existing_server` | "Paracord is already running on this computer." + cream **Use it** (→ Sign in with `https://127.0.0.1:8443`) |
| Host root already holds a configured server (`host.json.enabled`) | `already_hosting` | never blocks: the flow resumes at the first incomplete setup row |
| Port: 8443 TCP+UDP bindable on 0.0.0.0; else the first free in 8444–8463 | `no_port` | "Every port Paracord could use (8443 to 8463) is taken." |
| Disk: ≥ 1 GiB free under the host root | `no_space` | "This computer needs at least 1 GB free to host a server." |

The `no_keychain` refusal is deliberate: no key file fallback for the desktop
host (§4.2).

### 2.4 Background service

Installed by the new crate **`crates/paracord-hostctl`** (library, used by the
Tauri app; integration-tested per OS in CI, §plan S8). Names never collide with
the installers' (`paracord.service`, Scheduled Task `Paracord Server`).

**Linux, systemd user unit** `~/.config/systemd/user/paracord-host.service`:

```ini
[Unit]
Description=Paracord on this computer
After=default.target

[Service]
Type=exec
WorkingDirectory=<host>
ExecStart=<host>/bin/paracord-host -c <host>/config/paracord.toml --log-file <host>/logs/server.log
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
Nice=5

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload`, `systemctl --user enable --now
paracord-host.service`. It starts when the user signs in to the computer (not at
boot: lingering is not enabled, because the Secret Service keyring is only
unlocked in a signed-in session). The UI says "starts when you sign in to this
computer".

**Windows, per-user Scheduled Task** `\Paracord\Paracord on this computer`,
registered with `schtasks /Create /XML <file> /TN … /F` (no elevation): a
`LogonTrigger` for the current user, principal `InteractiveToken`,
`LeastPrivilege`; settings `MultipleInstancesPolicy=IgnoreNew`,
`DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`,
`ExecutionTimeLimit=PT0S`, `RestartOnFailure` interval `PT1M` count 999,
`Priority=7`; action `<host>\bin\paracord-host.exe -c … --log-file …`, working
directory `<host>`. Started with `schtasks /Run`. Firewall: one elevated
`netsh advfirewall firewall add rule name="Paracord on this computer"
dir=in action=allow program="<host>\bin\paracord-host.exe" protocol=TCP
localport=<port>` (and the same for UDP) through a single UAC prompt during row
1. Declining is not fatal: reachability reports `firewall_blocked` (§5.2) with
an **Allow** chip that asks again.

**macOS, LaunchAgent** `~/Library/LaunchAgents/com.paracord.desktop.host.plist`:
`Label`, `ProgramArguments`, `WorkingDirectory`, `RunAtLoad=true`,
`KeepAlive={SuccessfulExit=false}`, `ProcessType=Background`,
`StandardOutPath`/`StandardErrorPath` = `<host>/logs/launchd.log`. Loaded with
`launchctl bootstrap gui/<uid> <plist>` and `launchctl kickstart -k`. macOS 13+
shows its "Background Items Added" notice; that is expected and the setup
detail line already says it runs in the background.

All three: stopping = `systemctl --user stop` / `schtasks /End` /
`launchctl bootout`; autostart off = `disable` / task `Enabled=false` /
`launchctl disable gui/<uid>/<label>`.

### 2.5 The app ↔ host control channel

When `[host] enabled = true` (set only by the desktop-host profile), the server:

- writes `config/host-control.token` (0600) at every start (fresh 32 bytes);
- serves `/api/v1/host/*` (§9.1). Requests must come from a loopback peer
  address and carry `Authorization: Host <token>` (constant-time compare).
  Anything else → 401 `{code:"host_auth"}`.

The Tauri side reads the token from disk for each call; it never reaches JS.
The app reaches its own server at `https://127.0.0.1:<port>` (loopback is
always trusted by the pinning verifier, `client/src-tauri/src/lib.rs:695`). The
host's own app uses that loopback URL as its home server entry.

### 2.6 Setup orchestration

`host_setup_start({ port })` (Tauri command) runs these steps in Rust and emits
`host://progress` events `{ row, step, state: 'run'|'ok'|'warn'|'fail', detail?, code? }`.
Steps already in `host.json.setup.completed_steps` are skipped (resume).

| Row | Step | Work | Fail copy |
|---|---|---|---|
| 1 | `install` | Copy the sidecar (`current_exe().parent()/paracord-host`) to `<host>/bin/` via temp file + rename; chmod 0755 | "Couldn't copy Paracord's server files ({error})." |
| 1 | `init` | `paracord-host init -c <cfg> --profile desktop-host --root <host> --port <port>` (§2.7) — creates config, data dirs, TLS cert and the at-rest key in the keychain; exits non-zero with a reason line on failure | the reason line |
| 1 | `service` | §2.4 install + enable; Windows firewall rule | "Couldn't register Paracord to run in the background ({error})." |
| 1 | `start` | start the service, then poll `GET /health` on loopback every 250 ms for ≤ 30 s | "Paracord on this computer didn't start." + **Show details** |
| 2 | `storage` | `GET /host/status`; ok iff `storage.sqlite_encrypted && storage.files_encrypted && storage.key_source == "keychain"` | §1.7 |
| 3 | (JS) | §3: identity + credential in the KDF worker; `host_claim(...)` (Rust reads the claim file and posts §9.1 claim on loopback; returns the session to JS); publish prekeys; `host_write_escrow(wrapping_key)` (§4.7) | server error text |
| 4 | `reach` | poll `GET /host/status` every 1 s while `reachability.state == "asking"` (≤ 15 s); then map per §5.4 | — (warn only) |
| 5 | `backup` | `POST /host/backup-now`; ok when it returns the archive name | "The first backup didn't finish ({error})." |

Rows 2 and 4 are separate checks, not separate work: the key is created in
`init` (it must exist before the database does), and the router is asked by
the server at start. The rows report what the running server says, which is
the honest source.

### 2.7 The desktop-host profile (`init --profile desktop-host`)

`init` today writes the default config and exits (`main.rs` 3944-3960). The
profile writes, with absolute paths under `--root`:

Section and key names follow the generated template (`config.rs` 807-1103);
where a key below does not exist yet it is one of §9.4's additions.

```toml
[server]
bind_address = "0.0.0.0:<port>"
redirect_listener = false          # new: no plain-HTTP listener (§9.4)
server_name = "<hostname>"
[tls]       enabled = true, auto_generate = true, port = <port>, cert/key under data/certs
[voice]     port = <port>
[database]  url = "sqlite://<root>/data/paracord.db?mode=rwc"
[storage]   path, media_storage_path under data/
[auth]      registration_mode = "invite_only", require_email = false
[setup]     require_claim = true   # token file written as today
[at_rest]   enabled = true, encrypt_sqlite = true, encrypt_files = true,
            key_source = "keychain", keychain_service = "Paracord",
            keychain_account = "host-storage-key:<instance_id>"
[network]   auto_port_forward = true, reachability_retry_seconds = 60
[backup]    auto_backup_enabled = true, auto_backup_interval_seconds = 86400,
            max_backups = 14, include_media = true, backup_dir = <root>/data/backups
[host]      enabled = true, instance_id = "<uuid v4>",
            control_token_file = "<root>/config/host-control.token",
            escrow_file = "<root>/storage-key.escrow"
[link_previews] enabled = true
[federation] enabled = false
```

Then it generates the 32-byte at-rest key and stores it in the keychain (§4.2),
verifies by reading it back, and exits 0. Running `init` again on an existing
root is refused ("already initialized").

**The claim creates exactly what the preview showed:** instance name = server
name; one server with that name and `hue`; text channels `general`, `clips`,
`plans` with those topics; voice channels `Lounge`, `Gaming`. The claim request
carries `initial_space_template: "friends"` (new, §9.1); the template lives in
`paracord-core` next to `create_guild_full`.

### 2.8 Relaunch, update, supervision

- **App start with hosting enabled:** query service state (`systemctl --user
  is-active`, `schtasks /Query`, `launchctl print`). If inactive and autostart
  is on, start it. The app then connects to `https://127.0.0.1:<port>` like any
  home server. No background polling: status comes from the gateway
  (`INSTANCE_STATUS_UPDATE`, §5.5) and from `host_status` only while Settings ›
  "Paracord on this computer" or the setup screen is open.
- **Update:** when the bundled sidecar's version (`paracord-host --version`) is
  newer than `host.json.installed_version`: `POST /host/backup-now`; stop the
  service; move `bin/paracord-host` to `.previous`; copy the new one in; start;
  wait for `/health` ≤ 60 s. On failure the app shows a banner "Paracord on this
  computer didn't start after the update." with **Show details** (last 200 log
  lines via `host_logs_tail`) and **Restore the backup from before the update**
  (stops, restores via `paracord-host restore-backup`, puts `.previous` back,
  starts). It never silently reverts.
- **Crash:** the service manager restarts it (systemd 5 s; Task Scheduler 1 min;
  launchd immediately with throttling). Exit status 78 (storage key
  unavailable) is not restarted on Linux; the app shows "Paracord on this
  computer can't open its storage key: {reason}" with **Try again**.
- **Logs:** `--log-file` writes the same compact format as stdout (today stdout
  only, `main.rs` 248-260) with daily rotation, 7 kept. Never contains
  passwords, keys, claim or control tokens.

### 2.9 Settings › Paracord on this computer

Shown when `host.json.enabled`. Rows: status (Running / Stopped / Starting /
Can't start + reason), "Starts when you sign in to this computer" switch,
**Stop** / **Start**, reachability (§5.4 copy + "Show me how"), this server's
identity words (§7.1, so the owner can read them to friends), storage
encryption line (§4.6), backups (last backup time, **Back up now**), **Show
logs**, **Remove from this computer** (dialog: removes the service; a second
checkbox "Also delete the server's data" that requires typing the server name;
data is kept by default).

### 2.10 Conflicts

- Port taken after setup (another app grabbed it): server exits with a bind
  error; the status shows "Port {port} is in use by another program." The port
  is not silently changed (it is in every invite link).
- Two Paracord desktop installs for the same OS user share one host root by
  identifier; a second app instance is prevented by the single-instance plugin.

### 2.11 Headless installs use the same flow

`install.sh` / `install.ps1` keep opening `/setup-server#claim=<token>`
(`InstanceSetupPage.tsx:93-109`). That route becomes the host flow in **claim
mode**: Name → Account → Setup → Phrase → Invite, without the launch, the
Welcome or row 1. Rows read from `GET /admin/host-status` after the claim
(storage row copy by key source, §4.6; a server without at-rest encryption shows
the row as **warn**: "Stored messages and files are not encrypted on this
server's disk." with a link to §4.8's command — honest, not a failure). The
claim token from the fragment is sent as today.

---

## 3. One password

### 3.1 What it must guarantee

- One password typed by the person; the server receives only a derived
  **auth key** and can never compute the **wrap key** that protects the
  identity private key.
- A new device signs in with username + password and gets its identity back
  (server-held wrapped backup). Today there is no server backup at all; the
  identity lives only in device `localStorage` (`identityKeystore.ts:5,43,52`)
  and the phrase is the only way to move it.
- The 24-word phrase stays what it is today: the identity private key itself
  (`account.ts:206-243`), so every existing phrase keeps working.
- Existing accounts move over without lockout; a server cannot push an
  upgraded account back to the old scheme.

### 3.2 Derivation

```
pw      = UTF-8(NFKC(password))                          # client-side, never sent
salt    = 32 random bytes, per credential (server-stored, public)
master  = scrypt(pw, SHA-256("paracord/credential/v2/salt" || salt),
                 N = 2^17, r = 8, p = 1, dkLen = 32)
auth_key = HKDF-SHA256(ikm=master, salt=empty, info="paracord/credential/v2/auth", L=32)
wrap_key = HKDF-SHA256(ikm=master, salt=empty, info="paracord/credential/v2/wrap", L=32)
```

- **KDF choice: scrypt**, the same parameters the client already uses for the
  identity wrap (`account.ts:29-32`, `@noble/hashes/scrypt.js`), 128 MiB. No new
  dependency and one implementation on desktop and web. Argon2id was
  considered; there is no audited pure-JS Argon2 fast enough at this memory
  cost without adding a WASM dependency, and the security difference at these
  parameters is small.
- Runs in a dedicated Web Worker (`lib/credential/kdf.worker.ts`, `scryptAsync`)
  so the UI and CordMark stay smooth; the worker is terminated after each use
  so the 128 MiB is returned.
- **Parameter floor:** the client refuses any server-supplied parameters below
  `N=2^17, r=8, p=1` ("This server asked for weaker protection than Paracord
  allows.") and accepts higher up to `N=2^20`. Parameters are stored per
  credential as `"scrypt:17:8:1"` (log2 N).
- `auth_key` and `wrap_key` are independent HKDF outputs; knowing `auth_key`
  does not give `wrap_key`.

### 3.3 Sign-up and sign-in

**Sign-up** (join: row 3; host: row 3 via claim):
1. Generate the identity (Ed25519, `account.ts:93`) and its phrase.
2. Generate `salt`; derive `auth_key`, `wrap_key` (worker).
3. `wrapped_key = base64url(iv12 || AES-256-GCM(wrap_key, iv, identity_sk,
   aad = "paracord/identity/v2|" + public_key_hex))`.
4. `POST /auth/challenge` (existing, `routes/auth.rs:3850`); sign
   `"paracord/credential/v2/register:" + nonce + ":" + timestamp + ":" + origin`.
5. `POST /auth/credential/register` (or the claim, §9.1) with
   `{ username, display_name, email?, invite_code?, credential: { salt, kdf, auth_key },
      identity: { public_key, wrapped_key, wrap_alg: "aes256gcm-v2", proof } }`.
   The server verifies the proof against `public_key`, stores everything in one
   transaction, joins the invite's server (as `register` does today with
   `invite_code`), and returns the session (`AuthResponse`).
6. Save the v2 keystore locally (§3.5); publish prekeys (existing enrollment).

**Sign-in:**
1. `POST /auth/credential/params { identifier }` → `{ version: 2, kdf, salt, epoch }`
   or `{ version: 1 }`. For unknown identifiers (and key-only accounts) the
   server answers `version: 2` with default `kdf` and a fake salt
   `HMAC-SHA256(HKDF(jwt_secret, "paracord/credential/fake-salt"), lower(identifier))`
   so existence is not revealed by this route.
2. Derive (worker). `POST /auth/credential/login { identifier, auth_key }` →
   the same response shape as `/auth/login` today, including the MFA ticket
   branch (`auth.rs:1478-1512`; `/auth/mfa/login` unchanged).
3. `GET /users/@me/key-backup` → unwrap with `wrap_key`; check the derived
   public key equals `public_key` and equals any locally pinned public key for
   this account (§3.13); save the v2 keystore; done. Prekeys: the existing
   `DEVICE_NOT_ENROLLED` / replace logic (`prekeyEnrollment.ts:186,228`) applies
   unchanged for a second device.

Remote servers keep authenticating by identity key (`connectionManager.ts`
1449-1508, `/auth/verify` auto-registration). Only the **home** server holds
the password credential and the backup.

### 3.4 Server storage

`users` gains `credential_version` (0 key-only, 1 legacy password, 2 one
password), `credential_salt`, `credential_kdf`, `credential_epoch`.
`password_hash` holds `Argon2id(auth_key)` (PHC, the existing
`paracord-core/src/auth.rs:75-89` hasher) for version 2. A database thief must
run scrypt + Argon2 per password guess. New table `account_key_backups`
(§9.3). Server-side validation for v2: `auth_key` exactly 32 bytes;
`salt` exactly 32 bytes; `kdf` parses and meets the floor; `wrapped_key`
decodes to 12 + 48 bytes; `public_key` 32 bytes hex and the proof verifies.

Password rules: the server can no longer see the password, so composition and
length checks move to the client (§1.6). `GET /setup/password-requirements`
(`routes/setup.rs:85-95`) answers `{ min_length: 10, max_length: 128,
requires_uppercase/lowercase/digit/symbol: false, length_unit: "utf8_bytes",
enforced_by: "client" }` for v2 servers.

### 3.5 Local keystore v2 and unlock

`AccountKeystore` v2 (`identityKeystore.ts`, key `paracord:encrypted-identity:v2`):
`{ version: 2, homeOrigin, userId, username, publicKey, wrappedKey, kdf, salt, epoch }`
— the same blob as the server backup. Unlock = derive from the password →
unwrap locally (works offline). If the local unwrap fails, the client asks the
server for `params`; a newer `epoch` means the password changed elsewhere: sign
in with the typed password, fetch the backup, replace the local keystore.

**Desktop: remembered unlock.** After a successful unlock the desktop app
stores the identity private key in the OS keychain (`secure_store_*`,
`commands.rs:463-570`) under `paracord:identity:<homeOrigin>:<userId>`, so a
relaunch unlocks without a prompt. Settings › Privacy has "Ask for my password
when Paracord opens" (off by default; this replaces "Device crypto security",
`crypto_auth_enabled`, `UserSettings.tsx:1505-1509`; when on, the keychain
entry is deleted and `/unlock` is required at launch as today,
`App.tsx:121-216`). The web never persists the key; a new tab asks for the
password. *(Owner question 1 in the plan.)*

The local vault keyed from the identity (`accountVault.ts:85-90`) is unchanged.

### 3.6 Recovery phrase

Unchanged encoding: 256-bit identity private key + 8 checksum bits → 24 words
from `lib/bip39-wordlist.ts` (`account.ts:206-243`; the legacy XOR checksum is
still accepted by `recoverFromPhrase`). Shown once in setup (§1.8);
Settings › Identity › "Show recovery phrase" requires the password again.
`account_key_backups.recovery_confirmed` records the checkbox so any device can
re-show §1.8 until it is confirmed.

### 3.7 Changing the password

`PUT /users/@me/credential { current_auth_key, credential: { salt', kdf, auth_key' },
wrapped_key', mfa_code? }`: verifies `current_auth_key` (and MFA when enabled),
then in one transaction replaces the hash, salt, kdf and the backup, increments
`credential_epoch`, and revokes the account's other sessions. Unlike the legacy
path (`paracord-db/src/users.rs:1070-1104`, which sets `public_key = NULL`), it
keeps the identity. Other devices: their next unlock with the new password
takes the online path in §3.5. The legacy `PUT /users/@me/password` answers 409
`credential_upgraded` for v2 accounts.

### 3.8 Forgot password (recovery phrase)

`/recover` (same frame as sign-in): phrase → identity key (existing parser) →
key sign-in to the home server through `/auth/challenge` + `/auth/verify`
(existing; MFA gate applies, `auth.rs:4030-4064`) → choose a new password →
`POST /users/@me/credential/reset { credential, wrapped_key, proof, mfa_code? }`
where `proof` signs a fresh challenge with purpose
`"paracord/credential/v2/reset"`. The server checks the signature against
`users.public_key`, replaces the credential and backup, increments the epoch,
revokes other sessions.

### 3.9 Email reset

`/auth/reset-password` (`auth.rs:3120`) stays for servers with email. For a v2
account it requires a brand-new identity
(`{ token, credential, identity: { public_key, wrapped_key, proof } }`) because
the server cannot restore the old one. The UI calls this **Start over**: "Your
old private messages can't be opened with a new password. Use your recovery
phrase instead if you have it." It replaces `public_key`, deletes the old
prekeys and backup, bumps the epoch (today's reset also clears `public_key`,
`users.rs:1034-1068`).

### 3.10 Server-side checks summary

| Route | v0 key-only | v1 legacy | v2 one password |
|---|---|---|---|
| `POST /auth/login` (legacy) | 401 | as today | 409 `credential_upgraded` |
| `POST /auth/register` (legacy) | — | 410 `client_update_required` (new servers create only v2) | — |
| `POST /setup/claim` (legacy) | — | 410 `client_update_required` | — |
| `POST /auth/credential/login` | 401 (fake params) | 409 `credential_legacy` | ok |
| `POST /auth/credential/upgrade` | 409 | ok (§3.11) | 409 `credential_upgraded` |
| `PUT /users/@me/password` | — | as today | 409 `credential_upgraded` |
| `PUT /users/@me/credential` | 409 | 409 `credential_legacy` | ok |
| `/auth/verify` key sign-in | ok | ok | ok |

Old clients show the server's `message` for 409/410:
`credential_upgraded` → "This account uses one-password sign-in. Update Paracord
to sign in."; `client_update_required` → "Update Paracord to create an account
on this server."

### 3.11 Moving existing (v1) accounts

Trigger: a v1 account signs in on a new client (params say `version: 1`). The
client shows a **distinct** screen first — "This account still uses two
passwords. Enter your current sign-in password." — and signs in with the legacy
`/auth/login` (raw password, as today). It never sends a typed password to the
legacy route from the normal sign-in form (§3.13). Then "Paracord now uses one
password" (route `/setup`, rebuilt):

| Account state | What the person does |
|---|---|
| Identity on this device (v1 keystore) | Unlock it with the encryption password if not unlocked. Primary choice: **Use my encryption password as my only password** (allowed only if it differs from the sign-in password just typed); or choose a new one |
| Account has `public_key`, this device has no identity | Enter the recovery phrase (must match `public_key`) or "Finish on the device that has your keys". Until then the account stays v1 and works as today |
| No identity anywhere (`public_key` NULL) | Choose the one password; a new identity is made; §1.8 phrase screen follows |

Rule: **the new one password must differ from the legacy sign-in password**,
because the server has received that one in plaintext; the client compares
locally and says "Pick a password you haven't used to sign in to this server
before. The server has seen that one." Then
`POST /auth/credential/upgrade { current_password, credential, identity: { public_key,
wrapped_key, proof } }` in one transaction: `credential_version: 1 → 2` with
`WHERE credential_version = 1`, new hash, salt, kdf, epoch 1, backup row,
`public_key` set if it was NULL (a proof is required either way). Sessions are
kept. Until the upgrade commits nothing changes, so a failure at any point
leaves a working v1 account.

### 3.12 Mixed versions

| Client | Server | Behavior |
|---|---|---|
| new | new | v2 everywhere; v1 accounts move on first sign-in (§3.11) |
| new | old (no `/auth/credential/params` → 404 empty body) | `noteMissingRoute(serverId, 'oneCredential')`. **First run** (join/host claim) refuses with `olderServerReason`: "{server} runs an older version of Paracord. Ask the person who runs it to update, then try again." **Sign in** to an existing account on that server uses the legacy pages unchanged (password sign-in, separate unlock), with a persistent line in Settings › Account: "This server runs an older Paracord, so it still uses two passwords." Choice made from the detected version, never from a failed attempt |
| old | new | v1 accounts sign in as before; v2 accounts get 409 with update text; legacy register/claim get 410; key sign-in (`/auth/verify`) keeps working for both, so existing devices of upgraded accounts stay connected |
| web | its server | always the same version (embedded UI) |

The invite preview carries `instance.credential_version` (§6.1) so the join
step can refuse an old server before any account work.

### 3.13 Downgrade resistance

- `credential_version` only increases: every write is a conditional
  `UPDATE … WHERE credential_version = <expected>`; no route lowers it; the
  legacy password routes refuse v2 accounts (§3.10).
- The client pins, per `(homeOrigin, userId)`, `credentialVersion: 2`, the KDF
  floor, and the identity public key (in the v2 keystore and in a small
  versioned record that survives sign-out). A server that later answers
  `version: 1` or weaker parameters for a pinned account is refused with "This
  server is asking for an older, weaker sign-in for an account that already uses
  one password. Paracord won't send it." and nothing is sent.
- The normal sign-in form never sends the typed password anywhere except into
  the KDF. The legacy route is only reached from the distinct §3.11 screen,
  which names the old sign-in password.
- Residual risk (documented in §10): on a brand-new device with no pin, a
  malicious server could claim `version: 1` and show the legacy screen; a person
  who types their one password there gives it away. The distinct wording and
  the fact that the legacy screen appears only once per account are the
  mitigation.

### 3.14 Test vectors

`client/src/lib/credential/vectors.json` (fixed password, salt, expected
`master`, `auth_key`, `wrap_key`, `wrapped_key` for a fixed IV, phrase ↔ key,
trust words ↔ fingerprint). Unit tests run them in Vitest; the server tests
consume the `auth_key`/proof vectors so both sides agree byte for byte.

---

## 4. Stored-data encryption with an automatic key

### 4.1 What exists and what is missing

`[at_rest]` (`config.rs` 454-478) takes a 32-byte key from an env var
(`key_env`, default `PARACORD_AT_REST_KEY`); `build_at_rest_profile`
(`main.rs` 1858-1924) derives the SQLCipher key and a file cryptor
(`paracord-util/src/at_rest.rs`: AES-256-GCM, `PRCENC02`). Missing:

1. **SQLCipher is not compiled in.** `sqlx` uses `libsqlite3-sys 0.30.1`
   without a SQLCipher feature (`Cargo.toml` L40); `paracord-db/src/lib.rs`
   214-231 errors "SQLCipher support is unavailable" when encryption is asked
   for. Fix: depend on `libsqlite3-sys = { version = "0.30", features =
   ["bundled-sqlcipher-vendored-openssl"] }` in `paracord-db` so feature
   unification gives sqlx SQLCipher on every target (Linux, macOS both arches,
   Windows MSVC and the `x86_64-pc-windows-gnu` cross build). A SQLCipher build
   opens plaintext databases normally when no key is set, so one build serves
   both.
2. No key sources other than an env var; no automatic key; no plaintext →
   encrypted migration; no escrow.

### 4.2 Key sources (`[at_rest] key_source`)

| Source | Where the key lives | Used by | Protection label |
|---|---|---|---|
| `keychain` | OS credential store of the user the server runs as, via the `keyring` crate with platform features (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows; the same feature set as `client/src-tauri/Cargo.toml` L34/63/105/131, never the mock store) | desktop host; macOS `install.sh` LaunchAgent | `login` (unlocked by the user's sign-in) or `machine` when the account is Windows `SYSTEM` |
| `systemd-creds` | `systemd-creds encrypt` file loaded with `LoadCredentialEncrypted=paracord-at-rest-key:<path>`; read from `$CREDENTIALS_DIRECTORY/paracord-at-rest-key` | `install.sh` as root on systemd ≥ 250 | `tpm` when the installer sealed with TPM2 (`systemd-creds has-tpm2`), else `machine` (recorded as `[at_rest] protection`) |
| `file` | `key_file`, must be 0600 (Unix) / ACL'd to the server account (Windows), owned by the server user | non-root `install.sh` on Linux; `install.ps1` | `same_disk` |
| `env` | `key_env` variable | Docker, existing configs | `same_disk` |

Rules:
- The source is **explicit in the config**. An existing config with
  `enabled = true` and no `key_source` means `env` (that is what it meant before;
  not a fallback).
- If the configured source cannot produce a valid 32-byte key at start, the
  server exits with status **78** and one line naming the source and the reason
  (e.g. "at-rest key: the system keychain is locked or not running (Secret
  Service: …)"). It never starts unencrypted when `enabled = true`.
- The keychain entry: service `keychain_service` ("Paracord"), account
  `keychain_account` (`host-storage-key:<instance_id>`), value `hex:<64 hex>`
  (`parse_master_key`, `at_rest.rs:235-256`).
- A plain first run with no installer (`paracord-server` in a directory)
  generates config with `enabled = true` and `key_source = "keychain"` when the
  keychain roundtrip probe succeeds at generation time, otherwise
  `key_source = "file"` with `key_file = <config dir>/at-rest.key` and the
  label `same_disk` (said in the banner and in admin status). This is a
  decision written into the config once, at generation, not a runtime fallback.
- Docker (`docker-entrypoint.sh`): unchanged — at-rest stays off unless the
  operator sets `PARACORD_AT_REST_ENABLED=true` and a key env; admin status
  shows it off (§4.6).

### 4.3 Generation

`init --profile desktop-host` and the plain first run generate 32 bytes from
`OsRng`, store them in the chosen source, read them back and compare, and only
then write `enabled = true` to the config. The installers do the same for their
sources (S14 in the plan).

### 4.4 Boot

`build_at_rest_profile` gains `resolve_key(source) -> Result<[u8;32], KeyError>`;
SQLCipher key and file cryptor derivation are unchanged. The TOTP cryptor
(`main.rs` 1904-1910) is created as today, so **MFA works on every at-rest
server**. The refusal in `routes/auth.rs:3286-3294` stays for servers that are
public and unencrypted, with new text: "Two-factor sign-in needs this server's
stored data to be encrypted. Run `paracord-server encrypt-storage` (see
docs/encryption.md)."

### 4.5 Status

`HostStatus.storage` (§9.2): `{ enabled, sqlite_encrypted, files_encrypted,
key_source, protection }`. `sqlite_encrypted` is checked at boot with
`PRAGMA cipher_version` on the live pool, not read from config.

### 4.6 Copy by protection label

| Label | "Stored messages and files" detail |
|---|---|
| `login` | Encrypted on this computer's disk. The key lives in your system keychain. |
| `tpm` | Encrypted on disk. The key is sealed to this machine's security chip. |
| `machine` | Encrypted on disk. The key is protected by this machine's own credentials. |
| `same_disk` | Encrypted on disk, with the key stored on the same disk. This protects backups copied elsewhere, not a stolen disk. |
| off | Not encrypted on this server's disk. (warn) |

### 4.7 Escrow: the recovery phrase also restores the server

So that losing the keychain (OS reinstall, new computer) does not lose the
server, the owner's recovery phrase can unwrap the storage key:

```
escrow_key = HKDF-SHA256(ikm = owner identity private key,
                         salt = "paracord/host-storage-escrow/v1",
                         info = instance_id, L = 32)
```

During host row 3 the app derives `escrow_key` and calls
`host_write_escrow` → `POST /host/storage-key/escrow { wrapping_key, owner_public_key }` (loopback,
host token). The server writes `storage-key.escrow`:
`{ version: 1, instance_id, owner_public_key, iv, ciphertext }` with AES-256-GCM,
AAD = `"paracord/host-storage-escrow/v1|" + instance_id`, and puts the same JSON
in every backup manifest (`BackupManifest.recovery`, `paracord-core/src/backup.rs`,
new field `key_escrow`). The endpoint accepts one call per instance and owner key
(409 `escrow_exists` after), and the wrapping key is not stored. `owner_public_key`
names the identity key the wrapping key was derived from; one that is not the
owner's current `users.public_key` is refused (409 `escrow_owner_mismatch`), so
an escrow is always sealed for the owner's current phrase (a backup from before
"Start over" opens with the old phrase, but cannot re-escrow under it). An escrow
on disk for another owner key or instance is stale and is replaced. Headless owners get the same escrow after
the claim (`POST /admin/storage-key/escrow`, owner only, same body).

### 4.8 Restore and plaintext migration (CLI + UI)

- `paracord-host restore-backup <archive> --escrow-key-stdin` (extends the
  existing `restore-backup` subcommand): unwraps the key from the archive's
  escrow, stores it in the configured source, restores. `paracord-server
  escrow-key --archive <archive>` reads the phrase on stdin, checks it against
  the escrow's owner key and prints `escrow_key` for a hand restore (S13b). The desktop UI path:
  Host › Name › "Restore from a backup instead" → pick the archive → enter the
  recovery phrase → the app derives `escrow_key` and runs preflight, `init`
  (restore mode) and the restore, then Setup rows 1, 2, 4, 5 (no claim).
- `paracord-server encrypt-storage -c <config> --key-source <src> [--key-file <p>]`
  for existing plaintext installs (server stopped; refuses if the port answers):
  backup → generate and store the key → `ATTACH … KEY "x'…'"` +
  `SELECT sqlcipher_export('enc')` → `PRAGMA cipher_integrity_check` and per-table
  row counts compared → atomic rename (the plaintext DB is deleted after
  verification; the docs note SSDs may keep old blocks) → files encrypted in
  place to `PRCENC02` via temp + rename with a resumable journal
  `data/.encrypt-storage.journal` → config updated (`enabled`, `encrypt_*`,
  `key_source`) → prints the escrow command. Rerunning after an interruption
  resumes.
- Existing installs are **not** migrated automatically. Admin › Settings shows a
  warn line with the command, and `install.sh` / `install.ps1` offer it on
  upgrade (plan S14).

---

## 5. Reachability

### 5.1 Today

`portmap.rs` tries UPnP IGD (`igd-next`), then NAT-PMP and PCP (`crab_nat`),
under an 8 s budget (L38, L346-351); renews at half the lease (L357-410)
without retrying on failure; reports `Mapped{external_ip}` /
`NotAvailable{reason}` / `Skipped` (L98-142). NAT-PMP reports no external IP,
filled from **`https://api.ipify.org`** (`main.rs` 183-189,
`with_fallback_ip`, L1151-1155) — a third-party service, which the owner ruled
out. A mapped router reporting a private address is treated as reach
`internet` (`share_address_for`, `main.rs` 3616-3660). Status is only logged.

### 5.2 States

`paracord_core::reachability` (new) holds the current `Reachability`:

| State | Meaning | Detected by |
|---|---|---|
| `off` | auto forwarding disabled or loopback bind | config |
| `asking` | an attempt is in flight | — |
| `open` | router accepted both mappings and reported a **public** external IPv4 | mapping ok + external IP not in the private set below |
| `shared_address` | router accepted (or answered) but its external address is private: `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (carrier-grade NAT), `169.254/16` | external IP classification |
| `refused` | a gateway answered and refused (UPnP SOAP fault, NAT-PMP/PCP result code ≠ 0) | protocol error codes |
| `no_answer` | no IGD/NAT-PMP/PCP gateway answered within the budget | timeout on all three |
| `direct` | the bind interface itself has a public IPv4 (no NAT in front) | local interface classification |
| `firewall_blocked` | Windows only: the firewall rule is missing (UAC declined) | `netsh advfirewall firewall show rule` |

Plus fields: `method` (`upnp|nat-pmp|pcp`), `external_ip?`, `gateway_ip?`,
`lan_ip?`, `port`, `lease_expires_at?`, `next_retry_at?`, `last_error?`,
`confirmed_at?`.

- The external IP comes **only from the router**: UPnP `GetExternalIPAddress`,
  PCP's response, and for NAT-PMP an explicit external-address request
  (opcode 0, RFC 6886 §3.2; implemented in `portmap.rs` if `crab_nat` 0.8 does
  not expose it). `detect_external_ip` and every ipify call are deleted; the TLS
  SAN list (`tls.rs` 425-443) uses the router-reported address when known.
- `confirmed_at` is set when the server accepts a TLS connection whose peer
  address is a public IP that is not this network's own external address. It
  is the only thing that upgrades copy to "A friend connected from outside".

### 5.3 Transitions

`asking → open | shared_address | refused | no_answer` (and `direct` when no
NAT, checked first). While `refused`, `no_answer` or `shared_address`: retry
every `reachability_retry_seconds` (60). While `open`: renew at half the lease;
a failed renewal → `refused`/`no_answer` with retry, and the share address
falls back to the LAN address (that is a fact change, announced). A changed
external IP on renewal updates `external_ip`, the share address and announces
it. "Try again" (`POST …/reachability/retry`) runs an attempt now.

### 5.4 Copy

| State | Row 4 (setup) | Elsewhere (Settings, Invite sheet) |
|---|---|---|
| `open` | ok — "Your router opened the way. Friends can reach you at {ip}." | same; with `confirmed_at`: "A friend connected from outside {relative time}." |
| `direct` | ok — "This computer has its own public address ({ip}). Friends can reach it if your firewall allows port {port}." | same |
| `refused` | warn — "Your router didn't allow it, so for now only people on your home network can join." chips Show me how / Try again | same + "Paracord checks again every minute." |
| `no_answer` | warn — "Your router didn't answer, so for now only people on your home network can join." chips | same |
| `shared_address` | warn — "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join." chip **What can I do?** → sheet: ask your provider for a public IPv4 address, or, if another router sits in front of yours, forward the port on that one too | same |
| `firewall_blocked` | warn — "Windows Firewall is blocking friends." chip **Allow** | same |
| `off` | (row not shown in claim mode when off; desktop host never has it off) | "Paracord isn't asking your router to let friends in." + switch |

Never: "Friends can reach you" without `open`/`direct`; never a claim based on
anything but router answers and observed connections.

### 5.5 Exposure

- `HostStatus.reachability` via `GET /host/status` (loopback) and
  `GET /admin/host-status` (admins).
- Gateway dispatch `INSTANCE_STATUS_UPDATE { reachability, storage, backups }`
  to members with the admin flag whenever any field changes.
- `GET /instance/share-address` (`routes/invites.rs:239-245`) derives `reach`
  from the state: `open|direct → internet`, `refused|no_answer|shared_address|
  firewall_blocked → local_network`, loopback → `this_computer`.

### 5.6 Share address

`share_address_for` becomes a function of `Reachability`:
`open/direct → https://{external_ip}:{port}`, else `https://{lan_ip}:{port}`,
operator `public_url` still wins. Invite links embed this address. When the
ISP changes the public IP, links made earlier stop working; the Invite screen
and sheet always show the current link and, after a change, the line "Your
public address changed. Links you shared before won't work; share this one."
(no dynamic DNS: it would need a third-party service).

---

## 6. Invites, deep links, clipboard

### 6.1 Invite preview (public)

Extend `GET /api/v1/invites/{code}` (`routes/invites.rs:292-344`, contract
`paracord-contracts/src/invite.rs` 19-54). New fields:

```rust
pub struct InvitePreview {
    pub code: String,
    pub guild: Option<InviteGuild>,      // + hue: Option<i16>, + online_count: u32
    pub join_gate: Option<InviteJoinGate>,
    pub faces: Vec<InviteFace>,          // ≤ 3
    pub expires_at: Option<String>,      // RFC 3339
    pub instance: InviteInstance,        // new
}
pub struct InviteFace { pub initial: String, pub hue: i16 }
pub struct InviteInstance {
    pub name: String, pub version: String,
    pub credential_version: u8,          // 2 on servers with one-password sign-up
    pub registration_mode: RegistrationMode, pub require_email: bool,
}
```

- Faces: up to three non-bot members, online first (presence manager), then
  most recently joined; only the first grapheme of the display name and the
  avatar hue — no names, ids or images.
- `online_count` from the presence manager; `member_count` as today.
- Absent `instance` = an older server (§3.12).

### 6.2 Rate limits

New bucket in `rate_limit_middleware` (`paracord-api/src/lib.rs` 1814-1910) for
`GET /api/v1/invites/*`: 30/min per IP (IPv6 /64). Each 404 from that route
records a failure in a dedicated counter (`rate_limits::increment_distinct_window_counter`,
`invites.rs:526-536`); 20 misses in 10 min → 429 for 10 min for that IP. Codes
stay 8 characters (`core/guild.rs:51-60`).

### 6.3 Invite defaults and parsing

- `CreateInviteRequest` defaults (`paracord-contracts/src/invite.rs` 77-92):
  `max_age` 86400 → **604800**, `max_uses` 0 → **25**. `InviteModal.tsx`
  defaults match.
- One parser, `client/src/lib/inviteLinks.ts` (moved from
  `ServerConnectPage.tsx:42-64` + `lib/portableLinks.ts`): accepts
  `paracord://invite/<base64url(serverUrl|code)>`, `https://host[:port]/invite/CODE`,
  `host[:port]/invite/CODE`. Plain `http` only for loopback. Returns
  `{ serverUrl, code }` or null. `useAddServer.ts:32` (`inviteCodeOf`, last path
  segment only) switches to it, so the dock's Join tab accepts links to other
  servers.

### 6.4 Deep links

Today the Rust side emits `deep-link` with the raw URL (`lib.rs` 1675-1709;
cold start 1893-1896, running 1900-1903) and no JS listens.

- Rust keeps a `PENDING_DEEP_LINKS` queue filled by every source, and exposes
  `take_pending_deep_links() -> Vec<String>`; events still fire for links that
  arrive while running.
- JS `lib/deepLinks.ts`, installed in `main.tsx` before the router mounts:
  drains the queue once, then listens. `paracord://invite/…` → if the first run
  is active or there are no servers: `/welcome/join/invite` with the invite
  filled and the preview fetched; otherwise the Add server sheet's Join tab with
  the invite card. `paracord://server/<host>` → Sign in with the server
  prefilled. Anything else → toast "That link isn't a Paracord invite."
- Linux packages declare `x-scheme-handler/paracord` (Tauri deep-link config);
  AppImage registers at runtime (`register_all`, L1888-1891, unchanged).

### 6.5 Clipboard

- Desktop: `tauri-plugin-clipboard-manager` (new; Rust + JS) `readText` on
  Welcome mount, on window focus while Welcome or the Join step is visible and
  the field is empty. Only the parser's result is kept; nothing is logged,
  stored or sent. Web: never read automatically.
- Writes keep using `lib/clipboard.ts`.

### 6.6 Web join

`/invite/:code` on the server's own web UI renders the join path (Invite step
pre-resolved and read-only, Account, Setup rows 2–3, Phrase, Done) with an
"Open in the Paracord app" text button (the `paracord://` link from
`toPortableUri`). The trust row is replaced by "You're on {host}." (the browser
has already done TLS).

---

## 7. Server identity

### 7.1 Trust words

```
fp    = SHA-256(leaf certificate DER)                # the existing pin (lib.rs 698)
h     = SHA-256(UTF-8("paracord/trust-words/v1") || fp)
words = BIP39 English[ h bits 0–10 ], [11–21], [22–32], [33–43]   # 44 bits, big-endian
shown = words joined with " · "
```

One implementation: `client/src/lib/trustWords.ts` (reuses
`lib/bip39-wordlist.ts`). Rust exposes fingerprints only. The host's own words
come from `HostStatus.tls.fingerprint_sha256`; headless admins see them in
Admin › Settings from `GET /admin/host-status`.

44 bits is for a person comparing four words with a friend; the pin itself is
the full 256-bit fingerprint (§10).

### 7.2 Verification order (Tauri verifier)

`TofuPinningVerifier` (`lib.rs` 657-713) becomes:
1. loopback → accept (unchanged);
2. the chain validates with `webpki-roots` for the server name → accept, mark
   the host `ca_verified` (no pin; ACME certificates rotate every 60–90 days,
   which would otherwise trip the pin);
3. pinned and equal → accept;
4. pinned and different → reject with the existing `PIN_MISMATCH_MESSAGE`
   (L822), record `{ host, pinned, presented }` in `PIN_MISMATCHES`, emit
   `trust://identity-changed { host, pinned_fp, presented_fp }` once per host
   per run;
5. not pinned → record observed (unchanged).

### 7.3 First contact

The invite card (§1.5) or the sign-in trust row shows the words of the
**observed** fingerprint (`probe_server` returns `{ fingerprint, ca_verified }`
in addition to today's fields). Continue calls
`trust_server(url, fingerprint)`: it pins only if the currently observed
fingerprint equals the one shown; otherwise it refuses ("This server's identity
changed while you were looking at it."). This replaces the native "Trust new
Paracord instance?" dialog (`lib.rs` 621-655) for these flows, because the card
the person just confirmed is the trust decision. `update_trusted_server_hosts`
keeps the dialog for any host that reaches it without having been pinned this
way. `trustedHosts.ts` stops swallowing errors (L122-124): refusals surface.

### 7.4 Certificate change

`IdentityChangedSheet` (Index dialog style, §6.12): title "{server} has a new
identity". Body: "This server's words used to be **{old}**. Now they're
**{new}**. That happens when the person who runs it reinstalls Paracord or
replaces its certificate. It also happens when someone is trying to listen in.
Ask them whether they changed something before you continue." Buttons:
**Stay disconnected** (cream, default focus) and **Trust the new identity**
(danger ink). The latter calls `accept_changed_identity(host, presented_fp)`:
re-pins only if `presented_fp` equals the recorded mismatch; persists; the
connection manager reconnects. Until then the server is in phase
`identity-changed` (`ServerUnavailable.tsx` shows "Identity changed" + **Review**).
The mismatch text is matched in `trustedHosts.ts` (`isPinMismatch(err)`), not
reported as a generic network error.

---

## 8. Defaults and settings

### 8.1 Server config defaults

"New" = generated config (plain first run, `init`, installers). "Existing" =
any config that already has the key: its value is kept; a key missing from an
existing file takes the serde default listed.

| Key | New | Missing in existing file |
|---|---|---|
| `at_rest.enabled` | true (§4.2 source rules; desktop host keychain) | false |
| `at_rest.key_source` | per §4.2 | `env` |
| `auth.registration_mode` | `invite_only` (already, `config.rs:194`) | `open` (unchanged, `config.rs:177`) |
| `backup.auto_backup_enabled` | true | false |
| `backup.max_backups` | 14 (was 10) | 10 |
| `backup.auto_backup_interval_seconds` | 86400 | 86400 |
| `network.auto_port_forward` | true | false |
| `network.reachability_retry_seconds` | 60 | 60 |
| `server.redirect_listener` | true (host profile: false) | true |
| `link_previews.enabled` | true | true |
| `host.enabled` | false (host profile: true) | false |

The template comment for retention/backups that says "Disabled by default"
(`config.rs:984`) is corrected; serde defaults vs `Default` disagreements for
backups (L521 vs L535) are documented in the template, not changed (changing a
serde default would silently change existing installs).

### 8.2 Per-user settings

| Setting | Storage | Default |
|---|---|---|
| Link previews | `user_settings.link_previews` (new column) | on |
| Show what I'm playing | `notifications.activityDetectionEnabled` (JSON) | **off**: the client reads it as `=== true` (today `!== false`, `UserSettings.tsx:349,487`). Existing users who never touched it become off; users who turned it on explicitly are stored `true` and stay on. Release notes say so |
| Ask for my password when Paracord opens | `user_settings.crypto_auth_enabled` (renamed in UI only) | off |
| Invite defaults | client + contract | 7 days, 25 uses |

### 8.3 Link previews

Server unfurling (`paracord-api/src/opengraph.rs`, spawned unconditionally in
`routes/channels/messages.rs` 1045-1053) runs only when
`[link_previews] enabled` **and** the author's `link_previews` is on. A reader
whose setting is off sees no previews (the client does not render embeds of
type `link`). Encrypted DMs never get previews (the server cannot read them;
unchanged). When the server has them off, the switch is disabled with "Turned
off on this server."

### 8.4 Activity

`useActivityPresence.ts` (L131, 182) sends `set_activity_sharing_enabled` from
the new reading; first-run sign-up writes `activityDetectionEnabled: false`
explicitly.

### 8.5 Backups toggle at runtime

`PATCH /admin/backups { enabled }` stores `auto_backup_enabled` in
`server_settings` (DB value overrides config, like `registration_mode`,
`main.rs` 1607-1633); `spawn_auto_backup` (`main.rs` 4022-4089) reads the
effective value each tick.

---

## 9. API and contracts

### 9.1 Routes (new or changed)

All JSON; errors `{ code, message }`. Contracts live in
`crates/paracord-contracts/src/{credential,host,invite}.rs` → `contracts/api-contracts.json`
→ `client/src/api/generated/` (`npm run contracts:generate`).

| Method, path | Auth | Body → response |
|---|---|---|
| `POST /api/v1/auth/credential/params` | public (auth bucket) | `{ identifier }` → `CredentialParams { version: 1 } \| { version: 2, kdf, salt, epoch }` |
| `POST /api/v1/auth/credential/register` | public (auth bucket, `signup_invite_gate`) | `CredentialRegister` → 201 `AuthResponse` |
| `POST /api/v1/auth/credential/login` | public (auth bucket, `auth_guard_*`) | `{ identifier, auth_key }` → `LoginResponse` (MFA ticket branch as today) |
| `POST /api/v1/auth/credential/upgrade` | session | `{ current_password, credential, identity }` → `{ epoch }` |
| `PUT /api/v1/users/@me/credential` | session (+MFA when on) | `{ current_auth_key, credential, wrapped_key, mfa_code? }` → `{ epoch }` |
| `POST /api/v1/users/@me/credential/reset` | session (key sign-in) | `{ credential, wrapped_key, proof, mfa_code? }` → `{ epoch }` |
| `GET /api/v1/users/@me/key-backup` | session | → `KeyBackup { public_key, wrapped_key, wrap_alg, epoch, recovery_confirmed }` |
| `POST /api/v1/users/@me/key-backup/recovery-confirmed` | session | → 204 |
| `POST /api/v1/setup/credential-claim` | public, claim token | `ClaimRequest` minus `password`, plus `credential`, `identity`, `initial_space_hue`, `initial_space_template` → 201 `ClaimResponse` |
| `POST /api/v1/auth/reset-password` | token | v2 accounts: `{ token, credential, identity }` |
| `GET /api/v1/auth/options` | public | + `credential_version: 2`, `min_password_length: 10` |
| `GET /api/v1/setup/password-requirements` | public | §3.4 |
| `GET /api/v1/invites/{code}` | public (invite bucket) | §6.1 |
| `POST /api/v1/guilds/{id}/invites` | session | defaults 604800 / 25 |
| `GET /api/v1/host/status` | loopback + host token | `HostStatus` |
| `POST /api/v1/host/reachability/retry` | loopback + host token | → 202 |
| `POST /api/v1/host/backup-now` | loopback + host token | → `{ name }` |
| `POST /api/v1/host/storage-key/escrow` | loopback + host token | `{ wrapping_key, owner_public_key }` → 204; 409 `escrow_exists` when present, `escrow_owner_mismatch` for a key that is not the owner's current one |
| `GET /api/v1/admin/host-status` | admin | `HostStatus` (reachability/storage/backups/tls; `ports`, `lan_ip`) |
| `POST /api/v1/admin/reachability/retry` | admin | → 202 |
| `POST /api/v1/admin/storage-key/escrow` | owner | `{ wrapping_key, owner_public_key }` → 204 (409s as above) |
| `PATCH /api/v1/admin/backups` | admin | `{ enabled }` → 204 |
| `PATCH /api/v1/users/@me/settings` | session | + `link_previews: bool` |
| Gateway `INSTANCE_STATUS_UPDATE` | admins | `{ reachability, storage, backups }` |

Legacy refusals: §3.10.

### 9.2 Types (Rust contracts; TS generated)

```rust
pub struct KdfParams { pub alg: String /* "scrypt" */, pub log_n: u8, pub r: u32, pub p: u32 }
pub struct NewCredential { pub salt: String /* b64url 32B */, pub kdf: KdfParams, pub auth_key: String /* b64url 32B */ }
pub struct IdentityProof { pub nonce: String, pub timestamp: i64, pub signature: String /* hex */ }
pub struct NewIdentity { pub public_key: String /* hex 32B */, pub wrapped_key: String, pub wrap_alg: String, pub proof: IdentityProof }
pub struct CredentialRegister { pub username: String, pub display_name: Option<String>, pub email: Option<String>,
                                pub invite_code: Option<String>, pub credential: NewCredential, pub identity: NewIdentity }
#[serde(tag = "version")] pub enum CredentialParams { #[serde(rename = "1")] Legacy, #[serde(rename = "2")] OnePassword { kdf: KdfParams, salt: String, epoch: i64 } }
pub struct KeyBackup { pub public_key: String, pub wrapped_key: String, pub wrap_alg: String, pub epoch: i64, pub recovery_confirmed: bool }
pub enum ReachabilityState { Off, Asking, Open, SharedAddress, Refused, NoAnswer, Direct, FirewallBlocked }  // snake_case
pub struct Reachability { pub state: ReachabilityState, pub method: Option<String>, pub external_ip: Option<String>,
    pub gateway_ip: Option<String>, pub lan_ip: Option<String>, pub port: u16, pub lease_expires_at: Option<String>,
    pub next_retry_at: Option<String>, pub last_error: Option<String>, pub confirmed_at: Option<String> }
pub enum KeySource { Keychain, SystemdCreds, File, Env }
pub enum Protection { Login, Tpm, Machine, SameDisk }
pub struct StorageStatus { pub enabled: bool, pub sqlite_encrypted: bool, pub files_encrypted: bool,
                           pub key_source: Option<KeySource>, pub protection: Option<Protection>, pub escrowed: bool }
pub struct BackupStatus { pub enabled: bool, pub interval_seconds: u64, pub keep: u32, pub last_backup_at: Option<String>, pub last_error: Option<String> }
pub struct TlsStatus { pub fingerprint_sha256: String, pub self_signed: bool }
pub struct HostStatus { pub version: String, pub started_at: String, pub setup_required: bool,
    pub storage: StorageStatus, pub reachability: Reachability, pub backups: BackupStatus, pub tls: TlsStatus,
    pub instance_id: Option<String> /* [host] instance_id: the escrow key's HKDF info (§4.7, §2.11); S13b */ }
```

Timestamps are RFC 3339 strings in the contract; TEXT in the database.

### 9.3 Migration `20261013000001_first_run_setup.sql` (both directories)

SQLite (`crates/paracord-db/migrations/`):

```sql
-- One password: the credential's version and KDF inputs, the server-held
-- wrapped identity, and the link-preview setting. Constant defaults only
-- (SQLite cannot ADD COLUMN with a non-constant default on a populated table).
ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1
    CHECK (credential_version IN (0, 1, 2));
ALTER TABLE users ADD COLUMN credential_salt TEXT NULL;
ALTER TABLE users ADD COLUMN credential_kdf TEXT NULL;
ALTER TABLE users ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 0;
UPDATE users SET credential_version = 0 WHERE password_hash IS NULL;

CREATE TABLE IF NOT EXISTS account_key_backups (
    user_id            BIGINT  PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key         TEXT    NOT NULL,
    wrapped_key        TEXT    NOT NULL,
    wrap_alg           TEXT    NOT NULL,
    credential_epoch   INTEGER NOT NULL,
    recovery_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL
);

ALTER TABLE user_settings ADD COLUMN link_previews BOOLEAN NOT NULL DEFAULT TRUE;
```

PostgreSQL (`migrations_pg/`): identical except `credential_epoch BIGINT` and
`BOOLEAN … DEFAULT FALSE/TRUE` as native booleans (both engines already declare
`users.id BIGINT`, `20260209000001_initial_schema.sql`).

Any-pool rules (CLAUDE.md): bind Rust `bool` directly for
`recovery_confirmed`/`link_previews`; read them as `CAST(col AS INTEGER) AS col`
with `bool_from_any_row`; timestamps bound with `datetime_to_db_text`. New db
modules: `paracord-db/src/credentials.rs` (params, set credential, upgrade with
the conditional version check), `paracord-db/src/key_backups.rs`.

### 9.4 Config additions (`crates/paracord-server/src/config.rs`)

`[at_rest] key_source, key_file, keychain_service, keychain_account, protection`;
`[network] reachability_retry_seconds`; `[server] redirect_listener`;
`[host] enabled, instance_id, control_token_file, escrow_file`;
`[link_previews] enabled`; plus env overrides `PARACORD_AT_REST_KEY_SOURCE`,
`PARACORD_AT_REST_KEY_FILE`, `PARACORD_LINK_PREVIEWS_ENABLED`,
`PARACORD_REDIRECT_LISTENER`, `PARACORD_REACHABILITY_RETRY_SECONDS`, all
template-documented. CLI: `init --profile desktop-host --root --port`,
`--log-file`, `encrypt-storage`, `restore-backup --escrow-key-stdin`.

### 9.5 Tauri commands and events (`client/src-tauri`)

| Command | Returns |
|---|---|
| `host_preflight()` | `{ ok, port? , reason?, detail?, existing_url? }` |
| `host_setup_start({ port })` | `()`; progress via `host://progress` |
| `host_claim(request)` | `ClaimResponse` (token read from the claim file in Rust) |
| `host_write_escrow({ wrapping_key, owner_public_key })` | `()` |
| `host_status()` | `HostStatus` |
| `host_retry_reachability()`, `host_backup_now()` | `()` / `{ name }` |
| `host_start()`, `host_stop()`, `host_set_autostart(bool)` | `()` |
| `host_remove({ delete_data })` | `()` |
| `host_logs_tail({ lines })` | `string` |
| `host_restore({ archive_path, wrapping_key })` | `()` |
| `trust_server({ url, fingerprint })` | `()` |
| `accept_changed_identity({ host, presented_fp })` | `()` |
| `probe_server(url)` | + `fingerprint`, `ca_verified` |
| `take_pending_deep_links()` | `string[]` |

Events: `host://progress`, `trust://identity-changed`, `deep-link` (existing).
Capability file grants the clipboard plugin's `read-text`/`write-text`.

### 9.6 Client layout

```
client/src/pages/firstRun/FirstRunPage.tsx        frame, routing between steps
client/src/components/firstRun/                   Launch, Welcome, NameStep, InviteStep, AccountStep,
                                                  SetupStep, PhraseStep, HostInviteStep, SignInStep,
                                                  ProtectedSheet, RouterSheet, SharedAddressSheet,
                                                  IdentityChangedSheet, primitives.tsx, preview/*
client/src/stores/firstRunStore.ts                path, step, fields, rows, errors
client/src/stores/hostStore.ts                    host status, progress events, commands
client/src/lib/credential/                        kdf.worker.ts, derive.ts, wrap.ts, keystoreV2.ts, vectors.json
client/src/lib/trustWords.ts  lib/inviteLinks.ts  lib/deepLinks.ts
```

---

## 10. Security review notes

**What the server learns.** Username, display name, optional email, the
credential's salt and KDF parameters, `auth_key` on every sign-in, the wrapped
identity, the identity public key, prekeys, invites, metadata it already sees.
It never receives the password, `wrap_key`, the identity private key or the
phrase.

**What the server (operator) can do.**
- Offline-guess the password against `auth_key` or the wrapped backup at scrypt
  (128 MiB) cost per guess. E2EE against a malicious operator is therefore as
  strong as the password; the 10-character minimum, the common-password block
  and the passphrase guidance are the defense. This is inherent in any
  password-unlocked backup (OPAQUE would not remove it for an operator holding
  the envelope) and is stated in docs/encryption.md.
- Serve a fake `version: 1` to a brand-new device (§3.13 residual risk).
- Swap a wrapped backup: the client detects it (unwrap fails, or the derived
  public key does not match the pinned one) and refuses.
- Refuse service, drop messages, see metadata — unchanged.

**What a database thief gets.** Argon2id(auth_key) hashes, wrapped backups
(scrypt per guess), and — on an at-rest server — nothing readable without the
storage key (SQLCipher + PRCENC02). With `same_disk` protection, a thief with the
whole disk gets the key too; the UI says so.

**First-contact trust.** TOFU on the full SHA-256 of the leaf certificate. The
four words carry 44 bits for human comparison; an attacker who wants to fool a
person comparing words must find a certificate whose fingerprint matches those
44 bits (≈ 2^43 signing attempts on average) and also be on the path at first
contact. Comparing words is optional; the pin is what protects later visits.

**Invite preview.** Public; reveals the server's name, hue, member and online
counts and three initials+hues to anyone with a valid code. Codes are 8
characters; the 30/min bucket and the 20-misses lockout make enumeration
impractical.

**Rate limits.** `/auth/credential/*` sit under the existing `/api/v1/auth/*`
bucket (60/min/IP) and the DB-backed `auth_guard_*` backoff
(`routes/auth.rs:390-426`). `/setup/credential-claim` uses `auth_guard_*` as the
current claim does. `/host/*` is loopback-only with a per-start random token.
The params route returns identical shapes and timing for unknown users (fake
salt; the login path runs a dummy Argon2 verify).

**Host control surface.** Loopback peer check + token file readable only by
the OS user. Another local process running as the same user can read the token;
that user can already read the keychain entry, so the token adds no new
exposure. The control routes cannot read messages or keys; escrow is write-once.

**Keychain.** Desktop host: the storage key is in the user's login keychain;
any process running as that user can read it (same as the refresh tokens
today). macOS ACLs bind to the binary's code signature at the stable path.

**Clipboard.** Read only on Welcome/Join, desktop only, parsed and discarded.
The phrase copy is cleared after 60 s on desktop.

**Deep links.** Treated as untrusted input: parsed by the same invite parser,
never auto-joined; they only prefill the join step, which still shows the
server card and identity and waits for Continue.

**Removed third party.** `api.ipify.org` is no longer contacted.

**Logs.** Never contain passwords, `auth_key`, wrapped keys, the at-rest key,
claim or host tokens, invite codes in full (first 3 characters only).
