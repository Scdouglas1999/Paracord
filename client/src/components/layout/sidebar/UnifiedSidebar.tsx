import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import { Search, Home, Users, MessageCircle, Plus } from 'lucide-react';

import { useUIStore } from '../../../stores/uiStore';
import { useAuthStore } from '../../../stores/authStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useVoice } from '../../../hooks/useVoice';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { conversationKey } from '../../../lib/attention/conversationModel';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { GuildSummary, FriendRequestEntry } from '../../../hooks/useUnifiedConversations';
import { LOCAL_SERVER_ID } from '../../../lib/connectionManager';
import { isAdmin as isGlobalAdmin } from '../../../types';
import { cn } from '../../../lib/utils';
import { displayName } from '../../../lib/displayName';
import { guildInitials, resolveGuildIconUrl } from '../../../lib/guildIcon';

import { SidebarSearch } from './SidebarSearch';
import { AnchorNav } from './AnchorNav';
import { NeedsYou } from './NeedsYou';
import { PinnedRail } from './PinnedRail';
import { RecentList } from './RecentList';
import { SpacesList } from './SpacesList';
import { CallDock } from './CallDock';
import { UserPanel } from '../UserPanel';
import { CreateGuildModal } from '../../guild/CreateGuildModal';

const RECENT_COLLAPSED_CAP = 5;

/**
 * The Unified Sidebar (layout-spec §1, §6, §7.7) — the single left rail that
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

/** One 40px icon button in the collapsed rail (search / anchor / add-space). */
function CollapsedIconButton({
  label,
  active = false,
  badge = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'relative flex h-10 w-10 items-center justify-center rounded-md outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
        active
          ? 'bg-accent-tint text-accent-primary'
          : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-primary',
      )}
    >
      {children}
      {badge && (
        <span
          data-testid="anchor-attention-dot"
          aria-hidden
          className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-accent-primary ring-2 ring-bg-secondary"
        />
      )}
    </button>
  );
}

