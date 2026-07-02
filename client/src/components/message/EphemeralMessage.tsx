import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';

interface EphemeralMessageProps {
  children: ReactNode;
}

/**
 * Wraps ephemeral message content (flags & 64) with a visual indicator
 * that it is only visible to the current user.
 */
export function EphemeralMessage({ children }: EphemeralMessageProps) {
  return (
    <div className="rounded-lg border border-border-subtle/50 bg-bg-mod-subtle/40 px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <Eye size={12} className="shrink-0 text-text-muted" />
        <span className="text-[11px] font-medium italic text-text-muted">
          Only visible to you
        </span>
      </div>
      <div className="italic">{children}</div>
    </div>
  );
}
