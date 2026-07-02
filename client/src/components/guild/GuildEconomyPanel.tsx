import { useEffect, useMemo, useState } from 'react';
import { Crown, Flame, Medal, TrendingUp } from 'lucide-react';

import { economyApi, type EconomyLeaderboardEntry, type EconomyProgressResponse } from '../../api/economy';
import { extractApiError } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';

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

    return () => {
      cancelled = true;
      window.clearInterval(interval);
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
    <aside className="hidden xl:flex w-[300px] shrink-0 border-l border-border-subtle bg-bg-primary/95 backdrop-blur-sm">
      <div className="flex h-full w-full flex-col gap-4 p-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <TrendingUp size={16} className="text-accent-primary" />
            Guild Leaderboard
          </div>
          <div className="mt-1 text-xs text-text-muted">
            Message activity XP, streaks, and levels update in real time.
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-4 text-sm text-text-secondary">
            Loading progression...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-3 text-sm text-accent-danger">
            {error}
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border-subtle bg-bg-mod-subtle/70 p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-text-primary">Your Progress</span>
                <span className="text-xs text-text-muted">Rank #{progress?.rank ?? '-'}</span>
              </div>
              <div className="mt-2 flex items-center gap-3 text-sm text-text-secondary">
                <span className="rounded-md bg-bg-primary px-2 py-1 font-semibold text-text-primary">
                  Level {progress?.level ?? 0}
                </span>
                <span>{progress?.xp ?? 0} XP</span>
                <span className="inline-flex items-center gap-1 text-accent-warning">
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
              <div className="mt-2 text-[11px] text-text-muted">
                {progress?.progress.xp_into_level ?? 0}/{progress?.progress.xp_required_this_level ?? 0} XP this level
              </div>
              {progress && progress.achievements.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {progress.achievements.slice(-4).map((achievement) => (
                    <span
                      key={achievement.key}
                      className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary px-2 py-0.5 text-[11px] text-text-secondary"
                      title={achievement.key}
                    >
                      <Medal size={10} className="text-accent-warning" />
                      {achievement.key}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-subtle bg-bg-mod-subtle/60">
              {entries.length === 0 ? (
                <div className="px-3 py-4 text-sm text-text-secondary">No leaderboard data yet.</div>
              ) : (
                <ul className="divide-y divide-border-subtle/70">
                  {entries.map((entry) => {
                    const isMe = currentUserId != null && entry.user.id === currentUserId;
                    return (
                      <li
                        key={entry.user.id}
                        className={`flex items-center justify-between gap-2 px-3 py-2.5 ${
                          isMe ? 'bg-accent-primary/10' : ''
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                            {entry.rank === 1 && <Crown size={12} className="text-accent-warning" />}
                            #{entry.rank} {entry.user.username}
                          </div>
                          <div className="text-[11px] text-text-muted">
                            L{entry.level} &middot; {entry.xp} XP &middot; {entry.streak_days}d streak
                          </div>
                        </div>
                        <span className="rounded-md bg-bg-primary px-2 py-0.5 text-xs font-semibold text-text-secondary">
                          L{entry.level}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {highlighted == null && currentUserId != null && progress != null && (
              <div className="rounded-lg border border-border-subtle bg-bg-mod-subtle/70 px-3 py-2 text-xs text-text-secondary">
                You are currently outside the top 8. Rank #{progress.rank ?? '-'}.
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
