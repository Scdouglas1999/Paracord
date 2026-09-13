import { Star, Download, Server, RotateCw } from 'lucide-react';
import type { BotMetricsResult } from '../../api/botStore';
import { Button, Divider, Well } from '../../components/ui';

interface BotMetricsPanelProps {
  metrics: BotMetricsResult | undefined;
  onRefresh: () => void;
}

// Categorical dataviz palette — distinct semantic hues, never a single accent
// wash across every bar (lantern-stage-spec §6 / dataviz).
const SERIES_COLORS = [
  'var(--accent-info)',
  'var(--accent-success)',
  'var(--accent-warning)',
  'var(--text-faint)',
  'var(--accent-primary)',
  'var(--accent-danger)',
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-section text-text-faint">{label}</div>
      <div className="pc-display text-heading tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

export function BotMetricsPanel({ metrics, onRefresh }: BotMetricsPanelProps) {
  const maxCount = metrics ? Math.max(1, ...metrics.metrics_30d.map((b) => b.count)) : 1;

  return (
    <Well className="px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-section text-text-faint">Metrics · last 30 days</span>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RotateCw size={13} />
          Refresh metrics
        </Button>
      </div>
      {metrics ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <div className="flex items-center gap-2">
              <Download size={15} className="text-accent-info" aria-hidden />
              <Stat label="Installs" value={String(metrics.install_count)} />
            </div>
            <div className="flex items-center gap-2">
              <Server size={15} className="text-accent-success" aria-hidden />
              <Stat label="Active guilds" value={String(metrics.active_guild_count)} />
            </div>
            <div className="min-w-0">
              <div className="text-section text-text-faint">Rating</div>
              <div className="pc-display inline-flex items-center gap-1.5 text-heading tabular-nums text-text-primary">
                <Star size={14} className="text-accent-warning" aria-hidden />
                {metrics.average_rating.toFixed(1)} ({metrics.review_count} reviews)
              </div>
            </div>
          </div>

          {metrics.metrics_30d.length > 0 && (
            <div className="flex flex-col gap-2">
              <Divider />
              {metrics.metrics_30d.map((bucket, i) => (
                <div key={bucket.event_type} className="flex items-center gap-3">
                  <div
                    className="h-2 rounded-[var(--radius-window)]"
                    style={{
                      width: `${Math.max(6, (bucket.count / maxCount) * 100)}%`,
                      backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
                    }}
                    aria-hidden
                  />
                  <span className="pc-mono shrink-0 text-meta tabular-nums text-text-secondary">
                    {bucket.event_type}: {bucket.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p className="text-label text-text-primary">No metrics loaded yet</p>
          <p className="mt-1 max-w-prose text-meta text-text-secondary">
            Refresh to pull this app's installs, active servers and reviews from the last 30 days.
          </p>
        </div>
      )}
    </Well>
  );
}
