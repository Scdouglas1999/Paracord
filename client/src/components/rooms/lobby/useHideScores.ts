import { useEffect, useState } from 'react';

import { HIDE_SCORES_EVENT, readHideScores } from '../../sports/model';

/** The Sports add-on's "hide scores" choice, kept in step with its toggle. */
export function useHideScores(): boolean {
  const [hide, setHide] = useState(readHideScores);
  useEffect(() => {
    const sync = () => setHide(readHideScores());
    window.addEventListener(HIDE_SCORES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDE_SCORES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return hide;
}
