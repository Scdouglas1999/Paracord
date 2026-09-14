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
- Group DMs still can't send messages (see limitations below), but the app now tells you before you create one instead of after.
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

- Group DMs can be created but not used yet.
- There's no way to publish a bot to the bot store, so it's empty. Bots can only be installed by whoever made them.
- AutoMod is per server, not instance-wide, and keyword rules don't catch look-alike characters.
- Refreshing the page during a call ends the call.
- A window opened after a DM call has already started won't ring; the ring only fires when the call starts.
- The desktop app's auto-update only works if a signed update manifest is published with the release.
- LiveKit is still in the codebase as an unsupported option. The native QUIC engine is the one to use.

## Verification

Run on the release commit before tagging:

- Rust: `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` (Rust 1.91) clean; 1,553 tests across 92 suites on SQLite, and the 569-test API suite again on a real PostgreSQL 16, all passing.
- Client: `tsc` clean; 2,560 unit tests in 268 files; the colour-token, contrast, static accessibility and vocabulary audits all pass.
- End to end (Chromium against the real release binary): 87 mocked cases, 22 motion timing cases, 15 real-server cases (voice join with audible audio and visible video both ways, restore, first-owner claim), 6 messaging and 1 attachment-confidentiality cases.
- Release smokes: all 22 `scripts/release_*_smoke.py` pass, plus the install smoke, restore on SQLite and PostgreSQL, upgrade-from-v2.0.0 on both, security DAST, and the three-node federation validation.
- Eight QA passes drove the app live across voice, messaging, DMs and encryption, guild administration, install and operations, desktop and phone interfaces, and an adversarial pass; the three domains that came back red were fixed and re-verified end to end.

## Previous releases

- [v2.0.0](https://github.com/Scdouglas1999/Paracord/releases/tag/v2.0.0)
- [v1.0.0](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
