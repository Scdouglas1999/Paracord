import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Crown, Flame, Medal, TrendingUp } from 'lucide-react';

import { economyApi, type EconomyLeaderboardEntry, type EconomyProgressResponse } from '../../api/economy';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';
import { Chip, EmptyState, ErrorBanner } from '../ui';
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
    let canceled = false;

    const load = async () => {
      try {
        const [leaderboard, mine] = await Promise.all([
          economyApi.getLeaderboard(guildId, 8),
          economyApi.getMyProgress(guildId),
        ]);
        if (canceled) return;
        setEntries(leaderboard.data.entries || []);
        setProgress(mine.data);
        setError(null);
      } catch (err) {
        if (canceled) return;
        setError(extractApiError(err));
      } finally {
        if (!canceled) setLoading(false);
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
      canceled = true;
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
    <div className="glass-economy flex min-w-0 w-full flex-col">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <p className="glass-sheet-line">Activity XP, streaks and levels update live.</p>

        {loading ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton height={96} borderRadius="var(--r-bubble)" />
            <Skeleton height={160} borderRadius="var(--r-bubble)" />
          </div>
        ) : error ? (
          <ErrorBanner message={error} multiline />
        ) : (
          <>
            {/* Your own standing: a solid card, one step above the sheet. */}
            <section className="glass-sheet-card glass-economy__you" aria-label="Your progress">
              <div className="flex items-center justify-between gap-2">
                <span className="glass-name">Your progress</span>
                <span className="glass-instrument glass-secondary">
                  {progress?.rank != null ? `Rank #${progress.rank}` : 'Unranked'}
                </span>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5 text-meta text-text-secondary">
                <Chip tone="accent">Level {progress?.level ?? 0}</Chip>
                <span className="glass-instrument">{progress?.xp ?? 0} XP</span>
                <span className="inline-flex items-center gap-1 glass-instrument text-text-primary">
                  <Flame size={13} aria-hidden />
                  {progress?.streak.days ?? 0}d
                </span>
              </div>
              <div
                className="glass-economy__meter"
                role="progressbar"
                aria-valuenow={progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress through this level"
              >
                <div
                  className="pc-meter-fill glass-economy__fill"
                  style={{ '--pc-fill': progressPercent / 100 } as CSSProperties}
                />
              </div>
              {/* §9: the meter is never the only cue — the count reads it out. */}
              <div className="mt-2 glass-instrument glass-secondary">
                {progress?.progress.xp_into_level ?? 0}/{progress?.progress.xp_required_this_level ?? 0} XP this level
              </div>
              {progress && progress.achievements.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {progress.achievements.slice(-4).map((achievement) => (
                    <Chip key={achievement.key} size="sm" title={achievement.key}>
                      <Medal size={12} className="text-text-primary" aria-hidden />
                      {achievement.key}
                    </Chip>
                  ))}
                </div>
              )}
            </section>

            {entries.length === 0 ? (
              <EmptyState
                className="!py-6"
                icon={<TrendingUp size={20} />}
                title="No XP earned here yet"
                description="Post in a channel and you'll be the first name on this board."
              />
            ) : (
              <ul className="glass-sheet-list">
                {entries.map((entry) => {
                  const isMe = currentUserId != null && entry.user.id === currentUserId;
                  return (
                    <li
                      key={entry.user.id}
                      className="glass-sheet-row glass-economy__row"
                      data-selected={isMe ? 'true' : undefined}
                    >
                      <div className="glass-sheet-row__text">
                        <div className="glass-sheet-row__name flex items-center gap-1.5">
                          {entry.rank === 1 && <Crown size={13} className="shrink-0" aria-hidden />}
                          #{entry.rank} {displayName(entry.user)}
                        </div>
                        <div className="glass-sheet-row__detail glass-instrument">
                          L{entry.level} &middot; {entry.xp} XP &middot; {entry.streak_days}d streak
                        </div>
                      </div>
                      <Chip size="sm" className="glass-instrument">
                        L{entry.level}
                      </Chip>
                    </li>
                  );
                })}
              </ul>
            )}

            {highlighted == null && currentUserId != null && progress != null && progress.rank != null && entries.length > 0 && (
              <p className="glass-sheet-card glass-sheet-line">
                You're just outside the top 8 — currently rank #{progress.rank}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
