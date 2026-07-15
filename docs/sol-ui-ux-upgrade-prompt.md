# Prompt for GPT 5.6-Sol — Paracord UI/UX Upgrade

Copy everything below the line into Sol / GPT 5.6-Sol.

---

You are GPT 5.6-Sol (Sol). Your job is to thoughtfully upgrade the UI and UX of **Paracord**, a decentralized, self-hostable Discord alternative (React 19 + Tauri v2 client under `client/`).

You are not being handed a punch list. You are being handed a **map of the product as it exists**, tensions that showed up when the app was scoped end-to-end, and permission to explore, decide, and ship judgment. Treat the notes below as jumping-off points. Some will matter a lot; some you may dismiss after looking at the code. That is expected.

Do **not** make changes for the sake of change. Prefer fewer, clearer decisions over a spray of polish. When you change something, understand the job it serves and what else in the app shares that job.

---

## Product context (read before designing)

Paracord already has two governing docs. Treat them as **current law unless you consciously revise them**:

- `docs/design-spec.md` — **Emerald Commons**: warm-neutral dark, emerald meaning-color, Fraunces + Inter, anti-slop kill-list (no purple gradient marketing looks, no grain/glow chrome, no emoji decoration, restrained motion).
- `docs/layout-spec.md` — **Rooms + Unified Stream**: Discord’s guild rail + always-visible channel column was intentionally retired. Live shell is Unified Sidebar | full-width main canvas | optional ContextPanel. Guilds open on a presence-first **Rooms** home.

Discord is useful as **interaction familiarity** (message density, mute/deaf, Esc stacks, hover actions). It is **not** the visual or IA source of truth. Do not “make it look more like Discord” by default. Do not invent a new brand either—deepen Emerald Commons and the Rooms thesis, or argue clearly if a thesis should change.

Client root: `client/src/`. Key entry points: `App.tsx`, `pages/AppShell.tsx`, `pages/HomePage.tsx`, `pages/GuildHomePage.tsx`, `pages/GuildPage.tsx`, `pages/DMPage.tsx`.

---

## How to work

1. **Explore before editing.** Read the specs, then walk the real surfaces (shell, home, rooms, chat, voice, settings, auth). Use the file pointers below; follow imports and tests as behavior docs.
2. **Decide jobs first.** For each surface you touch, name the primary user job in one sentence. If two surfaces claim the same job, decide which is canonical and what the other becomes.
3. **Prefer coherence over novelty.** Shared primitives (`components/ui/`), tokens (`styles/tokens.css`, `hooks/useTheme.ts`), and shared chat spine (`MessageList` + `MessageInput`) are gravity wells—lean into them unless you have a strong reason not to.
4. **Ship in coherent slices.** A navigation/attention decision, a chat hierarchy decision, a voice control hierarchy decision, a settings IA decision, etc. Avoid drive-by renames across the whole app in one pass unless terminology is the slice.
5. **Keep a11y and keyboard.** Focus rings, Esc precedence, reduced motion, and `useKeyboardNavigation` / Help overlay completeness matter. Don’t regress them for chrome.
6. **You own the taste.** If something in this prompt feels wrong after you see the product, say so in your reasoning and do the better thing.

---

## The app as a set of jobs (explore these)

### Shell & attention
The authenticated frame is a two-zone shell: one cross-server **Unified Sidebar** (NeedsYou → Pinned → Recent → Spaces + CallDock/UserPanel) and a full-width destination. **App Home** is a pulse/catch-up canvas; **Guild Home (Rooms)** is a place map; chat/voice are destinations with **TopBar** chrome.

