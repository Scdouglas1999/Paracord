import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  Info,
  Loader2,
  MessageSquare,
  RefreshCw,
  Server,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { adminApi, type HealthCheck, type HealthReport } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Button } from '../../components/ui/Button';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'unknown';
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SEVERITY_STYLE: Record<
  HealthCheck['severity'],
  { icon: typeof AlertTriangle; tone: string; label: string }
> = {
  critical: { icon: ShieldAlert, tone: 'text-accent-danger', label: 'Needs attention' },
  warning: { icon: AlertTriangle, tone: 'text-accent-warning', label: 'Worth fixing' },
  info: { icon: Info, tone: 'text-accent-info', label: 'For your information' },
};

export function OverviewPanel() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (announce = false) => {
    setRefreshing(true);
    try {
      const { data } = await adminApi.getHealth();
      setHealth(data);
      if (announce) toast.success('Health refreshed');
    } catch (err) {
      toast.error(`Failed to load server health: ${extractApiError(err)}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-heading text-text-primary">Server health</h2>
          <p className="mt-1 text-body text-text-secondary">
            What this deployment looks like right now, and anything worth acting on.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Refresh
        </Button>
      </header>

      {!health ? (
        <div className="space-y-4">
          <Skeleton height={110} borderRadius="var(--radius-md)" />
          <Skeleton height={160} borderRadius="var(--radius-md)" />
        </div>
      ) : (
        <HealthBody health={health} />
      )}
    </div>
  );
}

function HealthBody({ health }: { health: HealthReport }) {
  const { counts, checks } = health;

  return (
    <div className="space-y-5">
      {/* Findings lead — the operator's to-do list, not buried under stats. */}
      {checks.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary px-5 py-4 shadow-sm">
          <CheckCircle2 size={18} className="shrink-0 text-accent-success" />
          <div>
            <div className="text-label text-text-primary">Everything looks healthy</div>
            <div className="mt-0.5 text-meta text-text-secondary">
              Backups, transport security, and capacity all check out.
            </div>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
          <div className="border-b border-border-subtle px-5 py-3">
            <span className="text-section uppercase text-text-muted">
              {checks.length} thing{checks.length === 1 ? '' : 's'} to look at
            </span>
          </div>
          <div className="divide-y divide-border-subtle">
            {checks.map((check) => {
              const style = SEVERITY_STYLE[check.severity];
              const Icon = style.icon;
              return (
                <div key={check.id} className="flex items-start gap-3 px-5 py-4">
                  <Icon size={17} className={`mt-0.5 shrink-0 ${style.tone}`} />
                  <div className="min-w-0">
                    <div className="text-label text-text-primary">{check.title}</div>
                    <p className="mt-1 max-w-prose text-[13.5px] leading-relaxed text-text-secondary">
                      {check.detail}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Activity counters */}
      <div className="grid grid-cols-2 divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm sm:grid-cols-4 sm:divide-x">
        <Stat label="Messages sent" value={counts.messages} icon={MessageSquare} lead />
        <Stat label="Registered users" value={counts.users} icon={Users} />
        <Stat label="Spaces" value={counts.guilds} icon={Server} />
        <Stat label="Online now" value={counts.online_users} icon={Users} />
      </div>

      {/* Deployment facts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <FactCard
          title="Database"
          icon={Database}
          rows={[
            ['Engine', health.database.engine === 'postgres' ? 'PostgreSQL' : 'SQLite'],
            ['Size', formatBytes(health.database.size_bytes)],
            ['Channels', counts.channels.toLocaleString()],
          ]}
        />
        <FactCard
          title="Backups"
          icon={HardDrive}
          rows={[
            ['Automatic', health.backups.auto_enabled ? 'On' : 'Off'],
            ['Archives', String(health.backups.count)],
            [
              'Latest',
              health.backups.count > 0 ? formatAge(health.backups.latest_age_hours) : 'none yet',
            ],
            ['Total size', formatBytes(health.backups.total_bytes)],
          ]}
        />
        <FactCard
          title="Access"
          icon={Server}
          rows={[
            ['Version', health.version],
            ['Uptime', formatUptime(health.uptime_seconds)],
            [
              'HTTPS',
              health.network.tls_enabled
                ? health.network.tls_self_signed
                  ? 'On (self-signed)'
                  : 'On'
                : 'Off',
            ],
            ['Public URL', health.network.public_url ?? 'not set'],
            ['Registration', health.network.registration_open ? 'Open' : 'Closed'],
          ]}
        />
        <FactCard
          title="Voice & video"
          icon={Server}
          rows={[
            ['Native media', health.media.native_enabled ? `On (UDP ${health.media.native_port})` : 'Off'],
            ['LiveKit', health.media.livekit_available ? 'Available' : 'Not configured'],
          ]}
        />
        <FactCard
          title="Files"
          icon={HardDrive}
          rows={[
            ['Uploads', formatBytes(health.storage.uploads_bytes)],
            ['Media', formatBytes(health.storage.media_bytes)],
          ]}
        />
        <FactCard
          title="Federation"
          icon={Server}
          rows={[['Status', health.network.federation_enabled ? 'Enabled' : 'Disabled']]}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  lead,
}: {
  label: string;
  value: number;
  icon: typeof Users;
  lead?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 p-6">
      <div className="flex items-center justify-between">
        <span className="text-section uppercase text-text-muted">{label}</span>
        <Icon size={15} className={lead ? 'text-accent-primary' : 'text-text-muted'} />
      </div>
      <span
        className={`font-display tabular-nums leading-none text-text-primary ${
          lead ? 'text-[2.4rem]' : 'text-[1.85rem]'
        }`}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function FactCard({
  title,
  icon: Icon,
  rows,
}: {
  title: string;
  icon: typeof Database;
  rows: Array<[string, string]>;
}) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon size={15} className="text-text-muted" />
        <span className="text-section uppercase text-text-muted">{title}</span>
      </div>
      <dl className="space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <dt className="text-meta text-text-secondary">{k}</dt>
            <dd className="truncate text-label tabular-nums text-text-primary" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