/** Collapsed 64px icon rail (§6). Anchors + space avatars + attention dots, mini call dock, user. */
function CollapsedRail({
  spaces,
  attentionGuildIds,
  activeGuildId,
  friendRequestCount,
  onAddSpace,
}: {
  spaces: GuildSummary[];
  attentionGuildIds: Set<string>;
  activeGuildId: string | null;
  friendRequestCount: number;
  onAddSpace: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
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

      {/* Fixed anchors — the always-present Home / Friends / Messages destinations. */}
      <CollapsedIconButton
        label="Home"
        active={pathname === '/app' || pathname === '/app/'}
        onClick={() => navigate('/app')}
      >
        <Home size={18} aria-hidden />
      </CollapsedIconButton>
      <CollapsedIconButton
        label="Friends"
        active={pathname.startsWith('/app/friends')}
        badge={friendRequestCount > 0}
        onClick={() => navigate('/app/friends')}
      >
        <Users size={18} aria-hidden />
      </CollapsedIconButton>
      <CollapsedIconButton
        label="Messages"
        active={pathname.startsWith('/app/dms')}
        onClick={() => navigate('/app/dms')}
      >
        <MessageCircle size={18} aria-hidden />
      </CollapsedIconButton>

      <div className="h-px w-8 shrink-0 bg-border-subtle" />

      <div
        data-roving-container=""
        role="listbox"
        aria-label="Joined spaces"
        aria-orientation="vertical"
        className="flex flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none"
      >
        {spaces.map((space, i) => {
          const active = space.id === activeGuildId;
          const hasAttention = attentionGuildIds.has(space.id);
          const iconSrc = resolveGuildIconUrl({ icon: space.icon });
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
                'group relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-meta font-semibold outline-none transition-[border-radius,background-color,color] duration-[180ms] ease-[var(--ease-out)] hover:rounded-md focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]',
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
              {iconSrc ? (
                <img src={iconSrc} alt="" className="h-full w-full object-cover" />
              ) : (
                guildInitials(space.name)
              )}
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

      {/* Persistent create/join-server entry below the space icons. */}
      <CollapsedIconButton label="Add a space" onClick={onAddSpace}>
        <Plus size={18} aria-hidden />
      </CollapsedIconButton>

      <div className="mt-auto flex flex-col items-center gap-2">
        <CallDock collapsed />
        <button
          type="button"
          aria-label="Open user settings"
          onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary text-label font-semibold text-text-on-accent shadow-sm outline-none transition-transform duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]"
        >
          {displayName(user).charAt(0).toUpperCase()}
        </button>
      </div>
    </div>
  );
}

export function UnifiedSidebar() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const activeServerId = useServerListStore((s) => s.activeServerId);

  // The muted-guild set — read live from the shared producer/consumer so muted
  // guilds carry no attention signal in the merge (§3.2). SpacesList is the writer.
  const { mutedGuildIds } = useMutedGuilds();
  const { needsYou, needsYouOverflowCount, recent, pinned, spaces, requests } =
    useUnifiedConversations(mutedGuildIds);
  const userPanel = useUserPanelWiring();

  // The create/join-server flow reuses the existing CreateGuildModal (Create/Join/
  // Template tabs), mounted once and opened from the expanded "Add a space" row or the
  // collapsed "+" button — the same modal HomePage's quick action mounts. Not rebuilt.
  const [showCreateGuild, setShowCreateGuild] = useState(false);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const openCreateGuild = useCallback(() => setShowCreateGuild(true), []);

  const activeServer = activeServerId ?? LOCAL_SERVER_ID;
  const activeChannelId = params.channelId ?? null;
  const activeGuildId = params.guildId ?? null;
  const activeKey = activeChannelId ? conversationKey(activeServer, activeChannelId) : null;

  // Recent is a movement aid, not an archive. Keep five rows visible by default
  // so Spaces cannot be buried; retain an active older row as a sixth exception.
  const visibleRecent = useMemo(() => {
    if (recentExpanded || recent.length <= RECENT_COLLAPSED_CAP) return recent;
    const first = recent.slice(0, RECENT_COLLAPSED_CAP);
    if (!activeKey || first.some((entry) => entry.key === activeKey)) return first;
    const activeEntry = recent.find((entry) => entry.key === activeKey);
    return activeEntry ? [...first, activeEntry] : first;
  }, [activeKey, recent, recentExpanded]);

  // Guilds with an attention signal → both collapsed and expanded Space dots.
  // Attention overflow beyond the Needs-you cap currently continues in Recent,
  // so inspect both partitions rather than silently dropping those guilds.
  const attentionGuildIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of [...needsYou, ...recent]) {
      if (
        e.guildId &&
        (e.mentionCount > 0 ||
          e.isDMUnread ||
          e.isThreadReply ||
          e.unread ||
          e.hasVoiceActivity)
      ) {
        set.add(e.guildId);
      }
    }
    return set;
  }, [needsYou, recent]);

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

  // Fixed-anchor + zero-state navigation callbacks (stable identities). A friend
  // request row and the "Add a friend" zero-state action both land on /app/friends.
  const goFriends = useCallback(() => navigate('/app/friends'), [navigate]);
  const goDiscovery = useCallback(() => navigate('/app/discovery'), [navigate]);
  const openRequest = useCallback((_r: FriendRequestEntry) => navigate('/app/friends'), [navigate]);

  // -- Flat roving-tabindex ordinals (§5). Anchors come FIRST, then Needs-you (its
  //    friend-request rows before its conversation rows), Pinned, Recent, and Spaces
  //    (whose trailing "Add a space" row closes out the order). --
  const ANCHOR_COUNT = 3;
  const needsYouStart = ANCHOR_COUNT; // request rows occupy [3 .. 3+requests-1]
  const needsYouConvStart = needsYouStart + requests.length; // conversation rows follow
  const pinnedStart = needsYouConvStart + needsYou.length;
  const recentStart = pinnedStart + pinned.length;
  const spacesStart = recentStart + visibleRecent.length;

  const pathname = location.pathname;
  const homeActive = pathname === '/app' || pathname === '/app/';
  const friendsActive = pathname.startsWith('/app/friends');
  const messagesActive = pathname.startsWith('/app/dms');

  // Roving tabindex: exactly ONE element is a Tab stop; every other is tabIndex -1 and
  // reached via the arrow handler's .focus(). Prefer an open conversation/space, else
  // the active anchor route, else Home (index 0) as the default entry point (§5).
  let activeNavIndex = 0;
  const inNeeds = activeKey ? needsYou.findIndex((e) => e.key === activeKey) : -1;
  const inPinned = activeKey ? pinned.findIndex((e) => e.key === activeKey) : -1;
  const inRecent = activeKey ? visibleRecent.findIndex((e) => e.key === activeKey) : -1;
  const inSpaces = activeGuildId ? spaces.findIndex((s) => s.id === activeGuildId) : -1;
  if (inNeeds >= 0) activeNavIndex = needsYouConvStart + inNeeds;
  else if (inPinned >= 0) activeNavIndex = pinnedStart + inPinned;
  else if (inRecent >= 0) activeNavIndex = recentStart + inRecent;
  else if (inSpaces >= 0) activeNavIndex = spacesStart + inSpaces;
  else if (friendsActive) activeNavIndex = 1;
  else if (messagesActive) activeNavIndex = 2;
  else if (homeActive) activeNavIndex = 0;

  return (
    <>
      {sidebarCollapsed ? (
        <aside aria-label="Navigation" data-collapsed="true" className="h-full shrink-0 border-r border-border-subtle">
          <CollapsedRail
            spaces={spaces}
            attentionGuildIds={attentionGuildIds}
            activeGuildId={activeGuildId}
            friendRequestCount={requests.length}
            onAddSpace={openCreateGuild}
          />
        </aside>
      ) : (
        <aside
          aria-label="Navigation"
          data-collapsed="false"
          style={{ '--preferred-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
          className="flex h-full w-[88vw] shrink-0 flex-col border-r border-border-subtle bg-bg-secondary md:w-[min(var(--preferred-sidebar-width),32vw)]"
        >
          <div className="shrink-0 p-2">
            <SidebarSearch />
          </div>

          <div
            data-roving-container=""
            role="listbox"
            aria-label="Navigation and conversations"
            aria-orientation="vertical"
            className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2 pt-2 scrollbar-thin"
          >
            <AnchorNav friendRequestCount={requests.length} navIndexStart={0} activeNavIndex={activeNavIndex} />
            <NeedsYou
              entries={needsYou}
              overflowCount={needsYouOverflowCount}
              requests={requests}
              onOpenRequest={openRequest}
              activeKey={activeKey}
              onSelect={openConversation}
              navIndexStart={needsYouStart}
              activeNavIndex={activeNavIndex}
            />
            <PinnedRail entries={pinned} activeKey={activeKey} onSelect={openConversation} navIndexStart={pinnedStart} activeNavIndex={activeNavIndex} />
            <RecentList
              entries={visibleRecent}
              activeKey={activeKey}
              onSelect={openConversation}
              onAddFriend={goFriends}
              onExploreServers={goDiscovery}
              totalCount={recent.length}
              expanded={recentExpanded}
              onToggleExpanded={() => setRecentExpanded((value) => !value)}
              navIndexStart={recentStart}
              activeNavIndex={activeNavIndex}
            />
            <SpacesList spaces={spaces} attentionGuildIds={attentionGuildIds} activeGuildId={activeGuildId} onAddSpace={openCreateGuild} navIndexStart={spacesStart} activeNavIndex={activeNavIndex} />
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
      )}
      {showCreateGuild && <CreateGuildModal onClose={() => setShowCreateGuild(false)} />}
    </>
  );
}
