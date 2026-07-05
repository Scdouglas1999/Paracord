import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useServerListStore } from '../../../stores/serverListStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { ChannelType } from '../../../types';
import { cn } from '../../../lib/utils';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';

/**
 * "Spaces" section (layout-spec §1, §2 — the successor to the old guild rail).
 * Lists the user's joined guilds, MERGED across every connected server, as compact
 * avatar-chip + name rows. Click → the guild's Home (Rooms view) at
 * `/app/guilds/:guildId`; if the guild lives on a background server we flip the
 * active server first so its data resolves.
 *
 * Nav-item recipe (design-spec §7): 34px, `--radius-sm`, `--accent-tint` fill + 3px
 * teal (`--accent-secondary`) left edge bar on the active space. Guild avatar is a
 * squircle initials chip (kill-list clean — tokens only, no gradient tiles).
 *
 * The old guild-rail context menu is re-homed here (layout-spec §2 — "folder/
 * context-menu logic absorbed into SpacesList"): right-click a space to Mute /
 * Unmute it (the sole writer of the `muted-guilds` set that feeds attention
 * ranking — see `useMutedGuilds`) or Mark the whole server read.
 */

export interface SpacesListProps {
  spaces: GuildSummary[];
  /** Currently-open guild id (route param) → active row highlight. */
  activeGuildId?: string | null;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function SpacesList({ spaces, activeGuildId, navIndexStart = 0, activeNavIndex }: SpacesListProps) {
  const navigate = useNavigate();
  const { mutedGuildIds, toggleMute } = useMutedGuilds();
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();

  if (spaces.length === 0) return null;

  const openSpace = (space: GuildSummary) => {
    if (useServerListStore.getState().activeServerId !== space.serverId) {
      useServerListStore.getState().setActive(space.serverId);
    }
    navigate(`/app/guilds/${space.id}`);
  };

  // Mark every channel of a guild read via the serverId-scoped read-state store.
  const markSpaceRead = (space: GuildSummary) => {
    const channels = useChannelStore.getState().channelsByGuild[space.id] ?? [];
    const markRead = useReadStateStore.getState().markRead;
    for (const ch of channels) {
      if (ch.type === ChannelType.Category || !ch.last_message_id) continue;
      markRead(space.serverId, ch.id, ch.last_message_id);
    }
  };

  const buildItems = (space: GuildSummary): ContextMenuItem[] => {
    const muted = mutedGuildIds.includes(space.id);
    return [
      {
        label: muted ? 'Unmute server' : 'Mute server',
        icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
        action: () => toggleMute(space.id),
      },
      {
        label: 'Mark as read',
        icon: <CheckCheck size={16} />,
        action: () => markSpaceRead(space),
      },
    ];
  };

  return (
    <section aria-label="Spaces" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Spaces</h2>
      <div role="group" aria-label="Joined servers" className="flex flex-col gap-0.5">
        {spaces.map((space, i) => {
          const active = space.id === activeGuildId;
          const muted = mutedGuildIds.includes(space.id);
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
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-mod-strong text-meta font-semibold',
                  active ? 'text-accent-primary' : 'text-text-secondary',
                )}
              >
                {space.name
                  .split(' ')
                  .map((w) => w[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase() || '?'}
              </span>
              <span className={cn('min-w-0 flex-1 truncate text-label', muted && 'text-text-muted')}>
                {space.name}
              </span>
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
