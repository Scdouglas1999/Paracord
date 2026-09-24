import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Crown, Flame, Medal, TrendingUp } from 'lucide-react';

import { economyApi, type EconomyLeaderboardEntry, type EconomyProgressResponse } from '../../api/economy';
import { extractApiError } from '../../api/client';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';
import { Chip, EmptyState, ErrorBanner, Well } from '../ui';
import { Skeleton } from '../ui/Skeleton';

interface GuildEconomyPanelProps {
  guildId: string;
}

export function GuildEconomyPanel({ guildId }: GuildEconomyPanelProps) {
  const currentUserId = useCurrentUser()?.id ?? null;
  const [entries, setEntries] = useState<EconomyLeaderboardEntry[]>([]);
  const [progress, setProgress] = useState<EconomyProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [leaderboard, mine] = await Promise.all([
          economyApi.getLeaderboard(guildId, 8),
          economyApi.getMyProgress(guildId),
        ]);
        if (cancelled) return;
        setEntries(leaderboard.data.entries || []);
        setProgress(mine.data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(extractApiError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 30_000);

    const onXpUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ guild_id?: string }>).detail;
      if (detail?.guild_id && detail.guild_id !== guildId) return;
      void load();
    };
    window.addEventListener('paracord:guild-member-xp-update', onXpUpdate);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('paracord:guild-member-xp-update', onXpUpdate);
    };
  }, [guildId]);

  const progressPercent = useMemo(() => {
    if (!progress) return 0;
    const required = Math.max(1, progress.progress.xp_required_this_level);
    return Math.min(100, Math.round((progress.progress.xp_into_level / required) * 100));
  }, [progress]);

  const highlighted = useMemo(
    () => entries.find((entry) => currentUserId != null && entry.user.id === currentUserId),
    [entries, currentUserId],
  );

  return (
    <div className="flex min-h-full min-w-0 w-full flex-col bg-bg-plate">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <div>
          <div className="flex items-center gap-2 text-text-primary">
            <TrendingUp size={16} className="text-accent-primary" aria-hidden />
            <span className="pc-display text-name">Server leaderboard</span>
          </div>
          <div className="mt-1 text-meta leading-relaxed text-text-muted">
            Activity XP, streaks, and levels update live.
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton height={96} borderRadius="var(--radius-well)" />
            <Skeleton height={160} borderRadius="var(--radius-well)" />
          </div>
        ) : error ? (
          <ErrorBanner message={error} multiline />
        ) : (
          <>
            {/* Your own standing — a recessed readout inside the panel. */}
            <Well bare className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-label text-text-primary">Your progress</span>
                <span className="pc-mono text-meta text-text-muted">
                  {progress?.rank != null ? `Rank #${progress.rank}` : 'Unranked'}
                </span>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5 text-meta text-text-secondary">
                <Chip tone="accent">Level {progress?.level ?? 0}</Chip>
                <span className="pc-mono">{progress?.xp ?? 0} XP</span>
                <span className="inline-flex items-center gap-1 pc-mono text-accent-warning">
                  <Flame size={13} aria-hidden />
                  {progress?.streak.days ?? 0}d
                </span>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-[var(--radius-full)] bg-bg-mod-strong"
                role="progressbar"
                aria-valuenow={progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress through this level"
              >
                <div
                  className="pc-meter-fill bg-accent-primary"
                  style={{ '--pc-fill': progressPercent / 100 } as CSSProperties}
                />
              </div>
              {/* §9: the meter is never the only cue — the count reads it out. */}
              <div className="mt-2 pc-mono text-meta text-text-muted">
                {progress?.progress.xp_into_level ?? 0}/{progress?.progress.xp_required_this_level ?? 0} XP this level
              </div>
              {progress && progress.achievements.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {progress.achievements.slice(-4).map((achievement) => (
                    <Chip key={achievement.key} size="sm" title={achievement.key}>
                      <Medal size={10} className="text-accent-warning" aria-hidden />
                      {achievement.key}
                    </Chip>
                  ))}
                </div>
              )}
            </Well>

            {entries.length === 0 ? (
              <EmptyState
                className="!py-6"
                icon={<TrendingUp size={20} />}
                title="No XP earned here yet"
                description="Post in a channel and you'll be the first name on this board."
              />
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
                {entries.map((entry) => {
                  const isMe = currentUserId != null && entry.user.id === currentUserId;
                  return (
                    <li
                      key={entry.user.id}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-3 py-2.5',
                        isMe && 'bg-bg-raised shadow-[var(--shadow-raised)]',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-label text-text-primary">
                          {entry.rank === 1 && <Crown size={12} className="text-accent-warning" aria-hidden />}
                          #{entry.rank} {displayName(entry.user)}
                        </div>
                        <div className="pc-mono text-meta text-text-muted">
                          L{entry.level} &middot; {entry.xp} XP &middot; {entry.streak_days}d streak
                        </div>
                      </div>
                      <Chip size="sm" className="pc-mono">
                        L{entry.level}
                      </Chip>
                    </li>
                  );
                })}
              </ul>
            )}

            {highlighted == null && currentUserId != null && progress != null && progress.rank != null && entries.length > 0 && (
              <Well bare className="px-3 py-2.5 text-meta leading-relaxed text-text-secondary">
                You're just outside the top 8 — currently rank #{progress.rank}.
              </Well>
            )}
          </>
        )}
      </div>
    </div>
  );
}
