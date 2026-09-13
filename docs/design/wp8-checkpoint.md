# WP8 — The sweep

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §10, row **WP8**.
Branch: `design/lantern-stage`. This package closes the overhaul: it collects
every "left for later" note WP0–WP7 wrote down, removes what the overhaul
replaced, re-homes the one feature a deleted component took with it, and runs
the whole gate.

---

## 1. The checklist

Every item below was read out of a WP0–WP7 checkpoint, out of the WP8 brief, or
out of the orchestrator's review of the landed frames. Disposition is filled in
as each one lands; §2 onwards is the detail.

### A. Deferred by the checkpoints

| # | From | Item | Disposition |
|---|---|---|---|
| A1 | WP5 §6 | `e2e/smoke.spec.ts:698` matches the buildings listbox option with `/QA Guild lobby/i`, which cannot match the long fixture name | |
| A2 | WP5 §6 | `e2e/production-messaging.spec.ts` + `e2e/real-server.smoke.spec.ts` still select the old `Message #channel` placeholder | |
| A3 | WP5 §5.1, §6 | `ContextPanel`'s `members` mode and the mobile swipe that opens it — the last docked-member-list door | |
| A4 | WP5 §6 | `.chat-header-action` / `.chat-header-active` are dead in `styles/components.css` | |
| A5 | WP7 §8 | `.settings-nav-item` is dead in `styles/components.css` | |
| A6 | WP0 §8, WP7 §8 | `.glass-rail` / `.glass-panel` / `.glass-modal` / `.glass-sidebar` class names with no glass in them | |
| A7 | WP3 §6, §7 | three broken `text-text-text-body` utilities in `pages/DesignTokensPage.tsx` | |
| A8 | WP4 §1, §7 | retire the deprecated `components/rooms/RoomCard.tsx` + `OccupantStack.tsx` pair | |
| A9 | WP3 §7 | `components/layout/VoiceParticipants.tsx` renders a participant list in the old vocabulary | |
| A10 | WP7 §8 | `LitAvatar` adoption where settings/admin show an avatar with presence | |
| A11 | WP7 §8 | the Title-Case product-string copy pass (sentence case), with the e2e/unit assertions that pin those strings | |
| A12 | WP3 §6 | the two static-a11y findings: `components/home/HomeAddBuilding.tsx`, `components/message/TimelineParts.tsx` | |
| A13 | WP7 §8 | `CommandPalette` / `DiscoveryPage` pass dead `panelClassName` overrides to `Modal` | |
| A14 | WP2 §8 | three stale prose references to deleted components (`pinnedStore`, `useUnifiedConversations`, `GuildSettingsPage`) | |
| A15 | WP2 §8 | `sidebar/CallDock.tsx`'s collapsed variant paints `bg-accent-tint` + `ring-bg-secondary` | |
| A16 | WP0 §8 | `data-testid="presence-dot"` in `ConversationRow` now labels an `sr-only` status span | |
| A17 | WP0 §8 | ~40 avatar fallbacks still paint `bg-accent-primary`; a person is not an action | |
| A18 | WP0 §8, WP7 §8 | badge-sized `uppercase` labels | |
| A19 | WP7 §8 | `pages/FriendsPage.tsx` / `pages/DiscoveryPage.tsx` generic empty states | |
| A20 | WP7 §8 | `pages/developer/CreateBotForm.tsx` uses `Input` + `sr-only` labels rather than `TextField` | |
| A21 | WP0 §8 | point `docs/design-spec.md` at the Lantern Stage spec | |
| A22 | WP8 brief | `docs/layout-spec.md` §7 "Rooms recipes" still names the replaced components | |

### B. The brief's own scope

| # | Item | Disposition |
|---|---|---|
| B1 | Hub welcome copy / banner / featured rooms lost with `SpaceBriefing` — give them a restrained home in the Lobby, with tests | |
| B2 | Migrate every deprecated WP0 token alias to its v2 name, then delete the aliases | |
| B3 | `--color-status-*`, glass/noise/ambient tokens, Fraunces/Inter — confirm gone | |
| B4 | Hard-coded hex anywhere in `client/src` outside `tokens.css`; extend WP0's literal-colour test to a repo-wide lint | |
| B5 | Leftover uppercase section labels, emoji chrome | |
| B6 | Delete unused components / hooks / CSS (verified with imports + `tsc` + tests) | |
| B7 | README screenshots regenerated from the new UI; captions and copy in the new vocabulary | |
| B8 | The full gate, and fix what fails at the root | |
| B9 | A complete design-review capture into `output/design-reference/final/`, every surface at 1440×900 and 390×844, every frame inspected | |

### C. The orchestrator's review of the landed frames

| # | Item | Disposition |
|---|---|---|
| C1 | `RoomThumbnail`'s lamp reads as a grey haze over the top-left third of every live thumbnail; the reference paints `radial-gradient(70% 120% at 20% 0%, …)` into a `#101a16` frame | |
| C2 | The Stage frame has no Buildings column; `Main.html` keeps the 276px column beside the Stage on desktop | |
| C3 | The text-room header shows only the room name; §7.4 puts "Kestrel Robotics · <topic>" under it | |
| C4 | The WP5 fixture had an empty sidebar and "0 reading · 0 lights on" — the final set must judge these surfaces lit | |
