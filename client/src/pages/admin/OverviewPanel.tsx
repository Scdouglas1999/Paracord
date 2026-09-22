import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { adminApi, type HealthCheck, type HealthReport } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Button, Divider, SettingsSectionHeader, Well } from '../../components/ui';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'not measured';
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

// §9: colour is never the only cue — every severity carries its own word.
const SEVERITY: Record<
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
      toast.error(`Failed to load instance health: ${extractApiError(err)}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <SettingsSectionHeader
        title="Instance health"
        description="What this deployment looks like right now, and anything worth acting on."
        action={
          <Button variant="ghost" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </Button>
        }
      />

      {!health ? (
        <div className="flex flex-col gap-4">
          <Skeleton height={110} borderRadius="var(--radius-well)" />
          <Skeleton height={160} borderRadius="var(--radius-well)" />
        </div>
      ) : (
        <HealthBody health={health} />
      )}
    </div>
  );
}

type FactRow = [label: string, value: string, mono?: boolean];

function HealthBody({ health }: { health: HealthReport }) {
  const { counts, checks } = health;

  const groups: Array<{ title: string; rows: FactRow[] }> = [
    {
      title: 'Database',
      rows: [
        ['Engine', health.database.engine === 'postgres' ? 'PostgreSQL' : 'SQLite'],
        ['Size on disk', formatBytes(health.database.size_bytes), true],
        ['Channels', counts.channels.toLocaleString(), true],
      ],
    },
    {
      title: 'Backups',
      rows: [
        ['Automatic backups', health.backups.auto_enabled ? 'On' : 'Off'],
        ['Archives kept', String(health.backups.count), true],
        [
          'Latest archive',
          health.backups.count > 0 ? formatAge(health.backups.latest_age_hours) : 'none yet',
        ],
        ['Total size', formatBytes(health.backups.total_bytes), true],
      ],
    },
    {
      title: 'Access',
      rows: [
        ['Version', health.version, true],
        ['Uptime', formatUptime(health.uptime_seconds), true],
        [
          'HTTPS',
          health.network.tls_enabled
            ? health.network.tls_self_signed
              ? 'On (self-signed)'
              : 'On'
            : 'Off',
        ],
        ['Public URL', health.network.public_url ?? 'not set', true],
        ['Registration', health.network.registration_open ? 'Open' : 'Closed'],
      ],
    },
    {
      title: 'Voice and video',
      rows: [
        [
          'Native media',
          health.media.native_enabled ? `On, UDP ${health.media.native_port}` : 'Off',
        ],
        ['LiveKit', health.media.livekit_available ? 'Available' : 'Not configured'],
      ],
    },
    {
      title: 'Files',
      rows: [
        ['Uploads', formatBytes(health.storage.uploads_bytes), true],
        ['Media', formatBytes(health.storage.media_bytes), true],
      ],
    },
    {
      title: 'Federation',
      rows: [['Status', health.network.federation_enabled ? 'Enabled' : 'Disabled']],
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* Findings lead — the operator's to-do list, not buried under stats. */}
      <section>
        {checks.length === 0 ? (
          <Well className="flex items-start gap-3 px-4 py-3.5">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent-success" />
            <div className="min-w-0">
              <p className="text-label text-text-primary">Everything looks healthy</p>
              <p className="mt-0.5 text-meta text-text-secondary">
                Backups, transport security and capacity all check out.
              </p>
            </div>
          </Well>
        ) : (
          <>
            <p className="text-section text-text-faint">
              {checks.length} thing{checks.length === 1 ? '' : 's'} to look at
            </p>
            <Divider className="mt-2" />
            <ul className="flex flex-col">
              {checks.map((check) => {
                const severity = SEVERITY[check.severity];
                const Icon = severity.icon;
                return (
                  <li
                    key={check.id}
                    className="flex items-start gap-3 border-b border-border-subtle py-3.5 last:border-b-0"
                  >
                    <Icon size={17} className={`mt-0.5 shrink-0 ${severity.tone}`} aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-label text-text-primary">{check.title}</span>
                        <span className={`text-meta ${severity.tone}`}>{severity.label}</span>
                      </div>
                      <p className="mt-1 max-w-prose text-body leading-relaxed text-text-secondary">
                        {check.detail}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* Activity counters — one recessed readout, not four tiled cards. */}
      <Well className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 py-5 sm:grid-cols-4">
        <Stat label="Messages sent" value={counts.messages} />
        <Stat label="Registered users" value={counts.users} />
        <Stat label="Servers" value={counts.guilds} />
        <Stat label="Online now" value={counts.online_users} />
      </Well>

      {/* Deployment facts — rows parted by hairlines, never tiled cards (§6.8). */}
      <section className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group.title}>
            <h3 className="pc-display text-heading text-text-primary">{group.title}</h3>
            <dl className="mt-1.5">
              {group.rows.map(([label, value, mono]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2 last:border-b-0"
                >
                  <dt className="shrink-0 text-label text-text-secondary">{label}</dt>
                  <dd
                    className={`min-w-0 break-all text-right text-meta text-text-primary ${
                      mono ? 'pc-mono' : ''
                    }`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-section text-text-faint">{label}</span>
      <span className="pc-display text-display tabular-nums text-text-primary">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
