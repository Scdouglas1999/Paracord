import { useState, useEffect } from 'react';
import { BarChart3, Server, Settings, Users } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';

export function OverviewPanel() {
  const [stats, setStats] = useState<{
    total_users: number;
    total_guilds: number;
    total_messages: number;
    total_channels: number;
  } | null>(null);

  useEffect(() => {
    adminApi
      .getStats()
      .then(({ data }) => setStats(data))
      .catch((err) => {
        toast.error(`Failed to load admin stats: ${extractApiError(err)}`);
      });
  }, []);

  if (!stats) {
    return <p className="text-text-muted">Loading stats...</p>;
  }

  const cards = [
    { label: 'Users', value: stats.total_users, icon: Users },
    { label: 'Guilds', value: stats.total_guilds, icon: Server },
    { label: 'Messages', value: stats.total_messages, icon: BarChart3 },
    { label: 'Channels', value: stats.total_channels, icon: Settings },
  ];

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">Server Overview</h2>
      <div className="mb-10 grid grid-cols-2 gap-7 lg:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="card-surface rounded-xl border border-border-subtle bg-bg-secondary/60 px-6 py-6"
          >
            <div className="mb-2 flex items-center gap-2 text-text-secondary">
              <Icon size={16} />
              <span className="text-sm">{label}</span>
            </div>
            <p className="text-2xl font-bold text-text-primary">{value.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