Things worth thinking about (not necessarily fixing):
- How many “continue / catch up” surfaces earn a place? NeedsYou, Inbox, Home Pick-up, Summary, unread badges, and quiet-state Jump-in all overlap.
- Home’s `isQuiet` gating: Resume hero and Jump-in tiles hide when any live room or online friend exists—active users may lose growth shortcuts and their primary-space CTA. Intentional pulse-first design, or over-hiding?
- NeedsYou caps at 6 with no “+N more”; RecentList is uncapped and can bury Spaces in the shared sidebar scroll. Expanded SpacesList lacks the attention dots the collapsed rail shows.
- RecentList footer “All conversations →” lands on `/app/dms` (DM-only)—label vs destination mismatch worth noticing.
- Where does the channel list live while chatting? It moved to Rooms home—power users may feel lost without a floor plan. Is breadcrumb + ⌘K + Alt↑↓ enough, or does ChatView need a lightweight switcher?
- Discovery and Templates are second-class in primary nav. Should they be?
- “Open this space” is inconsistent: SpacesList/Home → Rooms; Command Palette often → first text channel; mobile Space tab → last channel; invite/create sometimes → first channel.
- TopBar is dense on guild text (search, summary, pins, threads, economy, members, inbox, help, settings…). Which actions are channel-local vs space-global vs account-global?
- HomeServersRail lists every space with no cap; Friends `PersonRow` is not a clickable row (unlike `ConversationRow`)—Message is hover-revealed on desktop.

Start: `AppShell.tsx`, `UnifiedSidebar.tsx`, `TopBar.tsx`, `HomePage.tsx` + `components/home/*`, `FriendsPage.tsx`, `DiscoveryPage.tsx`, `CommandPalette.tsx`, `MobileBottomNav.tsx`, `docs/layout-spec.md`.

### Rooms & guild-as-place
Guild home is presence-first: live voice/stage cards, around-now strip, then text channels. Voice is social-first via RoomCards and VoiceLobby; text is below or in ChatView.

Things worth thinking about:
- Space Hub settings (banner, welcome copy, pinned channels) appear **orphaned**—configured in admin, not clearly consumed by RoomsView. What is Hub for now? This is one of the sharpest admin→member gaps in the app.
- Terminology drifts: Space / Server / Guild / Room. Pick a user-facing vocabulary and be consistent—or consciously keep code “guild” with product “space.”
- Welcome / onboarding / invite verification can stack as multiple “rules / get started” moments (`GuildWelcomeScreen` + `GuildOnboardingGate` at different z-indexes) on channel entry, while the designed front door is Rooms.
- Quiet guilds: when nothing is live, does the stack still feel presence-first, or does it collapse into a channel list with a thin presence header?
- Occupancy is shown in many places (RoomCard stacks, VoiceLobby, sidebar VoiceChannelOccupants, in-call UI). Intentional density tiers, or noise?
- Economy Coins on the guild home header may show even when economy isn’t meaningfully configured; stage Join can appear disabled with little explanation when no stage instance exists.

Start: `RoomsView.tsx`, `GuildHomeHeader.tsx`, `RoomCard.tsx`, `VoiceLobby.tsx`, `ServerHubSettings.tsx`, `GuildWelcomeScreen.tsx`, `GuildOnboardingGate.tsx`.

### Messaging
Almost every chat surface reuses `MessageList` + `MessageInput`. Discovery of history is split: channel Search, Pins, Inbox, NeedsYou, Command Palette, forum-local search, AI Summary.

Things worth thinking about:
- Thread dual-pane: parent in main (read-only), thread in ContextPanel—strong for “don’t lose place,” weak for “this is the conversation.” Forum posts and in-list reply trees add two more hierarchy shapes. Thread header parent name isn’t a nav link; delete may show without clear permission gating.
- Composer is a mode machine (markdown, emoji, GIF-as-URL, stickers, poll, schedule, slash, mentions). Progressive disclosure vs always-visible icons? GIF uses a generic Image icon; GIF/Sticker/Emoji are three separate floaters—unified sheet?
- Forum new-post is a plain modal textarea (no markdown toolbar) while every other compose path uses `MessageInput`; forum sort appears channel-wide rather than personal preference; cards lack content previews; forum search doesn’t join the `#msg-` jump contract.
- Jump-to-message via `window.location.hash` (search/pins) may be fragile and often lacks a highlight flash on the target row. Unread divider / “new since you left” may be thin relative to read-state machinery.
- Two meanings of “pin”: conversation pins (sidebar) vs message pins (overlay).
- Search: ⌘K goes somewhere; ⌘F finds text in *this* channel only (25-result cap, raw previews). Guild-wide search?
- DM index: no timestamps, no search/filter, friends-only `DmPickerModal` with a easy-to-miss Single/Group toggle and no friend search. Group member add affordances may outrun owner permissions in the UI.
- `InteractionModal` mounts inside `MessageInput`—bot modals depend on composer being mounted.
- MessageList/MessageInput are very large; UX changes may want surgical slices rather than a rewrite—unless decomposition is required for the UX decision.

