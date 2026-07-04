import { useNavigate } from 'react-router-dom';
import { useServerListStore } from '../../../stores/serverListStore';
import { cn } from '../../../lib/utils';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';

/**
 * "Spaces" section (layout-spec §1, §2 — replaces the dying guild rail
 * `components/layout/Sidebar.tsx`). Lists the user's joined guilds, MERGED across
 * every connected server, as compact avatar-chip + name rows. Click → the guild's
 * Home (Rooms view) at `/app/guilds/:guildId`; if the guild lives on a background
 * server we flip the active server first so its data resolves.
 *
 * Nav-item recipe (design-spec §7): 34px, `--radius-sm`, `--accent-tint` fill + 3px
 * teal (`--accent-secondary`) left edge bar on the active space. Guild avatar is a
 * squircle initials chip (kill-list clean — tokens only, no gradient tiles).
 *
 * NOTE (wave-4): the guild-rail context-menu affordances (mute, folders, invite,
 * leave, mark-read) still live in `components/layout/Sidebar.tsx`, which is deleted
 * in wave-4 of the layout overhaul (§8). Porting that menu is non-trivial, so this
 * renders the flat guild list per the SHELL-4 instruction; the ctx-menu port is a
 * follow-up when Sidebar.tsx is removed.
 */

export interface SpacesListProps {
  spaces: GuildSummary[];
  /** Currently-open guild id (route param) → active row highlight. */
  activeGuildId?: string | null;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
}

export function SpacesList({ spaces, activeGuildId, navIndexStart = 0 }: SpacesListProps) {
  const navigate = useNavigate();

  if (spaces.length === 0) return null;

  const openSpace = (space: GuildSummary) => {
    if (useServerListStore.getState().activeServerId !== space.serverId) {
      useServerListStore.getState().setActive(space.serverId);
    }
    navigate(`/app/guilds/${space.id}`);
  };

  return (
    <section aria-label="Spaces" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Spaces</h2>
      <div role="listbox" aria-label="Joined servers" className="flex flex-col gap-0.5">
        {spaces.map((space, i) => {
          const active = space.id === activeGuildId;
          return (
            <button
              key={space.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              data-nav-index={navIndexStart + i}
              onClick={() => openSpace(space)}
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
              <span className="min-w-0 flex-1 truncate text-label">{space.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
