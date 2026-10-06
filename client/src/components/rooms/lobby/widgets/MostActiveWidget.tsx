import { useEffect, useState } from 'react';

import { extractApiError } from '../../../../api/client';
import { economyApi, type EconomyLeaderboardEntry } from '../../../../api/economy';
import { useServerReady } from '../../../../hooks/useServerReady';
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
  // The leaderboard is the selected server's; wait for it rather than report it as an error.
  const ready = useServerReady();

  useEffect(() => {
    if (!ready) return;
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
  }, [guildId, ready]);

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
      <p className="ix-wnote">This week, by XP</p>
      <ol className="ix-wlist">
        {top.map((entry) => (
          <li key={entry.user.id} className="ix-row">
            <FeedAvatar
              user={{
                id: entry.user.id,
                username: entry.user.username,
                display_name: entry.user.display_name ?? null,
                avatar_hash: entry.user.avatar ?? null,
              }}
              size={32}
            />
            <span className="ix-row__body" style={{ gap: 6 }}>
              <span className="ix-row__top">
                <span className="ix-row__name">{displayName(entry.user)}</span>
                <span className="ix-row__aside">{entry.xp.toLocaleString()} XP</span>
              </span>
              <span className="ix-bar-meter" aria-hidden>
                <span style={{ width: `${Math.max(4, Math.round((entry.xp / most) * 100))}%` }} />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </WidgetCard>
  );
}
