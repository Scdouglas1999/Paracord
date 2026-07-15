import { useEffect, useMemo, useState } from 'react';
import { Crown, Flame, Medal, TrendingUp } from 'lucide-react';

import { economyApi, type EconomyLeaderboardEntry, type EconomyProgressResponse } from '../../api/economy';
import { extractApiError } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';

interface GuildEconomyPanelProps {
  guildId: string;
}

export function GuildEconomyPanel({ guildId }: GuildEconomyPanelProps) {
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
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
    <div className="flex min-h-full min-w-0 w-full flex-col bg-bg-secondary">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <div>
          <div className="flex items-center gap-2 text-label text-text-primary">
            <TrendingUp size={16} className="text-accent-primary" />
            <span className="font-display text-[15px] font-semibold tracking-[-0.01em]">Guild Leaderboard</span>
          </div>
          <div className="mt-1 text-meta text-text-muted">
            Activity XP, streaks, and levels update live.
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col gap-2.5">
            <div className="h-24 rounded-md bg-bg-mod-subtle" style={{ animation: 'skeleton-pulse 1.8s ease-in-out infinite' }} />
            <div className="h-40 rounded-md bg-bg-mod-subtle" style={{ animation: 'skeleton-pulse 1.8s ease-in-out infinite' }} />
          </div>
        ) : error ? (
          <div className="rounded-md border border-accent-danger/35 bg-danger-tint px-3 py-3 text-meta text-accent-danger">
            {error}
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border-subtle bg-bg-accent p-3.5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-label text-text-primary">Your Progress</span>
                <span className="font-code text-meta tabular-nums text-text-muted">
                  {progress?.rank != null ? `Rank #${progress.rank}` : 'Unranked'}
                </span>
              </div>
              <div className="mt-2.5 flex items-center gap-2.5 text-meta text-text-secondary">
                <span className="rounded-xs bg-accent-tint px-2 py-1 text-label font-semibold text-accent-primary">
                  Level {progress?.level ?? 0}
                </span>
                <span className="font-code tabular-nums">{progress?.xp ?? 0} XP</span>
                <span className="inline-flex items-center gap-1 font-code tabular-nums text-accent-warning">
                  <Flame size={13} />
                  {progress?.streak.days ?? 0}d
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-mod-strong">
                <div
                  className="h-full rounded-full bg-accent-primary transition-[width] duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="mt-2 font-code text-[11px] tabular-nums text-text-muted">
                {progress?.progress.xp_into_level ?? 0}/{progress?.progress.xp_required_this_level ?? 0} XP this level
              </div>
              {progress && progress.achievements.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {progress.achievements.slice(-4).map((achievement) => (
                    <span
                      key={achievement.key}
                      className="inline-flex items-center gap-1 rounded-full bg-bg-mod-strong px-2 py-0.5 text-[11px] text-text-secondary"
                      title={achievement.key}
                    >
                      <Medal size={10} className="text-accent-warning" />
                      {achievement.key}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border-subtle bg-bg-primary">
              {entries.length === 0 ? (
                <div className="px-3 py-6 text-meta text-text-secondary">
                  No one's earned XP here yet — be the first to break the ice.
                </div>
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {entries.map((entry) => {
                    const isMe = currentUserId != null && entry.user.id === currentUserId;
                    return (
                      <li
                        key={entry.user.id}
                        className={cn(
                          'flex items-center justify-between gap-2 px-3 py-2.5',
                          isMe && 'bg-accent-tint',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-label text-text-primary">
                            {entry.rank === 1 && <Crown size={12} className="text-accent-warning" />}
                            #{entry.rank} {displayName(entry.user)}
                          </div>
                          <div className="font-code text-[11px] tabular-nums text-text-muted">
                            L{entry.level} &middot; {entry.xp} XP &middot; {entry.streak_days}d streak
                          </div>
                        </div>
                        <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 font-code text-meta font-semibold tabular-nums text-text-secondary">
                          L{entry.level}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {highlighted == null && currentUserId != null && progress != null && progress.rank != null && entries.length > 0 && (
              <div className="rounded-md border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-meta text-text-secondary">
                You're just outside the top 8 — currently rank #{progress.rank}.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
