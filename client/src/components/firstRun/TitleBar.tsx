import { useEffect } from 'react';

import { CordMark } from '../brand/CordMark';

/** The bar's height (firstRun.css `.fr-tb`): the window's controls center on it. */
const BAR_HEIGHT = 64;

/**
 * The first run's title bar (docs/setup-spec.md §1.1): the mark and "Paracord"
 * on the left, the progress segments centered, "Sign in instead" on the right.
 * On the desktop it is also the window's title bar: a press on it (not on a
 * control) moves the window, and the window's own controls sit at its right
 * (window-chrome).
 */
export function TitleBar({
  segments,
  filled,
  onSignIn,
  showSignIn,
}: {
  segments: number;
  filled: number;
  onSignIn: () => void;
  showSignIn: boolean;
}) {
  useWindowBand(BAR_HEIGHT);
  return (
    <header className="fr-tb" data-window-drag="deep">
      <div className="fr-brand">
        <CordMark size={24} />
        Paracord
      </div>
      {segments > 0 && (
        <div className="fr-prog" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={segments} aria-valuenow={filled}>
          {Array.from({ length: segments }, (_, k) => (
            <i key={k} data-done={k < filled ? '' : undefined} />
          ))}
        </div>
      )}
      {showSignIn && (
        <button type="button" className="fr-tb__alt" onClick={onSignIn}>
          Sign in instead
        </button>
      )}
    </header>
  );
}

/** Center the window's controls on this bar while it is up. */
function useWindowBand(height: number) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.windowBand = '';
    root.style.setProperty('--wc-band', `${height}px`);
    return () => {
      delete root.dataset.windowBand;
      root.style.removeProperty('--wc-band');
    };
  }, [height]);
}
