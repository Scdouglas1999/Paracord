import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';

import { useUIStore } from '../../../stores/uiStore';
import { useAuthStore } from '../../../stores/authStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useVoice } from '../../../hooks/useVoice';
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
        role="listbox"
        aria-label="Joined servers"
        className="flex flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none"
      >
        {spaces.map((space) => {
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

export interface UnifiedSidebarProps {
  /** Muted guild ids — forwarded to the unified selector so muted channels carry no signals. */
  mutedGuildIds?: string[];
}

export function UnifiedSidebar({ mutedGuildIds = [] }: UnifiedSidebarProps) {
  const navigate = useNavigate();
  const params = useParams();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const activeServerId = useServerListStore((s) => s.activeServerId);

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

  const openConversation = (entry: ConversationEntry) => {
    if (activeServerId !== entry.serverId) {
      useServerListStore.getState().setActive(entry.serverId);
    }
    if (entry.kind === 'guild_home' && entry.guildId) {
      navigate(`/app/guilds/${entry.guildId}`);
    } else if (entry.guildId) {
      navigate(`/app/guilds/${entry.guildId}/channels/${entry.channelId}`);
    } else {
      navigate(`/app/dms/${entry.channelId}`);
    }
  };

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
        aria-orientation="vertical"
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2 scrollbar-thin"
      >
        <NeedsYou entries={needsYou} activeKey={activeKey} onSelect={openConversation} navIndexStart={0} />
        <PinnedRail entries={pinned} activeKey={activeKey} onSelect={openConversation} navIndexStart={pinnedStart} />
        <RecentList entries={recent} activeKey={activeKey} onSelect={openConversation} navIndexStart={recentStart} />
        <SpacesList spaces={spaces} activeGuildId={activeGuildId} navIndexStart={spacesStart} />
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
