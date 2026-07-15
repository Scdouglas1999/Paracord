import { ArrowRight, Hash, Home } from 'lucide-react';
import { guildInitials, resolveGuildIconUrl } from '../../lib/guildIcon';
import { getGuildColor } from '../../lib/colors';
import type { GuildSummary } from '../../hooks/useUnifiedConversations';
import type { ConversationEntry } from '../../lib/attention/conversationModel';

export interface HomeResumeHeroProps {
  space: GuildSummary;
  /** Most recent guild channel in this space, if any — used as the secondary CTA. */
  lastChannel: ConversationEntry | null;
  memberCount?: number;
  live?: boolean;
  unread?: boolean;
  onOpenHome: () => void;
  onOpenChannel: (entry: ConversationEntry) => void;
}

/**
 * Home-unique "Jump into your space" hero — solid raised surface (kill-list #1),
 * Fraunces space name, primary Enter CTA. Complements sidebar SpacesList; does
 * not clone RecentList.
 */
export function HomeResumeHero({
  space,
  lastChannel,
  memberCount,
  live,
  unread,
  onOpenHome,
  onOpenChannel,
}: HomeResumeHeroProps) {
  const iconSrc = resolveGuildIconUrl({ icon_hash: space.icon });
  const metaParts: string[] = [];
  if (typeof memberCount === 'number' && memberCount > 0) {
    metaParts.push(`${memberCount} member${memberCount === 1 ? '' : 's'}`);
  }
  if (live) metaParts.push('Live room open');
  if (unread) metaParts.push('Unread waiting');
  if (!live && !unread) metaParts.push('Quiet right now');


  return (
    <section
      aria-label={`Continue in ${space.name}`}
      className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm"
    >
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:gap-5 sm:px-6 sm:py-6">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md text-2xl font-bold shadow-sm sm:h-16 sm:w-16"
          style={
            iconSrc
              ? undefined
              : { backgroundColor: getGuildColor(space.id), color: '#fff' }
          }
          aria-hidden
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            guildInitials(space.name, 1)
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-meta font-semibold uppercase tracking-wide text-text-muted">
            Continue in
          </p>
          <h2 className="mt-0.5 truncate font-display text-title text-text-primary sm:text-heading">
            {space.name}
          </h2>
          <p className="mt-1.5 text-body text-text-secondary">{metaParts.join(' · ')}</p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <button
            type="button"
            onClick={onOpenHome}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-sm bg-accent-primary px-4 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-[background-color,transform] duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:scale-[0.97] focus-visible:shadow-[var(--focus-ring)]"
          >
            <Home size={16} aria-hidden />
            Enter space
            <ArrowRight size={16} aria-hidden />
          </button>
          {lastChannel && (
            <button
              type="button"
              onClick={() => onOpenChannel(lastChannel)}
              className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-sm px-2.5 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
            >
              <Hash size={14} aria-hidden />
              <span className="truncate">Resume #{lastChannel.title.replace(/^#\s*/, '')}</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
