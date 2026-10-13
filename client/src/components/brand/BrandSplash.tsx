import { useBootSplashGone, useBootSplashHold } from '../../lib/bootSplash';
import { CordMark } from './CordMark';

/**
 * The full-window "still loading" screen: restoring a session, reaching the
 * instance, waiting on a redirect.
 *
 * It is the loading screen from `index.html` (#pc-boot) in its final frame:
 * the same markup and the same classes, whose styles live inline in index.html
 * because they have to paint before any bundle loads. So when the app is still
 * loading at the end of that sequence, the loading screen fades out over an
 * identical picture and the only thing that changes is this status line
 * appearing (lib/bootSplash.ts). `is-static` switches the loading screen's own
 * animations off; the mark then takes up its loading loop, which starts from
 * the whole mark, once the loading screen has started to leave.
 */
export function BrandSplash({ label }: { label: string }) {
  useBootSplashHold();
  const bootGone = useBootSplashGone();
  return (
    <div className="pc-boot is-static" data-testid="brand-splash" data-window-drag="deep">
      <div className="pc-boot__stage">
        <div className="pc-boot__glow" />
        <div className="pc-boot__art">
          <CordMark size={160} motion="loading" paused={!bootGone} label="Paracord" />
        </div>
        <img className="pc-boot__word" src="/brand/wordmark.webp" alt="" aria-hidden="true" />
        <p className="pc-boot__status" role="status" aria-live="polite">
          {label}
        </p>
      </div>
    </div>
  );
}