Start: `MessageList.tsx`, `MessageInput.tsx`, `ThreadPanel.tsx`, `ForumView.tsx`, `TextChannelView.tsx`, `DMPage.tsx`, `DmPickerModal.tsx`, overlays under `layout/overlays/`, `NeedsYou.tsx`.

### Voice & video
`VoiceStageChannel` is the spine (lobby → connected layouts). Persistence via CallDock / MiniVoiceBar. Watch is explicit (not auto-subscribe). Layout modes: top / side / pip / hidden + split dual-source.

Things worth thinking about:
- Mute/deaf live in UserPanel + CallDock + VoiceControlBar (+ keybinds). What’s the control hierarchy when connected vs not?
- Devices and processing live mostly in User Settings—no Discord-like in-call device chevron. Mic level data exists but isn’t shown.
- Capture quality vs view quality are two menus; labeling may confuse.
- Stage: lobby management is fairly complete; connected stage UI feels thin (no raise-hand / audience self-serve). Is stage a distinct product or a permission mode on voice?
- DM calls are a thinner parallel surface (less layout/chat parity).
- Hover-revealed layout switchers are weak on touch.

Start: `VoiceStageChannel.tsx`, `VoiceControlBar.tsx`, `MiniVoiceBar.tsx`, `StreamViewer.tsx`, `VideoGrid.tsx`, `CallDock.tsx`, `UserPanel.tsx`, `useVoice.ts`.

### Secondary surfaces (panels, overlays, menus)
Three families: toggleable right **ContextPanel**, TopBar-local **popovers**, always-on sidebar **attention**. Pins/search are still modals despite living under `contextPanelMode`. Menu primitives are inconsistent (shared ContextMenu vs bespoke MemberList/UserPanel menus).

Things worth thinking about:
- Should all ContextPanel modes share one interaction model (true rail vs modal for query-heavy tasks)?
- Esc / overlay stack: palette → panel is documented; TopBar popovers sit outside that story.
- Group DM members are harder to reach from TopBar than guild members.
- Economy as a TopBar/ContextPanel peer to members/threads—right placement?

Start: `ContextPanel.tsx`, `TopBar.tsx`, `ui/Modal.tsx`, `ui/ContextMenu.tsx`, `docs/layout-spec.md` § on ContextPanel.

### Guild settings & instance admin
Space settings are a flat ~18-section overlay gated by Manage Guild vs narrower mod perms. Instance Admin (`/app/admin`) is a separate host-operator plane.

Things worth thinking about:
- Permissions: role bitflags, channel overwrites, and channel feature gates are three models with different vocabularies—no effective-access preview. Advanced channel features may hide behind an unlabeled chevron in Channel Manager.
- Welcome copy exists in Overview, Hub, Onboarding, Welcome Bot, and WelcomeScreen—competing sources of truth.
- Bot Store vs Bots; Economy real feature vs Bot Store “upcoming”; Events only inside settings.
- Invite-only mods can open settings but see a thin nav—should mod tools live outside the full settings shell?
- Overlay vs `/settings` route dual path.
- `GuildSettings.tsx` is a large orchestrator (many sections, shared error state, heavy `refreshAll` on open). UX upgrades may need section-boundary splits to stay safe—decide whether architecture is in scope for your slice.

Start: `GuildSettings.tsx`, `ChannelManager.tsx`, `ChannelPermissionsEditor.tsx`, `OnboardingSettingsSection.tsx`, `BotStoreSection.tsx`, `AdminPage.tsx`.

### Auth, join, friends, discovery, account
Server-connect-first product. Password auth is default; device crypto is optional and parallel. Friends is a primary nav peer; Discovery is not.

Things worth thinking about:
- Two passwords / two identity stories (server account vs device unlock)—clarity risk, especially with similar “Welcome back” chrome.
- Invite → register may not preserve pending invite the way login does.
- Connect is one powerful field (URL / invite / portable link)—or should first-run offer explicit modes (Invite / Server / Demo)?
- Discovery: fetches a fixed page (`limit=50`) while showing a total count; categories are hardcoded; back goes to `/app` not history; Join is one-click with no preview sheet—growth surface vs commitment UX.
- Friends: Online/All/Requests/Blocked is solid; row hit-target and profile-from-list may be thin; Blocked tab always visible at zero.
- Settings: My Account is a kitchen sink (profile + MFA + sessions + crypto toggle); Identity is Advanced; no clear Privacy umbrella.
- Profile popup mixes casual social actions with dense QR identity verification.
- Vocabulary on these surfaces alone: Spaces / Servers / Communities / Guilds.

