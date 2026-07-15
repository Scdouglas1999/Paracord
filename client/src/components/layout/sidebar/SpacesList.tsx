import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck, LogOut, Plus, Settings } from 'lucide-react';
import { useServerListStore } from '../../../stores/serverListStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useAuthStore } from '../../../stores/authStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useUIStore } from '../../../stores/uiStore';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { ChannelType } from '../../../types';
import { cn } from '../../../lib/utils';
import { guildInitials, resolveGuildIconUrl } from '../../../lib/guildIcon';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { toast } from '../../../stores/toastStore';
import { confirm } from '../../../stores/confirmStore';
import { canAccessGuildSettingsSync } from '../../../lib/guildSettingsAccess';

/**
 * "Spaces" section (layout-spec §1, §2 — the successor to the old guild rail).
 * Lists the user's joined guilds, MERGED across every connected server, as compact
 * avatar-chip + name rows. Click → the guild's Home (Rooms view) at
 * `/app/guilds/:guildId`; if the guild lives on a background server we flip the
 * active server first so its data resolves.
 *
 * Nav-item recipe (design-spec §7): 34px, `--radius-sm`, `--accent-tint` fill + 3px
 * teal (`--accent-secondary`) left edge bar on the active space. Space avatar is a
 * squircle icon (or initials chip when missing) — tokens only, no gradient tiles.
 *
 * The old guild-rail context menu is re-homed here (layout-spec §2 — "folder/
 * context-menu logic absorbed into SpacesList"): right-click a space to Mute /
 * Unmute it (the sole writer of the `muted-guilds` set that feeds attention
 * ranking — see `useMutedGuilds`) or Mark the whole space read.
 */

export interface SpacesListProps {
  spaces: GuildSummary[];
  /** Guilds carrying unread, mention, reply, or live-room attention. */
  attentionGuildIds?: ReadonlySet<string>;
  /** Currently-open guild id (route param) → active row highlight. */
  activeGuildId?: string | null;
  /**
   * Open the create/join-server flow. The old guild rail's "+" was the only persistent
   * create/join entry and died with the rail; the always-visible "Add a space" row
   * restores it. The sidebar mounts the existing `CreateGuildModal` (Create/Join/
   * Template tabs) — this component never rebuilds it.
   */
  onAddSpace?: () => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function SpacesList({
  spaces,
  attentionGuildIds,
  activeGuildId,
  onAddSpace,
  navIndexStart = 0,
  activeNavIndex,
}: SpacesListProps) {
  const navigate = useNavigate();
  const { mutedGuildIds, toggleMute } = useMutedGuilds();
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();

  // Never returns null now: even with zero joined spaces the "Add a space" row must
  // stay reachable so a fresh account can create or join its first space.
  const addSpaceNavIndex = navIndexStart + spaces.length;

  const openSpace = (space: GuildSummary) => {
    if (useServerListStore.getState().activeServerId !== space.serverId) {
      useServerListStore.getState().setActive(space.serverId);
    }
    navigate(`/app/guilds/${space.id}`);
  };

  // Mark every channel of a guild read via the serverId-scoped read-state store.
  const markSpaceRead = async (space: GuildSummary) => {
    const channels = useChannelStore.getState().channelsByGuild[space.id] ?? [];
    const markRead = useReadStateStore.getState().markRead;
    const writes: Promise<unknown>[] = [];
    for (const ch of channels) {
      if (ch.type === ChannelType.Category || !ch.last_message_id) continue;
      markRead(space.serverId, ch.id, ch.last_message_id);
      writes.push(channelApi.updateReadStateForServer(space.serverId, ch.id, ch.last_message_id));
    }
    const results = await Promise.allSettled(writes);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      toast.error(`Failed to save read positions: ${extractApiError(failed.reason)}`);
    }
  };

