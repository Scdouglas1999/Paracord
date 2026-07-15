import { Radio, Users } from 'lucide-react';
import { HomeSectionHeader } from './HomeSectionHeader';
import { guildInitials, resolveGuildIconUrl } from '../../lib/guildIcon';
import { getGuildColor } from '../../lib/colors';
import { cn } from '../../lib/utils';
import type { GuildSummary } from '../../hooks/useUnifiedConversations';

export interface HomeServerAttention {
  /** Unread / needs-you attention on this space. */
  unread: boolean;
  /** At least one occupied voice/stage room. */
  live: boolean;
  /** Optional member count from guild store. */
  memberCount?: number;
}

interface HomeServersRailProps {
  spaces: GuildSummary[];
  attention: Map<string, HomeServerAttention>;
  onOpen: (space: GuildSummary) => void;
  /** Highlight the primary / resume space. */
  primaryId?: string | null;
}

/**
 * "Your spaces" cards for the Home canvas — larger touch targets than sidebar
 * SpacesList, with member / live / unread context. Complements, does not replace,
 * the sidebar rail.
 */
export function HomeServersRail({
  spaces,
  attention,
  onOpen,
  primaryId,
}: HomeServersRailProps) {
  if (spaces.length === 0) return null;

  return (
    <section aria-label="Your spaces">
      <HomeSectionHeader label="Your spaces" count={spaces.length} />
      <div
        className={cn(
          'grid gap-3',
          spaces.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2',
        )}
      >
        {spaces.map((space) => {
          const attn = attention.get(space.id);
          const iconSrc = resolveGuildIconUrl({ icon_hash: space.icon });
          const isPrimary = primaryId === space.id;
          const memberCount = attn?.memberCount;
          const statusParts: string[] = [];
          if (attn?.live) statusParts.push('Live');
          if (attn?.unread) statusParts.push('Unread');
          if (typeof memberCount === 'number' && memberCount > 0) {
            statusParts.push(
              `${memberCount} member${memberCount === 1 ? '' : 's'}`,
            );
          }
          if (statusParts.length === 0) statusParts.push('Open space');

          return (
            <button
              key={space.id}
              type="button"
              onClick={() => onOpen(space)}
              className={cn(
                'group flex w-full items-center gap-4 rounded-md border bg-bg-secondary px-4 py-4 text-left shadow-sm outline-none transition-[border-color,background-color,transform] duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)] active:scale-[0.99]',
                isPrimary
                  ? 'border-accent-primary/40 ring-1 ring-inset ring-accent-primary/20'
                  : 'border-border-subtle hover:border-border-strong',
              )}
            >
              <div
                className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md"
                style={!iconSrc ? { backgroundColor: getGuildColor(space.id) } : undefined}
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-sm font-bold text-white">
                    {guildInitials(space.name, 3)}
                  </span>
                )}
                {(attn?.unread || attn?.live) && (
                  <span
                    data-testid="home-server-attention"
                    aria-hidden
                    className={cn(
                      'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary',
                      attn.live && attn.unread
                        ? 'bg-status-streaming ring-accent-primary'
                        : attn.live
                          ? 'bg-status-streaming'
                          : 'bg-accent-primary',
                    )}
                  />
                )}
              </div>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label font-semibold text-text-primary">
                  {space.name}
                </span>
                <span className="mt-1 flex items-center gap-2 text-meta text-text-muted">
                  {attn?.live ? (
                    <Radio size={13} className="shrink-0 text-status-streaming" aria-hidden />
                  ) : (
                    <Users size={13} className="shrink-0 text-text-muted" aria-hidden />
                  )}
                  <span className="truncate">{statusParts.join(' · ')}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
