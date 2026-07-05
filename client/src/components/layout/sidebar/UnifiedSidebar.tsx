import { useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';

import { useUIStore } from '../../../stores/uiStore';
import { useAuthStore } from '../../../stores/authStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useVoice } from '../../../hooks/useVoice';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { conversationKey } from '../../../lib/attention/conversationModel';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';
import { LOCAL_SERVER_ID } from '../../../lib/connectionManager';
import { isAdmin as isGlobalAdmin } from '../../../types';
import { cn } from '../../../lib/utils';

import { SidebarSearch } from './SidebarSearch';
import { NeedsYou } from './NeedsYou';
import { PinnedRail } from './PinnedRail';
import { RecentList } from './RecentList';
import { SpacesList } from './SpacesList';
import { CallDock } from './CallDock';
import { UserPanel } from '../UserPanel';

/**
 * The Unified Sidebar (layout-spec §1, §6, §7.6) — the single left rail that
 * REPLACES both the Discord guild rail and the channel column. A ~300px collapsible
 * column on `--bg-secondary` (elevation ramp), fed entirely by the one memoized
 * `useUnifiedConversations` cross-server selector.
 *
 * Vertical stack (design-spec §7 Nav item / Input / Card, §1.1 elevation, kill-list
 * enforced):
 *   SidebarSearch (⌘K entry) → NeedsYou → PinnedRail → RecentList → SpacesList,
 *   footer pinned to the bottom: CallDock (only when voice connected) → UserPanel.
 *
 * Collapse (`uiStore.sidebarCollapsed`, §6): a 64px icon rail — Space avatars with
 * attention dots + a mini CallDock + the user avatar — so navigation survives collapse.
 * Expanded width is the user-resizable `uiStore.sidebarWidth`.
 *
 * Roving-tabindex container attributes are present (`data-roving-container`); rows carry
 * `data-nav-index` in the flat order Needs-you → Pinned → Recent → Spaces. The arrow-key
 * handler lands in SHELL-5 (layout-spec §5).
 */

function useUserPanelWiring() {
  const user = useAuthStore((s) => s.user);
  const { selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice();
  const showAdminDashboard = Boolean(user && isGlobalAdmin(user.flags ?? 0));
  return { user, selfMute, selfDeaf, toggleMute, toggleDeaf, showAdminDashboard };
}

/** Collapsed 64px icon rail (§6). Space avatars + attention dots, mini call dock, user. */
function CollapsedRail({
  spaces,
  attentionGuildIds,
  activeGuildId,
}: {
  spaces: GuildSummary[];
  attentionGuildIds: Set<string>;
  activeGuildId: string | null;
}) {
  const navigate = useNavigate();
  const { user } = useUserPanelWiring();

  const openSpace = (space: GuildSummary) => {
    if (useServerListStore.getState().activeServerId !== space.serverId) {
      useServerListStore.getState().setActive(space.serverId);
    }
    navigate(`/app/guilds/${space.id}`);
  };

  // Roving tabindex for the collapsed rail: exactly one space is a Tab stop (the
  // active one, else the first) and ArrowUp/Down/Home/End move between them via
  // the shared [data-roving-container]/[data-nav-index] handler — so the collapsed
  // rail keeps the same single-tab-stop + arrow affordance as the expanded list
  // instead of making every space icon a Tab stop (layout-spec §5/§6).
  const activeIdx = Math.max(0, spaces.findIndex((s) => s.id === activeGuildId));

  return (
    <div className="flex h-full w-16 flex-col items-center gap-2 bg-bg-secondary py-3">
      <button
        type="button"
        aria-label="Search — open command palette"
        onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
        className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-tertiary text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
      >
        <Search size={18} aria-hidden />
      </button>

      <div className="h-px w-8 shrink-0 bg-border-subtle" />

      <div
        data-roving-container=""
        role="listbox"
        aria-label="Joined servers"
        aria-orientation="vertical"
        className="flex flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none"
      >
        {spaces.map((space, i) => {
          const active = space.id === activeGuildId;
          const hasAttention = attentionGuildIds.has(space.id);
          return (
            <button
              key={space.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-label={space.name}
              title={space.name}
              data-nav-index={i}
              tabIndex={i === activeIdx ? 0 : -1}
              onClick={() => openSpace(space)}
              className={cn(
                'group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-meta font-semibold outline-none transition-[border-radius,background-color,color] duration-[180ms] ease-[var(--ease-out)] hover:rounded-md focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]',
                active
                  ? 'rounded-md bg-accent-tint text-accent-primary'
                  : 'bg-bg-mod-strong text-text-secondary hover:bg-accent-tint hover:text-accent-primary',
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute -left-3 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary"
                />
              )}
              {space.name
                .split(' ')
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
                .toUpperCase() || '?'}
              {hasAttention && !active && (
                <span
                  data-testid="space-attention-dot"
                  aria-hidden
                  className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-accent-primary ring-2 ring-bg-secondary"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-2">
        <CallDock collapsed />
        <button
          type="button"
          aria-label="Open user settings"
          onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary text-label font-semibold text-text-on-accent shadow-sm outline-none transition-transform duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]"
        >
          {user?.username?.charAt(0).toUpperCase() || 'U'}
        </button>
      </div>
    </div>
  );
}

export function UnifiedSidebar() {
  const navigate = useNavigate();
  const params = useParams();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const activeServerId = useServerListStore((s) => s.activeServerId);

  // The muted-guild set — read live from the shared producer/consumer so muted
  // guilds carry no attention signal in the merge (§3.2). SpacesList is the writer.
  const { mutedGuildIds } = useMutedGuilds();
  const { needsYou, recent, pinned, spaces } = useUnifiedConversations(mutedGuildIds);
  const userPanel = useUserPanelWiring();

  const activeServer = activeServerId ?? LOCAL_SERVER_ID;
  const activeChannelId = params.channelId ?? null;
  const activeGuildId = params.guildId ?? null;
  const activeKey = activeChannelId ? conversationKey(activeServer, activeChannelId) : null;

  // Guilds with a live attention signal → collapsed-rail dot (§6).
  const attentionGuildIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of needsYou) if (e.guildId) set.add(e.guildId);
    return set;
  }, [needsYou]);

  // Stable identity so memoized ConversationRows don't re-render on every parent
  // pass (the per-message re-render storm fix depends on a stable onClick).
  const openConversation = useCallback(
    (entry: ConversationEntry) => {
      if (useServerListStore.getState().activeServerId !== entry.serverId) {
        useServerListStore.getState().setActive(entry.serverId);
      }
      if (entry.kind === 'guild_home' && entry.guildId) {
        navigate(`/app/guilds/${entry.guildId}`);
      } else if (entry.guildId) {
        navigate(`/app/guilds/${entry.guildId}/channels/${entry.channelId}`);
      } else {
        navigate(`/app/dms/${entry.channelId}`);
      }
    },
    [navigate],
  );

  if (sidebarCollapsed) {
    return (
      <aside aria-label="Navigation" data-collapsed="true" className="h-full shrink-0 border-r border-border-subtle">
        <CollapsedRail
          spaces={spaces}
          attentionGuildIds={attentionGuildIds}
          activeGuildId={activeGuildId}
        />
      </aside>
    );
  }

  // Flat roving-tabindex ordinals in the §5 order: Needs-you → Pinned → Recent → Spaces.
  const pinnedStart = needsYou.length;
  const recentStart = pinnedStart + pinned.length;
  const spacesStart = recentStart + recent.length;

  // Roving tabindex: exactly ONE row is a Tab stop (the active conversation/space,
  // else the first row); every other row is tabIndex -1 and reached via the arrow
  // handler's .focus(). Without this each row's native <button> stays a Tab stop,
  // so Tab walks through every merged row (layout-spec §5).
  let activeNavIndex = 0;
  const inNeeds = activeKey ? needsYou.findIndex((e) => e.key === activeKey) : -1;
  const inPinned = activeKey ? pinned.findIndex((e) => e.key === activeKey) : -1;
  const inRecent = activeKey ? recent.findIndex((e) => e.key === activeKey) : -1;
  const inSpaces = activeGuildId ? spaces.findIndex((s) => s.id === activeGuildId) : -1;
  if (inNeeds >= 0) activeNavIndex = inNeeds;
  else if (inPinned >= 0) activeNavIndex = pinnedStart + inPinned;
  else if (inRecent >= 0) activeNavIndex = recentStart + inRecent;
  else if (inSpaces >= 0) activeNavIndex = spacesStart + inSpaces;

  return (
    <aside
      aria-label="Navigation"
      data-collapsed="false"
      style={{ width: `${sidebarWidth}px` }}
      className="flex h-full shrink-0 flex-col border-r border-border-subtle bg-bg-secondary"
    >
      <div className="shrink-0 p-2">
        <SidebarSearch />
      </div>

      <div
        data-roving-container=""
        role="listbox"
        aria-label="Conversations and spaces"
        aria-orientation="vertical"
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2 scrollbar-thin"
      >
        <NeedsYou entries={needsYou} activeKey={activeKey} onSelect={openConversation} navIndexStart={0} activeNavIndex={activeNavIndex} />
        <PinnedRail entries={pinned} activeKey={activeKey} onSelect={openConversation} navIndexStart={pinnedStart} activeNavIndex={activeNavIndex} />
        <RecentList entries={recent} activeKey={activeKey} onSelect={openConversation} navIndexStart={recentStart} activeNavIndex={activeNavIndex} />
        <SpacesList spaces={spaces} activeGuildId={activeGuildId} navIndexStart={spacesStart} activeNavIndex={activeNavIndex} />
      </div>

      <div className="shrink-0">
        <CallDock />
        <UserPanel
          user={userPanel.user}
          navigate={navigate}
          muted={userPanel.selfMute}
          deafened={userPanel.selfDeaf}
          onToggleMute={userPanel.toggleMute}
          onToggleDeaf={userPanel.toggleDeaf}
          showAdminDashboard={userPanel.showAdminDashboard}
        />
      </div>
    </aside>
  );
}
