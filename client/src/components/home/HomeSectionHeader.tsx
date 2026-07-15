import type { ReactNode } from 'react';

/** Compact uppercase section label used across the Home canvas. */
export function HomeSectionHeader({
  icon,
  label,
  count,
  action,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
      <div className="flex items-center gap-2 text-section uppercase text-text-muted">
        {icon && <span className="text-interactive-normal">{icon}</span>}
        <span>{label}</span>
        {count != null && count > 0 && (
          <span className="tabular-nums text-text-secondary">{count}</span>
        )}
      </div>
      {action}
    </div>
  );
}
