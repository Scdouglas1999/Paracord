// §5.1/§5.3: the shared banner recipe (pc-banner-in / pc-banner-out) and the
// ONE reduced-motion switch — the presence hook keeps the bar mounted for its
// --duration-fast leave.
import { usePresence } from '../lib/motion';
import { RefreshCw } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { cn } from '../lib/utils';

// App-wide status banner (lantern-stage-spec §8): an info-toned top bar with a
// matching lucide icon and --text-label copy, dropping in on the shared recipe.
export function RestartBanner() {
  const serverRestarting = useUIStore((s) => s.serverRestarting);
  const { mounted, exiting, scenery } = usePresence(serverRestarting);

  if (!mounted) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 px-4 py-2',
        exiting ? 'pc-banner-out' : 'pc-banner-in',
      )}
      style={{
        backgroundColor: 'color-mix(in srgb, var(--accent-info) 16%, var(--bg-raised))',
        borderBottom: '1px solid color-mix(in srgb, var(--accent-info) 45%, transparent)',
        boxShadow: 'var(--shadow-lifted)',
      }}
      {...scenery}
    >
      <RefreshCw size={15} className="animate-spin" style={{ color: 'var(--accent-info)' }} />
      <span className="text-label" style={{ color: 'var(--accent-info)' }}>
        Server is restarting — you'll reconnect automatically
      </span>
    </div>
  );
}