  const leaveSpace = async (space: GuildSummary) => {
    const ok = await confirm({
      title: `Leave ${space.name}?`,
      description: 'You will need an invite to rejoin this space.',
      confirmLabel: 'Leave space',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      if (useServerListStore.getState().activeServerId !== space.serverId) {
        useServerListStore.getState().setActive(space.serverId);
      }
      await useGuildStore.getState().leaveGuild(space.id);
      toast.success(`Left ${space.name}.`);
      if (typeof window !== 'undefined' && window.location.pathname.includes(`/guilds/${space.id}`)) {
        navigate('/app');
      }
    } catch (err) {
      toast.error(`Failed to leave space: ${extractApiError(err)}`);
    }
  };

  const buildItems = (space: GuildSummary): ContextMenuItem[] => {
    const muted = mutedGuildIds.includes(space.id);
    const currentUserId = useAuthStore.getState().user?.id;
    const guild = useGuildStore.getState().guilds.find((g) => g.id === space.id);
    const isOwner = Boolean(currentUserId && guild?.owner_id === currentUserId);
    const canOpenSettings = canAccessGuildSettingsSync(space.id);
    const items: ContextMenuItem[] = [
      {
        label: muted ? 'Unmute space' : 'Mute space',
        icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
        action: () => toggleMute(space.id),
      },
      {
        label: 'Mark as read',
        icon: <CheckCheck size={16} />,
        action: () => void markSpaceRead(space),
      },
    ];
    // Only surface settings when the viewer can actually open them — same gate
    // as GuildHomeHeader / GuildSettingsPage.
    if (canOpenSettings) {
      items.push({
        label: 'Space settings',
        icon: <Settings size={16} />,
        action: () => useUIStore.getState().setGuildSettingsId(space.id),
      });
    }
    if (!isOwner) {
      items.push({
        label: 'Leave space',
        icon: <LogOut size={16} />,
        danger: true,
        action: () => void leaveSpace(space),
      });
    }
    return items;
  };

  return (
    <section aria-label="Spaces" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Spaces</h2>
      <div role="group" aria-label="Joined spaces" className="flex flex-col gap-0.5">
        {spaces.map((space, i) => {
          const active = space.id === activeGuildId;
          const muted = mutedGuildIds.includes(space.id);
          const needsAttention = !active && !muted && Boolean(attentionGuildIds?.has(space.id));
          const iconSrc = resolveGuildIconUrl({ icon: space.icon });
          return (
            <button
              key={space.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              data-nav-index={navIndexStart + i}
              tabIndex={navIndexStart + i === activeNavIndex ? 0 : -1}
              onClick={() => openSpace(space)}
              onContextMenu={(e) => onContextMenu(e, buildItems(space))}
              className={cn(
                'group relative flex h-[34px] w-full items-center gap-2 rounded-sm px-2 text-left outline-none',
                'transition-colors duration-[140ms] ease-[var(--ease-out)]',
                'focus-visible:shadow-[var(--focus-ring)]',
                active
                  ? 'bg-accent-tint text-text-primary'
                  : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary"
                />
              )}
              <span
                aria-hidden
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg-mod-strong text-meta font-semibold',
                  active ? 'text-accent-primary' : 'text-text-secondary',
                )}
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className="h-full w-full object-cover" />
                ) : (
                  guildInitials(space.name)
                )}
              </span>
              <span className={cn('min-w-0 flex-1 truncate text-label', muted && 'text-text-muted')}>
                {space.name}
              </span>
              {needsAttention && (
                <span
                  data-testid="expanded-space-attention-dot"
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full bg-accent-primary"
                />
              )}
              {muted && (
                <BellOff
                  size={13}
                  aria-label="Muted"
                  className="shrink-0 text-text-muted"
                />
              )}
            </button>
          );
        })}

        {/* Persistent create/join-server entry — restores the dead guild-rail "+". */}
        <button
          type="button"
          role="option"
          aria-selected={false}
          aria-label="Add a space"
          data-nav-index={addSpaceNavIndex}
          tabIndex={addSpaceNavIndex === activeNavIndex ? 0 : -1}
          onClick={() => onAddSpace?.()}
          className={cn(
            'group relative flex h-[34px] w-full items-center gap-2 rounded-sm px-2 text-left outline-none',
            'text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)]',
            'hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]',
          )}
        >
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary"
          >
            <Plus size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-label">Add a space</span>
        </button>
      </div>

      {contextMenu.isOpen && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </section>
  );
}
