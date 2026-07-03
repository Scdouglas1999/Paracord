import { Star } from 'lucide-react';
import type { BotMetricsResult } from '../../api/botStore';

interface BotMetricsPanelProps {
  metrics: BotMetricsResult | undefined;
  onRefresh: () => void;
}

export function BotMetricsPanel({ metrics, onRefresh }: BotMetricsPanelProps) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/40 px-3 py-2.5 text-xs text-text-secondary">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wide text-text-secondary">Metrics (30d)</span>
        <button
          type="button"
          className="rounded-md border border-border-subtle px-2 py-0.5 text-[11px] font-semibold hover:bg-bg-mod-strong"
          onClick={onRefresh}
        >
          Refresh Metrics
        </button>
      </div>
      {metrics ? (
        <div className="space-y-1.5">
          <div>
            Installs: <span className="font-semibold text-text-primary">{metrics.install_count}</span>
            {' · '}
            Active Guilds: <span className="font-semibold text-text-primary">{metrics.active_guild_count}</span>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <Star size={12} className="text-accent-warning" />
            {metrics.average_rating.toFixed(1)} ({metrics.review_count} reviews)
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {metrics.metrics_30d.map((bucket) => (
              <span key={bucket.event_type} className="rounded-full border border-border-subtle px-2 py-0.5 text-[11px]">
                {bucket.event_type}: {bucket.count}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-text-muted">No metrics loaded yet.</div>
      )}
    </div>
  );
}
