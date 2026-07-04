import { useState, useEffect } from 'react';
import { MessageSquare, Server, Users, Hash, TrendingUp } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Skeleton } from '../../components/ui/Skeleton';

type Stats = {
  total_users: number;
  total_guilds: number;
  total_messages: number;
  total_channels: number;
};

export function OverviewPanel() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    adminApi
      .getStats()
      .then(({ data }) => setStats(data))
      .catch((err) => {
        toast.error(`Failed to load admin stats: ${extractApiError(err)}`);
      });
  }, []);

  return (
    <div>
      <header className="mb-7">
        <h2 className="font-display text-heading text-text-primary">Server overview</h2>
        <p className="mt-1 text-body text-text-secondary">
          A live snapshot of activity across this deployment.
        </p>
      </header>

      {!stats ? (
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
          <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton width={72} height={12} borderRadius="var(--radius-xs)" />
                <Skeleton width="70%" height={30} borderRadius="var(--radius-xs)" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <OverviewBody stats={stats} />
      )}
    </div>
  );
}

const STAT_META = [
  { key: 'total_messages', label: 'Messages sent', icon: MessageSquare, lead: true },
  { key: 'total_users', label: 'Registered users', icon: Users, lead: false },
  { key: 'total_guilds', label: 'Active guilds', icon: Server, lead: false },
  { key: 'total_channels', label: 'Channels', icon: Hash, lead: false },
] as const;

function OverviewBody({ stats }: { stats: Stats }) {
  const msgPerChannel = stats.total_channels > 0
    ? Math.round(stats.total_messages / stats.total_channels)
    : 0;
  const channelsPerGuild = stats.total_guilds > 0
    ? (stats.total_channels / stats.total_guilds).toFixed(1)
    : '0';

  return (
    <div className="space-y-4">
      {/* One elevated surface, divided — not a grid of identical cards. */}
      <div className="grid grid-cols-2 divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm sm:grid-cols-4 sm:divide-x">
        {STAT_META.map(({ key, label, icon: Icon, lead }) => (
          <div key={key} className="flex flex-col gap-2 p-6">
            <div className="flex items-center justify-between">
              <span className="text-section uppercase text-text-muted">{label}</span>
              <Icon size={15} className={lead ? 'text-accent-primary' : 'text-text-muted'} />
            </div>
            <span
              className={`font-display tabular-nums leading-none text-text-primary ${
                lead ? 'text-[2.4rem]' : 'text-[1.85rem]'
              }`}
            >
              {stats[key].toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Derived readouts — context, not another wall of cards. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 px-1 text-body text-text-secondary">
        <span className="inline-flex items-center gap-2">
          <TrendingUp size={16} className="text-accent-success" />
          <span className="font-display tabular-nums text-text-primary">{msgPerChannel.toLocaleString()}</span>
          messages per channel on average
        </span>
        <span className="inline-flex items-center gap-2">
          <TrendingUp size={16} className="text-accent-info" />
          <span className="font-display tabular-nums text-text-primary">{channelsPerGuild}</span>
          channels per guild
        </span>
      </div>
    </div>
  );
}
