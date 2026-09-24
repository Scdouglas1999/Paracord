import { useEffect, useState } from 'react';

import { extractApiError } from '../../../../api/client';
import { economyApi, type EconomyLeaderboardEntry } from '../../../../api/economy';
import { displayName } from '../../../../lib/displayName';
import { FeedAvatar } from '../feedParts';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface MostActiveWidgetProps {
  guildId: string;
  onOpenLeaderboard: () => void;
}

const TOP = 4;

/**
 * "Most active": the top four by XP earned in the last seven days, with bars.
 * The window is computed server-side from per-day gains, so a member's number
 * is what they earned this week — not an all-time total under a "This week"
 * label. An older server has no weekly window; the widget hides rather than
 * label all-time XP as weekly.
 */
export function MostActiveWidget({ guildId, onOpenLeaderboard }: MostActiveWidgetProps) {
  const [entries, setEntries] = useState<EconomyLeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setEntries(null);
    setError(null);
    economyApi
      .getLeaderboard(guildId, TOP, 'weekly')
      .then(({ data }) => {
        if (canceled) return;
        setEntries(data.window === 'weekly' ? (data.entries ?? []) : []);
      })
      .catch((err) => {
        if (!canceled) setError(extractApiError(err));
      });
    return () => {
      canceled = true;
    };
  }, [guildId]);

  const top = entries ?? [];

  if (error) {
    return (
      <WidgetCard title="Most active">
        <WidgetError>Could not load the leaderboard: {error}</WidgetError>
      </WidgetCard>
    );
  }
  if (top.length === 0) return null;
  const most = Math.max(...top.map((entry) => entry.xp), 1);

  return (
    <WidgetCard title="Most active" action={<WidgetLink onClick={onOpenLeaderboard}>Leaderboard</WidgetLink>}>
      <p className="-mt-2 text-meta text-text-muted">This week, by XP</p>
      <ol className="flex flex-col gap-3">
        {top.map((entry, index) => (
          <li key={entry.user.id} className="flex items-center gap-3">
            <FeedAvatar
              user={{
                id: entry.user.id,
                username: entry.user.username,
                display_name: entry.user.display_name ?? null,
                avatar_hash: entry.user.avatar ?? null,
              }}
              size={28}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-label text-text-primary">{displayName(entry.user)}</span>
                <span className="pc-mono shrink-0 text-meta text-text-muted">
                  {entry.xp.toLocaleString()} XP
                </span>
              </span>
              <span className="pc-home-bar" aria-hidden>
                <span
                  style={{
                    width: `${Math.max(4, Math.round((entry.xp / most) * 100))}%`,
                    animationDelay: `${200 + index * 60}ms`,
                    opacity: 1 - index * 0.16,
                  }}
                />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </WidgetCard>
  );
}