Start: `authScaffold.tsx`, `ServerConnectPage.tsx`, `LoginPage.tsx`, `InvitePage.tsx`, `FriendsPage.tsx`, `DiscoveryPage.tsx`, `UserSettings.tsx`, `UserProfile.tsx`, `OnboardingWizard.tsx`.

### Design system & craft
Tokens and `Button`/`Input`/`Modal` are strong; legacy `.btn-primary` / `.input-field` and orphaned Architect CSS still create dual languages. Density tokens exist but are under-consumed. Accent presets can diverge from brand teal secondary.

Things worth thinking about:
- Single control language going forward?
- How much Fraunces personality on Home/auth before chat feels like a different product?
- Card budget on Home (kill-list: not everything is a card).
- Light / AMOLED / high-contrast as first-class when you change chrome.
- Help overlay completeness vs real keybinds.

Start: `docs/design-spec.md`, `styles/tokens.css`, `styles/components.css`, `styles/layout.css`, `components/ui/*`, `useTheme.ts`.

---

## Cross-cutting themes (decide deliberately)

These showed up across multiple surfaces. You do not need to “solve” all of them; you should notice when your work touches them.

1. **Attention hierarchy** — one story for what needs the user now vs what’s merely unread vs what’s a digest.
2. **Enter-a-space contract** — always Rooms, always last channel, or context-dependent—but teachable.
3. **Channel switching while chatting** — how much Discord muscle memory to restore without undoing Rooms.
4. **Control hierarchy in voice** — one persistent dock story; mute/deaf/camera/stream discoverability.
5. **Side conversations** — reply trees vs threads vs forum posts: when is each the right shape, and which owns the main pane?
6. **Secondary chrome budget** — sidebar + panel + modal + mini voice bar: what’s allowed simultaneously, especially on mobile?
7. **Admin vs member surfaces** — Hub/onboarding/events/economy: configure once, consume clearly.
8. **Vocabulary** — Space/Server/Guild/Room/Pin/Search each mean too many things in places.
9. **Multi-server** — active server switching is powerful and often invisible; presence and friends copy may need to acknowledge it.
10. **Legacy vs law** — Architect CSS, unused `VoiceChannel.tsx` / `friendStore`, modal-as-panel modes: retire, restore, or reinterpret intentionally.

---

## Constraints & taste

- Obey Emerald Commons and the kill-list unless you are explicitly revising the design spec (and if you revise it, update the doc).
- Do not introduce purple-on-white marketing gradients, warm-cream-serif terracotta clichés, broadsheet newspaper layouts, ambient glow stacks, or emoji chrome.
- Prefer tokens and shared primitives over one-off hex and parallel CSS button recipes.
- Self-host and federation are real: don’t assume a single cloud SaaS onboarding fantasy, but do make invite/connect feel human.
- Native voice/video has platform-sensitive compositing (e.g. Linux underlays)—don’t “simplify” stream chrome in ways that break native render without checking.
- Tests under `*.test.tsx` often encode intended UX contracts—read them before changing behavior.
- No need to rewrite the backend for a UI pass; stay in the client unless a tiny API affordance is truly blocking a UX decision you own.

---

## Suggested exploration order (optional)

If you want a path in, something like:

1. Re-read `docs/design-spec.md` + `docs/layout-spec.md` and skim AppShell → Home → Guild Home → a text channel → a voice lobby.
2. Pick **one** coherence problem that bothers you most after that walk (attention, channel switching, voice controls, welcome/hub, or settings IA).
3. Decide the job model, then implement the smallest UI that makes that decision real.
4. Widen only when the decision forces neighboring surfaces to change.
5. Leave the product more teachable than you found it—fewer synonymous surfaces, clearer primary jobs, same or better keyboard/a11y.

You are trusted to explore the codebase, form your own opinions, and upgrade the experience. This prompt is a briefing, not a cage.
