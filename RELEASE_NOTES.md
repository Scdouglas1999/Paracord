# Paracord 3.1.0

3.0.0 was built and tested but never made public, so for most people this is the first release since 2.0. Everything in the 3.0.0 notes further down is new to you too. This section covers what changed after 3.0.0.

Compare: [v2.0.0...v3.1.0](https://github.com/Scdouglas1999/Paracord/compare/v2.0.0...v3.1.0)

## Three new looks

The dark theme was too grey. Most of the screen was the same near-black with small grey text, and the only colour came from people being online, so a quiet server looked dead.

- The default dark theme now has real colour: the sidebar side is a deep blue, the panels you read in are warm, and empty channels no longer show up as black holes.
- **Voices is the new default** for fresh installs and for accounts that never picked a theme. If you chose a theme before, you keep it.
- Settings → Appearance has three new options under the existing themes. They switch instantly.
  - **Dusk sky** puts a sunset behind the whole app, with dark glass panels over it.
  - **Paper & ink** is a light look: cream paper, dark ink, a solid blue sidebar and hard printed-style shadows.
  - **Voices** puts every message in a bubble tinted with its author's colour. Yours sit on the right.
- Each of the three brings its own colours, so the accent and base colour pickers are switched off while one is on. Pick Night, Daylight, AMOLED or High contrast to get them back.
- You can pick the base colour of the four regular themes (a few presets or any hue), and it changes as you drag. Text stays readable whatever you pick.
- Names in chat are written in each person's own colour, and the Friends list uses the same colours instead of green for everyone.

## Installing and joining are much simpler

- **Running a server is one command, then one link.** The installer sets everything up, starts the server, and opens a link in your browser that takes you straight to creating your account and naming your server. No more hunting for a token in a terminal and pasting it into a page.
- **Windows is a single command** in any PowerShell window (`irm …/install.ps1 | iex`). It asks for administrator permission itself.
- **The server opens the way in on your router by itself** (UPnP or NAT-PMP), so friends outside your home can usually join with no router setup at all. If your router says no, the server and the Invite dialog both tell you plainly, and [docs/port-forwarding.md](docs/port-forwarding.md) walks through the one setting to change. Turn it off with `auto_port_forward = false` under `[network]`.
- **Invite links are normal links now.** They open in any browser, where a friend presses "Create an account to join" and lands in your server. Before, the main link only worked if the friend already had the app installed.
- The Invite dialog tells you who the link will work for: anyone, or only people on your Wi-Fi. It no longer hands out links pointing at `localhost` if you set the server up on the same machine.
- Opening an invite used to make everybody tick "I acknowledge this server's rules and verification requirements" and showed a box for "verification answers", even on servers that had neither. Now you're only asked if the owner actually turned that on, and you see the real questions.
- Creating an account from an invite used to forget the invite and drop you into an empty app. Fixed.
- The desktop app's first screen asks for your invite link instead of an "instance address", and its error messages say what went wrong in plain words.
- A new member no longer gets a tour bubble stacked on top of the welcome screen.
- The installer's closing message, and what the server prints when it first starts, were rewritten to say what to do next without any networking vocabulary.

## Home

Home now leads with people and conversations: who's around, your servers, and the conversation you were last in, instead of a list of things the app wanted from you.

## Signing in and staying signed in

- Signing in showed one or two "Failed to load relationships" errors even though your friends list loaded fine a moment later. Fixed.
- The desktop app forgot your session between launches. Fixed.
- A session that was revoked now takes you to the sign-in screen instead of bouncing around.
- If the instance is down, you're told it's down, not that your password is wrong.
- Sign-in errors are shown in full instead of being cut off, and the recovery phrase step is no longer a dead end.
- Setting up a second device gets a proper screen, and relaunching only asks you to unlock.
- The first-run, sign-up and recovery screens fit the window instead of scrolling, and the longer forms are split into steps.

## Desktop app

- An encrypted DM couldn't be sent from the desktop app at all. Fixed.
- File uploads from the desktop app were sent in a form the server rejected. Fixed.
- Avatars, emoji and stickers didn't load in the desktop app. Fixed.
- The microphone you pick is the one that gets opened, it's listed by its real name, and the level meter shows what it hears. A microphone that's silent or missing says so straight away.
- If you already answered the system's screen-share picker, the app doesn't ask you for permission again.
- Screen shares could fail to start ("did not start capturing within 3s") on machines where the video encoder takes a few seconds to warm up, and after one failure every retry in the same call failed too. Both fixed.
- Turning the camera on with no camera connected made the app appear to hang. It now says there's no camera straight away.
- **Linux with NVIDIA's driver:** the app opened a black window and crashed when you clicked anything. It now turns off WebKit's GPU compositing on those machines and renders normally. Video never went through that path, so it's unaffected. Set `PARACORD_WEBKIT_ACCELERATION=ondemand` to get the old behaviour back if your driver copes.

## Other fixes

- A server you create while the app is open shows up right away, without a restart.
- One conversation the server refuses no longer breaks the whole account's messages.
- A message that can't be saved on your device no longer drops your connection.
- The typing indicator is visible without scrolling for it.
- The "Create an event" button does something now.
- Server settings prompts appear, and an invite tells you when it expires.
- Custom CSS actually applies, or tells you that it didn't.
- Legal documents scroll instead of being cut off, and tooltips let go of a button after you press it.
- The app stopped checking the instance's health on every single request, and About shows the real version.

## Security

We went through the server and clients looking for ways to get around permissions, log in as someone else, read things you shouldn't, or crash the app with bad input. What we found is fixed. The details are in [docs/security-audit-2026-09-19.md](docs/security-audit-2026-09-19.md); the short version:

- **Permissions.** A few combinations of role and channel settings could give someone access a role had denied, and a removed or demoted member could keep access for a few minutes. Bots could end up with more permission than they were installed with. All fixed, and removing someone now takes effect immediately everywhere, including for messages that were queued for them.
- **Logging in.** A two-factor code could be reused after a server restart. A half-finished login could survive a password change. Old password-reset and email links kept working after you changed your email or password. All fixed.
- **Invites.** One person hammering an invite could use up all its uses or trip the anti-raid lockdown. Fixed.
- **Webhooks** could post to locked threads and skip AutoMod on edits. Fixed.
- **Federation.** Several ways for another instance to replay requests, forge a signature with a bad key, write into servers it has nothing to do with, or keep reading history after a channel went private. Fixed. Files fetched from other instances are now encrypted on disk if your instance encrypts attachments.
- **Calls.** Encrypted audio and video packets could be replayed. Fixed.
- **Video decoding** could be made to read or allocate memory it shouldn't by a malicious stream. Fixed.
- **Desktop app.** File transfers could reach the app's own key files. They're now limited to the transfer folder and Downloads.
- **HTTPS.** If the certificate failed to load, the server quietly started on plain HTTP instead. It now refuses to start and tells you why.

## Packages

- **macOS builds exist now.** `.dmg` for Apple Silicon and Intel, plus a macOS server tarball. They're unsigned unless a Developer ID is configured, so the first launch needs right-click → Open.
- **Fedora/RHEL get an `.rpm`**, alongside the `.deb` and AppImage.
- `install.sh` works on macOS: it sets up a launchd job (system-wide with sudo, per-user without).
- `install.ps1` couldn't run on the PowerShell that ships with Windows; it failed before doing anything. Fixed.
- Installing on Windows as a service left the server unable to read its own config, so it exited immediately with nothing in any log. Fixed, and the installer now checks.

## Known problems

- If the instance rejects the session the desktop app saved (after a long time away, or if the session was revoked), the app can open with "Unknown user" and no servers instead of taking you to the sign-in screen. Open Settings, log out, and sign in again.
- Dusk sky and Paper & ink have rules for when a native video stream is on screen in the Linux desktop app (the glass goes solid, the paper texture is removed). Those rules haven't been tried against a real stream yet.
- The Windows installer was rewritten for this release and has been checked by tools but not run by hand on a Windows machine yet. If it misbehaves, the old two-step way still works: download `install.ps1` and run it with `powershell -ExecutionPolicy Bypass -File .\install.ps1`.
- Automatic router setup was tested against a router that refuses it (the server says so correctly and carries on). We didn't have a router that accepts it to hand, so that path is covered by automated tests only.
- Home and a server's front page still have a lot of empty space when a server is quiet. That's a layout job for a later release.
- The rest of the list is in [docs/known-limitations.md](docs/known-limitations.md).

## Upgrading from 3.0.0 or 2.0

- Instances upgrade in place on SQLite and PostgreSQL. Database changes apply themselves on first start.
- If you federate with other instances, update both ends. An instance still on an older version can't download files from an updated one, and manually added peers need to be saved again once so their keys are registered.
- If you've configured HTTPS and the certificate is missing or broken, the server won't start. Before, it fell back to HTTP without telling you.
- If you've set attachments to be encrypted with no plain-text reads allowed, old unencrypted files are now refused rather than served. Turn on the migration option first if you still have some.
- Upgrade desktop and browser clients together, as with 3.0.

## How this was tested

- The server's own tests (1,732 of them) and the client's (2,839) pass. So do the colour-contrast check across all seven themes, the accessibility check, and 92 browser tests against a mocked server.
- 16 browser tests ran against the real server binary, including two people in a call who hear and see each other, a backup being restored under connected clients, and claiming a brand-new instance.
- Three real accounts were driven through one live instance of this build: making a server, joining by invite, chatting live, an encrypted DM, an encrypted group DM, removing someone from the group and checking they can no longer read it, edits, reactions and deletes. All 25 steps passed. The new owner and newcomer paths were each walked in a real browser against this build: from the link the server prints to a working invite, and from that invite to a new member's first message screen.
- Windows and macOS builds are compiled and packaged by the release pipeline. They weren't run by hand on those systems before this was written; the macOS builds in particular are new.

---

# Paracord 3.0.0

This is a big release. The client has a new look, voice works from the browser, installing an instance is one command, and a lot of things that were broken or half-finished in 2.0 have been fixed. We tested it by having people actually use it — join calls, send messages, run instances, try to break things — and fixed what they found.

Compare: [v2.0.0...v3.0.0](https://github.com/Scdouglas1999/Paracord/compare/v2.0.0...v3.0.0)

## New interface

The app has been redesigned from the ground up. The sidebar shows your servers and channels with a small indicator of who's around and where; voice channels show who's in them before you join; text channels show who's reading. There are four themes (dark by default, plus light, black and high contrast), a motion setting (follow system, on, off), and everything works at phone width with proper touch targets.

Animations are deliberate and short. Joining a channel animates from the thing you clicked; sending a message lifts it out of the composer; when someone joins a call you see it happen. If you have reduced motion turned on in your OS, none of this plays.

The wording has been made consistent throughout, and it is Discord's: a community is a **server**, the things inside it are **channels** (text or voice), and the host you run or connect to is an **instance**. DMs are "Messages".

## Voice

- Voice calls now work in the browser, not just the desktop app. Previously the call would connect and show everyone's tile, but no audio ever played. Three separate bugs in the media protocol have been fixed and there's a test that fails unless both sides actually decode and play audio.
- Call encryption now uses a key created per call. The old design tried to use each account's identity key, which most accounts never had, so encryption never actually established. The relay still can't read your audio or video. Note that 3.0 clients can't exchange call keys with 2.0 clients, so upgrade clients together.
- If you close the tab during a call, you leave the call within a second or two. Before, you'd be stuck in there until the instance restarted.
- If the instance goes away mid-call, the app says it's reconnecting and then tells you the call ended, instead of showing a live timer forever.
- The speaking indicator and mic level meter work (they didn't on the native path, including for yourself).
- Incoming DM calls now ring, and you can answer or decline.

## Messaging

- A webhook embed without a URL used to crash the whole channel for everyone. Fixed.
- The message actions menu (reply, edit, pin, etc.) only worked on the last message in a channel. Fixed.
- Busy channels open at the newest message, and you can scroll back all the way to the start.
- Jumping to a message from search or pins works. Editing puts the cursor at the end. Webhook messages stay attributed to the webhook after a reload.
- Channels have a right-click menu: notification level (everything, mentions only, muted), mark as read, copy link.
- If you lose permission to see a channel while you have it open, it goes away immediately.
- A channel with unread mentions won't get hidden behind "N more channels" anymore.

## Direct messages and encryption

- **The 24-word recovery phrase didn't work.** Six words of every phrase the app ever showed were wrong, so no phrase could be used to recover an account. Phrases from this release work. Phrases from earlier releases never did — if you still have your device, open Settings, go to Identity, and write down a new phrase.
- After recovering on a new device, you can publish new encryption keys and send messages again. The app explains what that costs (older history stays unreadable unless you import a backup) before you do it. Previously you'd get an error about missing keys with no way forward.
- If a message has been tampered with, you're told. Before, it failed silently.
- In the browser, "verified" marks on contacts now survive a reload.
- Group DMs work. They're end-to-end encrypted, including attachments. Each member's key is shared with the others through their identity keys, and the key changes whenever somebody joins or leaves or rotates their own key, so a person who left can't read what's said afterwards. Every message is signed, so one member can't post something that looks like it came from another. If somebody in the group hasn't set up encryption yet, the composer says who instead of sending.
- Fixed an error on every first login that caused a reconnect.

## Instance administration

- Names for servers, channels, roles, nicknames, webhooks and AutoMod rules are validated the same way everywhere. Invisible or right-to-left-override names are rejected.
- You can edit the default role's permissions (previously it was hidden), and the permissions grid shows all 30 permissions instead of 16.
- Channels can be created inside categories. That was broken.
- Admin actions are reachable on phones.
- Scheduled events with invalid dates are rejected instead of silently disappearing from the calendar.
- Various inputs that accepted anything (reactions, channel types, role colours, scheduled send times, permission bits) are now checked.

## Installing and running an instance

- `scripts/install.sh` (Linux/macOS) and `scripts/install.ps1` (Windows) install or upgrade an instance in one command, verify the download, keep your config and data, and print the share URL and claim token.
- The server binary now handles SIGTERM, which is what systemd, Docker and most process managers send. Before, only Ctrl-C triggered a clean shutdown. Clients are told the instance is restarting before it goes down.
- `scripts/backup-db.sh` always ran `pg_dump`, even on SQLite. Fixed.
- Federation between instances works when the instance's configured name differs from its hostname (which was the default setup). Refused requests are logged with a reason.
- Rate limits can be tuned with `PARACORD_HTTP_RATE_LIMIT_*` environment variables. Defaults are unchanged.
- Adding a second instance from a browser needs that instance's operator to allow your origin. The connect screen now tells you exactly what to set. The desktop app doesn't have this restriction.
- Log levels are more sensible: a successful setup isn't a warning, and a feature that isn't configured isn't an error.

## Upgrading

Server binaries and client installers are attached. An instance upgrades in place from 2.0 on both SQLite and PostgreSQL. Upgrade clients together because of the call encryption change. Theme and motion settings are per device.

## Known limitations

- There's no way to publish a bot to the bot store, so it's empty. Bots can only be installed by whoever made them.
- AutoMod is per server, not instance-wide, and keyword rules don't catch look-alike characters.
- Refreshing the page during a call ends the call.
- A window opened after a DM call has already started won't ring; the ring only fires when the call starts.
- The desktop app's auto-update only works if a signed update manifest is published with the release.
- LiveKit is still in the codebase as an unsupported option. The native QUIC engine is the one to use.

## How 3.0.0 was tested

The automated tests pass on both SQLite and PostgreSQL, the browser tests run against the real server binary (including two people in a call who can hear and see each other), and installs, upgrades from 2.0 and backups were each done for real. Several rounds of people using the app live found the problems listed above, which were fixed and checked again.

## Previous releases

- [v2.0.0](https://github.com/Scdouglas1999/Paracord/releases/tag/v2.0.0)
- [v1.0.0](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
