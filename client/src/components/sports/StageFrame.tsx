import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SportsGame } from '../../api/sports';
import { statusLine } from './model';
import { landscapeStage } from './timeline';

export function StageFrame({
  game,
  hideScores,
  children,
}: {
  game: SportsGame;
  hideScores: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    const read = () => setLandscape(landscapeStage(window.innerWidth, window.innerHeight));
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggle = () => {
    const node = ref.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    void node.requestFullscreen?.();
  };

  const away = hideScores ? '–' : (game.away.score ?? '–');
  const home = hideScores ? '–' : (game.home.score ?? '–');
  return (
    <div ref={ref} className="pc-sports-stage-frame">
      {children}
      {(landscape || full) && (
        <div className="pc-sports-scorestrip" aria-hidden>
          <span className="pc-mono">{game.away.abbr} {away}</span>
          <span className="pc-mono">{statusLine(game)}</span>
          <span className="pc-mono">{home} {game.home.abbr}</span>
        </div>
      )}
      <button type="button" className="pc-focusable pc-sports-fill" onClick={toggle}>
        {full ? 'Close' : 'Fill screen'}
      </button>
    </div>
  );
}
