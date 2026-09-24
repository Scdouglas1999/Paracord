# Paracord 3.3.0

More to do together, and more that arrives on its own. You can watch or listen to something together in a voice channel, play sounds for the room, and share what you're listening to. A server can pull in posts from blogs, YouTube, GitHub, Twitch and Jellyfin, show whether its game servers are up, and run a daily word puzzle. The desktop app can now update itself.

Compare: [v3.2.0...v3.3.0](https://github.com/Scdouglas1999/Paracord/compare/v3.2.0...v3.3.0)

## Watch and listen together

In a voice channel, the new Together button starts something everyone in the call plays in step.

- Paste a YouTube video or playlist, or a direct link to a video or audio file (https), or pick a file already posted in the server, or upload one.
- Everyone can pause, seek and skip, or the person who started it can keep the controls to themselves. Your volume is your own.
- There's a queue you can add to, reorder and clear. Someone who joins the call later jumps straight to where everyone is.
- The sidebar shows "Watching …" or "Listening to …" under the voice channel, and the server's front page shows it under Live now with a Join button.
- YouTube videos play from YouTube on each person's device, and links play from the site they point to. Uploaded videos show a preview frame.

For now this works in server voice channels, not in direct-message calls.

## Soundboard

Short sounds anyone in a voice channel can play for everyone in it.

- Upload sounds under Server settings → Soundboard: mp3, ogg, wav or m4a, up to 5 seconds and 1 MB, with a name, an emoji and a volume. A server can have 48.
- Open the soundboard from the call controls and click a sound. The other people in the call hear it, and see its emoji ripple on your tile.
- Settings → Voice has a soundboard volume and a switch to turn sounds off for yourself. Deafened people don't hear them.
- A new permission, Use soundboard, is on for everyone by default. There's a short cooldown so a call can't be flooded.

## Share what you're listening to

Turn on Settings → Activity privacy → "Share what I'm listening to" in the desktop app on Windows or Linux. Paracord reads your system's media controls and shows the title, artist and player to people you share a server with, only while the setting is on. It's off by default, and it isn't available on macOS or in the browser.

Profiles show what someone is listening to (with progress), watching or playing, and member lists, the DM list and the front page show it in one line. Your custom status now actually reaches other people; before, it was never sent.

## See who's talking without joining

The front page's Live now card and the sidebar now show who is talking in a voice channel even when you're not in it, the same way they do when you are. Only people who can already see the channel see this, and nothing is stored.

## Add-ons

Server settings → Add-ons is now one page listing everything you can add to a server: Sports, Feeds, Game servers and Daily word.

### Feeds

New posts from outside Paracord land in a channel as tidy cards, and can show in Latest on the front page.

- **RSS or Atom**: any blog, news site or podcast. Paste the site's address and Paracord finds its feed.
- **YouTube**: new videos from a channel.
- **GitHub**: releases, commits on a branch, or tags from a public repository.
- **Twitch**: a post when a channel goes live. The instance admin adds Twitch app credentials first, under Admin → Add-ons.
- **Jellyfin**: new movies, episodes and albums from your library, with posters.

Adding a feed never floods the channel with old posts: it shows the newest item and lets you post it if you want. Several posts in a row from one feed show on the front page as one card. Your server fetches everything; members' devices never talk to these sites. It won't fetch addresses on its own network unless the instance admin allows it (Admin → Add-ons → Network), which a Jellyfin server at home needs.

### Game servers

List up to 10 Minecraft (Java or Bedrock), Steam (CS2, TF2, Garry's Mod, Rust, Valheim, ARK and more) or any-port game servers. Everyone in the server sees which are up and who's playing, in the sidebar and in a front-page panel, with Copy address and, for Steam games, Connect. A channel can get a post when a server goes down and when it comes back.

### Daily word

A five-letter word to guess in six tries, the same word for everyone on the instance, new every day at midnight UTC. Keep a streak, see how the rest of the server did once you've finished, and share your result as colored squares without giving the word away. The front page shows who has solved today's word.

## Direct messages

- Forwarding between direct messages and group DMs is now end to end: the "Forwarded from" line travels inside the encrypted message, and the instance no longer records where a forwarded message came from.
- Direct messages have a Media panel (Media, Files, Links), built on your device from the messages you have. Load older reaches further back.

## Smoother

Menus, popovers, dialogs, panels and phone sheets open and close with one quiet, quick motion, and they now leave as smoothly as they arrive: closing a dialog no longer makes its backdrop vanish. Switching channels or settings sections fades the new content in. Scrolling a busy channel or the front page does less work, microphone meters no longer shift the call controls, and nothing animates while the window is hidden. With reduced motion turned on in your system, nothing animates at all.

## Updates

- The desktop app can update itself again, with a new signing key. Because the key changed, 3.2.0 and older can't update to 3.3.0 on their own: install 3.3.0 once from the downloads below, and later versions will arrive in the app.
- On Linux, "Restart to install" now actually restarts into the new version, and AppImage and rpm installs download the right file.

## Fixes

- A camera or screen share no longer freezes for the rest of a call after one lost video frame. The picture comes back at the next keyframe, which is requested straight away.
- The Linux AppImage starts on computers with AMD or Intel graphics. It shipped an older copy of a system graphics library that stopped current drivers from loading.
- The Windows installer no longer fails to download on machines where Internet Explorer was never set up.
- Search results show readable snippets (no stray markdown, mentions named, spoilers hidden), and their times match the rest of the app.
- The React emoji picker opens next to the message you clicked.
- A new profile picture shows up everywhere straight away.
- "Most active" on the front page counts XP earned this week. It starts filling from this update.
- Sports' "show on the server page" setting decides whether live games appear on the front page.
- Pressing Escape in a dialog over Server settings (like Add a feed) closes only the dialog.

## Upgrading

Run the install command again, or install the new downloads below. Your data and settings carry over. The desktop app needs this one manual install (see Updates above).

If you run Paracord behind Let's Encrypt, nothing changes. If you want to test certificates against a different ACME server, `tls.acme.directory_url` now appears in the example config.

# Paracord 3.2.0

The biggest release since 3.0. A server's front page is no longer a list of empty channels, there's a lot more you can do with a message, search covers a whole server, and there's a new Sports add-on. Paracord also has a proper logo now, and it's noticeably lighter on your computer.

Compare: [v3.1.1...v3.2.0](https://github.com/Scdouglas1999/Paracord/compare/v3.1.1...v3.2.0)

## Safer by default

A new server no longer opens itself to the whole internet without asking.

- **New servers are invite-only.** Someone without an invite link sees a page saying so instead of a sign-up form. Owners can open sign-up to anyone under Admin → Settings → Who can create an account, and first-run setup asks.
- **The router is left alone unless you say yes.** The installer asks whether friends outside your home network should be able to connect, and only then asks your router to open a port. You can change it later under Admin → Settings → Network.
- **Existing servers keep working exactly as before.** Both settings only change on new installs.
- **A proper domain and certificate is now the recommended setup.** Automatic certificates from Let's Encrypt now arrive a few seconds after the server starts. Before, the first request always failed and the real certificate took up to 12 hours to arrive.
- **Checksums for every download.** Each release has a `SHA256SUMS.txt`, and the README shows how to check a download before you run it.
- **How the encryption works** is written up in [docs/encryption.md](docs/encryption.md): direct messages use the Signal protocol design (X3DH and the Double Ratchet), groups use signed sender keys, and it spells out what the server can and can't see. It's Paracord's own implementation and hasn't been independently audited yet.
- **Reporting a security problem:** see [SECURITY.md](SECURITY.md).
- Fixed: on a server that hadn't been set up yet, signing in with a brand-new key could create the owner account and skip the setup link.

## A server's front page

Opening a server used to show its voice channels and a list of text channels, which looked empty whenever nobody was in voice. It's now a front page:

- The server's banner and name at the top, with who's online and an Invite button.
- **Live now**: voice channels with people in them, games that are on, and events that are happening. When nothing is live it shrinks to one line of voice channels you can jump into.
- **Latest**: a feed of what people shared across the server's channels. That means announcements, photos and files, polls you can vote in right there, pinned and well-reacted messages, new forum questions, and who joined. Everyday chatter stays in the channels.
- A column of small panels: what's coming up (with RSVP), recent photos, who's been most active this week, the next game, the latest pin, and new members. Owners pick which ones show and in what order under Server settings → Server hub → Home page. A panel with nothing to show is hidden.
- The live cards glow only while someone in that channel is actually talking.

## Search a whole server

Search used to cover one channel. It now covers every channel you can read in a server.

- Type filters as you go and they turn into chips: `from:`, `in:`, `has:link` / `image` / `video` / `file` / `poll`, `mentions:`, `before:`, `after:`, `during:` (dates like `yesterday` or `last week` work), and `is:pinned`.
- Results are grouped by channel with the matching words marked. Use the arrow keys and Enter to jump to a message.
- Open it with Ctrl/⌘+F, the search icon, or "Search this server" in the command palette. On a phone it's a full-screen sheet.
- In a direct message, search looks through the messages already on your device, because the server can't read encrypted conversations.

## More you can do with a message

- **See who reacted.** Hover a reaction (or long-press on a phone) to see who's behind it.
- **Remind me.** Right-click a message and pick 20 minutes, an hour, tomorrow morning, next week or your own time. You get a notification when it's due, and the Inbox has a new Reminders tab.
- **Forward.** Send a message to up to five channels or conversations at once, with a note. The copy links back to the original for anyone who can see it. Moving text out of an encrypted conversation into a server channel asks first, and files from an encrypted conversation can't be forwarded.
- **Role mentions.** Typing `@` suggests roles as well as people, a role mention shows as a colored chip, and it notifies the people who have that role.

## Profiles, banners and stickers

- You can upload a profile banner (with a crop step) and pick an accent color. Servers can have a banner too, which shows on the front page.
- Server settings has a Stickers section for uploading, renaming, tagging and removing stickers.
- A Media panel in every channel, and one for the whole server, collects photos and videos by month, plus files and links. Photos open in the viewer, and you can step through them with the arrow keys.

## Sports

Server owners can turn on Sports under Server settings → Add-ons. It shows live scores for the leagues you pick (NFL and MLB to start, plus NBA, NHL, soccer and more). Your server fetches them from ESPN's public scoreboard, so your members' devices never talk to ESPN.

- A scoreboard page with any day's games, and standings for each league.
- A game page with the field or the diamond, the score by quarter or inning, the play-by-play, leaders and the box score.
- Pin a game above a channel and Paracord posts each score, halftime and the final into it. Pinning a game that's already under way starts from the current score rather than replaying every earlier one.
- On a phone you can turn a game sideways for a bigger field.

Full guide: [docs/sports.md](docs/sports.md).

## A new look by default

- **Slate** is the new default: a cool charcoal with each message in its author's color. The old aubergine default is still in Settings → Appearance as **Aubergine**. If you never picked a theme, you'll now see Slate; if you did, you keep your choice.
- Presence is described in plain words: "online", "here", "in voice", "Nobody in voice", where it used to say things like "lights on" or "reading".
- Paracord has a logo: a lantern on a paracord handle. It's the app icon on every system, it shows while the app starts, and it's on the sign-in screens.

## Faster

The app does a lot less work, especially the desktop app on Linux:

- Sitting on a server's front page with people in voice used about 1.8 CPU cores in the desktop app. It now uses about 0.1 when nobody is talking.
- Clicking a text channel in the sidebar used to freeze the screen for most of a second. It now opens straight away, and the sidebar no longer shuffles under your pointer when you do.
- Scrolling a busy channel does about half the work it did.
- Someone starting or stopping talking no longer re-draws every message on screen.
- The app loads about a quarter less code at startup.

## Fixes

Found while testing this release. Most were in the new features, but a few were older.

- Voice: starting or stopping a screen share showed a muted person as unmuted to everyone else, and muting while sharing told others the share had ended.
- Polls: someone else's vote showed up as your own tick until the next refresh.
- Channels with pictures sometimes opened short of the newest message, with "Jump to present" showing.
- A thread's header said "0 here" while you were reading it.
- The welcome screen listed threads as if they were channels.
- Poll options were cut off on a phone.
- Anonymous posts stay anonymous everywhere a new feature can show them: forwards, the media gallery, search by author, and the server's front page. Webhook posts show the webhook, not the person who set it up.
- A 3.2 app can still sign into a 3.1 server and load your account. Upgrade the server to get the new features.
- The Docker image builds again (it was missing the patched system libraries).

## Upgrading

Run the install command again, or download the new installers below. Your data and settings carry over.

- Servers that had a banner in the old Server hub setting get it converted to the new banner automatically.
- Accounts that never picked a theme move from the old aubergine default to Slate. If you liked it, pick **Aubergine** in Settings → Appearance.
- The desktop app still doesn't update itself; download the new version.

---

# Paracord 3.1.1

A small follow-up to 3.1.0. These were all found while taking the new screenshots for the README, by using the app the way a newcomer would.

- On a phone, the message box's hint text was cut off mid-phrase ("Say something to the 1"). It now uses a shorter hint that fits.
- In Paper & ink, the mention count in the sidebar was a dark red number on the blue sidebar and nearly impossible to read. The sidebar now has its own readable colors for counts and warnings.
- A channel's "last message" line on a server's front page showed a number like `<@3604144…>` when the message started with an @mention. It shows the person's name now. The same fix applies to Home's conversation previews and to desktop notifications.
- Replying to a message that starts with a code block showed the raw ``` markers in the little quote above your reply. It shows the code itself now.
- A new server was created with a text channel called "general" and a voice channel called "General", which looked like a mistake sitting next to each other. The voice channel is now called "Lounge". Existing servers aren't touched, and you can rename it like any other channel.

Compare: [v3.1.0...v3.1.1](https://github.com/Scdouglas1999/Paracord/compare/v3.1.0...v3.1.1)

Nothing else changed, so the [3.1.0 notes](#paracord-310) below still describe this release. Upgrade the same way: run the install command again, or download the new installers.

---

# Paracord 3.1.0

3.0.0 was built and tested but never made public, so for most people this is the first release since 2.0. Everything in the 3.0.0 notes further down is new to you too. This section covers what changed after 3.0.0.

Compare: [v2.0.0...v3.1.0](https://github.com/Scdouglas1999/Paracord/compare/v2.0.0...v3.1.0)

## Three new looks

The dark theme was too gray. Most of the screen was the same near-black with small gray text, and the only color came from people being online, so a quiet server looked dead.

- The default dark theme now has real color: the sidebar side is a deep blue, the panels you read in are warm, and empty channels no longer show up as black holes.
- **Voices is the new default** for fresh installs and for accounts that never picked a theme. If you chose a theme before, you keep it.
- Settings → Appearance has three new options under the existing themes. They switch instantly.
  - **Dusk sky** puts a sunset behind the whole app, with dark glass panels over it.
  - **Paper & ink** is a light look: cream paper, dark ink, a solid blue sidebar and hard printed-style shadows.
  - **Voices** puts every message in a bubble tinted with its author's color. Yours sit on the right.
- Each of the three brings its own colors, so the accent and base color pickers are switched off while one is on. Pick Night, Daylight, AMOLED or High contrast to get them back.
- You can pick the base color of the four regular themes (a few presets or any hue), and it changes as you drag. Text stays readable whatever you pick.
- Names in chat are written in each person's own color, and the Friends list uses the same colors instead of green for everyone.

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
- **Linux with NVIDIA's driver:** the app opened a black window and crashed when you clicked anything. It now turns off WebKit's GPU compositing on those machines and renders normally. Video never went through that path, so it's unaffected. Set `PARACORD_WEBKIT_ACCELERATION=ondemand` to get the old behavior back if your driver copes.

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

- The server's own tests (1,732 of them) and the client's (2,839) pass. So do the color-contrast check across all seven themes, the accessibility check, and 92 browser tests against a mocked server.
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
- Various inputs that accepted anything (reactions, channel types, role colors, scheduled send times, permission bits) are now checked.

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
