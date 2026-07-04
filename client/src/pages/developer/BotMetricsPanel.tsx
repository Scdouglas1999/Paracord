import { Star, Download, Server, RotateCw } from 'lucide-react';
import type { BotMetricsResult } from '../../api/botStore';

interface BotMetricsPanelProps {
  metrics: BotMetricsResult | undefined;
  onRefresh: () => void;
}

// Categorical dataviz palette — distinct semantic hues, never a single accent
// wash across every bar (design-spec §6 / dataviz).
const SERIES_COLORS = [
  'var(--accent-info)',
  'var(--accent-success)',
  'var(--accent-warning)',
  'var(--status-streaming)',
  'var(--accent-primary)',
  'var(--accent-danger)',
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-section uppercase text-text-muted">{label}</div>
      <div className="font-display text-lg tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

export function BotMetricsPanel({ metrics, onRefresh }: BotMetricsPanelProps) {
  const maxCount = metrics ? Math.max(1, ...metrics.metrics_30d.map((b) => b.count)) : 1;

  return (
    <div className="rounded-sm border border-border-subtle bg-bg-tertiary p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-section uppercase text-text-secondary">Metrics · last 30 days</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-sm border border-border-subtle px-2.5 py-1 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          onClick={onRefresh}
        >
          <RotateCw size={13} />
          Refresh Metrics
        </button>
      </div>
      {metrics ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <div className="flex items-center gap-2">
              <Download size={15} className="text-accent-info" />
              <Stat label="Installs" value={String(metrics.install_count)} />
            </div>
            <div className="flex items-center gap-2">
              <Server size={15} className="text-accent-success" />
              <Stat label="Active guilds" value={String(metrics.active_guild_count)} />
            </div>
            <div>
              <div className="text-section uppercase text-text-muted">Rating</div>
              <div className="inline-flex items-center gap-1.5 font-display text-lg tabular-nums text-text-primary">
                <Star size={14} className="text-accent-warning" />
                {metrics.average_rating.toFixed(1)} ({metrics.review_count} reviews)
              </div>
            </div>
          </div>

          {metrics.metrics_30d.length > 0 && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              {metrics.metrics_30d.map((bucket, i) => (
                <div key={bucket.event_type} className="flex items-center gap-3">
                  <div
                    className="h-2 rounded-full"
                    style={{
                      width: `${Math.max(6, (bucket.count / maxCount) * 100)}%`,
                      backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
                    }}
                  />
                  <span className="shrink-0 font-code text-meta text-text-secondary">
                    {bucket.event_type}: {bucket.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-body text-text-muted">No metrics loaded yet.</div>
      )}
    </div>
  );
}
