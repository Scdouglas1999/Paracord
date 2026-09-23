import { useBootSplashHold } from '../../lib/bootSplash';

/**
 * The full-window "still loading" screen: restoring a session, reaching the
 * instance, waiting on a redirect.
 *
 * It is the loading screen from `index.html` (#pc-boot) in its final frame:
 * the same markup and the same classes, whose styles live inline in index.html
 * because they have to paint before any bundle loads. So when the app is still
 * loading at the end of that sequence, the loading screen fades out over an
 * identical picture and the only thing that changes is this status line
 * appearing (lib/bootSplash.ts). Static: `is-static` switches every animation
 * off, so nothing moves while it waits.
 */
export function BrandSplash({ label }: { label: string }) {
  useBootSplashHold();
  return (
    <div className="pc-boot is-static" data-testid="brand-splash">
      <div className="pc-boot__stage">
        <div className="pc-boot__glow" />
        <div className="pc-boot__art" aria-hidden="true">
          <img className="pc-boot__dim" src="/brand/splash-lantern-dim.webp" alt="" />
          <img className="pc-boot__lit" src="/brand/splash-lantern.webp" alt="" />
          <img className="pc-boot__cord" src="/brand/splash-cord.webp" alt="" />
        </div>
        <img className="pc-boot__word" src="/brand/wordmark.webp" alt="Paracord" />
        <p className="pc-boot__status" role="status" aria-live="polite">
          {label}
        </p>
      </div>
    </div>
  );
}
