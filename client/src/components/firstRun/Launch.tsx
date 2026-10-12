import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';

import { useBootSplashGone, useBootSplashHold } from '../../lib/bootSplash';
import { CordMark } from '../brand/CordMark';

/**
 * The launch (docs/setup-spec.md §1.2; the prototype's boot): the cord draws
 * itself on, the wordmark resolves, then the mark glides up into the welcome
 * head while the welcome comes up around it.
 *
 * The draw and the wordmark are the loading screen's (`#pc-boot` in
 * index.html, the same CordMark `draw` motion): it paints from the first frame,
 * before any script, and on a first launch it is already on screen. So this
 * component is that screen's final frame, drawn with the loading screen's own
 * classes and geometry, and it holds the loading screen (`useBootSplashHold`)
 * so it plays to its end and fades over this identical picture. Once it has
 * gone, the background clears and the mark glides (550 ms on the spring) onto
 * the welcome mark: 96 px, its corner at (50% − 36 px, 68 px). Any key or
 * click skips to the end. Under reduced motion there is no launch (§0.6).
 */

/** What the loading screen holds still for after its sequence, before the glide. */
const HOLD_MS = 250;
const GLIDE_MS = 580;

export type LaunchStage = 'hold' | 'out';

/** The loading screen's mark box, `--pc-boot-art` in index.html: clamp(120px, 26vmin, 184px). */
function bootArt(width: number, height: number): number {
  return Math.min(184, Math.max(120, Math.min(width, height) * 0.26));
}

function glideTo(): CSSProperties {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const a = bootArt(w, h);
  // The stage is the art (a), a 0.16a gap and the 0.24a wordmark, centered: the art's center is at h/2 − 0.2a.
  const fromY = h / 2 - 0.2 * a;
  return {
    '--fr-glide-x': '12px',
    '--fr-glide-y': `${116 - fromY}px`,
    '--fr-glide-s': String(96 / a),
  } as CSSProperties;
}

export function Launch({ onOut, onDone }: { onOut: () => void; onDone: () => void }) {
  useBootSplashHold();
  const bootGone = useBootSplashGone();
  const [stage, setStage] = useState<LaunchStage>('hold');
  const [glide, setGlide] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    setGlide(glideTo());
  }, []);

  useEffect(() => {
    if (!bootGone || stage !== 'hold') return;
    const timer = window.setTimeout(() => {
      setStage('out');
      onOut();
    }, HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [bootGone, stage, onOut]);

  useEffect(() => {
    if (stage !== 'out') return;
    const timer = window.setTimeout(onDone, GLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [stage, onDone]);

  useEffect(() => {
    const skip = () => onDone();
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onDone]);

  return (
    <div className="pc-boot is-static fr-launch" data-stage={stage} style={glide} data-testid="fr-launch">
      <div className="pc-boot__stage">
        <div className="pc-boot__glow" />
        <div className="pc-boot__art fr-launch__art">
          <CordMark size={168} label="Paracord" />
        </div>
        <img className="pc-boot__word" src="/brand/wordmark.webp" alt="" aria-hidden="true" />
        <p className="pc-boot__status" role="status">
          Just a moment…
        </p>
      </div>
    </div>
  );
}
