// §5.1/§5.3: the shared banner recipe (pc-banner-in / pc-banner-out) and the
// ONE reduced-motion switch — the presence hook keeps the bar mounted for its
// --duration-fast leave.
import { usePresence } from '../lib/motion';
import { useUIStore } from '../stores/uiStore';
import { BannerStrip } from './ix/conversation/BannerStrip';

// App-wide status banner (docs/index-spec.md §6.8): the instance is restarting. A
// 36px strip in the card's color with its words and no action: there is nothing
// to press, the app reconnects on its own (and nothing here spins).
export function RestartBanner() {
  const serverRestarting = useUIStore((s) => s.serverRestarting);
  const { mounted, exiting, scenery } = usePresence(serverRestarting);

  if (!mounted) return null;

  return (
    <BannerStrip
      data-testid="ix-banner-restart"
      className={exiting ? 'pc-banner-out' : 'pc-banner-in'}
      {...scenery}
    >
      The instance is restarting. You’ll reconnect automatically.
    </BannerStrip>
  );
}
