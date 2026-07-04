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
    <div className="rounded-sm border-l-2 border-border-strong bg-bg-mod-subtle px-3 py-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <Eye size={13} className="shrink-0 text-text-muted" />
        <span className="text-meta font-medium text-text-muted">
          Only you can see this
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}
