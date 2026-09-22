import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { sportsApi, type GameDetail } from '../api/sports';
import { detailInterval } from '../components/sports/gamecast';

/** A sentence for a failed game detail. Prefer the server's own words. */
export function gameDetailError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: unknown } | undefined;
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
    if (err.response?.status === 404) return 'Sports is turned off for this server.';
    if (err.response?.status === 400) return 'That game is not on a league this server follows.';
    if (err.response?.status === 502) return 'The live feed did not answer. Try again in a moment.';
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return 'This game could not be loaded.';
}

/**
 * Poll one game. 10s while it is live, 60s otherwise, and only while the
 * document is visible. Unmounting clears the timer. A 400 or 404 does not
 * keep asking.
 */
export function useGameDetail(guildId: string, sport: string, league: string, eventId: string) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const detailRef = useRef<GameDetail | null>(null);

  const reload = useCallback(() => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer != null) clearTimeout(timer);
      timer = undefined;
    };
    const arm = (state?: string) => {
      clear();
      if (stopped || document.hidden) return;
      const delay = detailInterval(state ?? detailRef.current?.game.state);
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };
    const tick = async () => {
      if (stopped || document.hidden) return;
      try {
        const res = await sportsApi.getGame(guildId, sport, league, eventId);
        if (stopped) return;
        detailRef.current = res.data;
        setDetail(res.data);
        setError(null);
        setStatus('ready');
        arm(res.data.game.state);
      } catch (err) {
        if (stopped) return;
        setError(gameDetailError(err));
        if (!detailRef.current) setStatus('error');
        const code = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (code === 400 || code === 404) return;
        arm(detailRef.current?.game.state);
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        clear();
        return;
      }
      void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [guildId, sport, league, eventId, attempt]);

  return { detail, error, status, reload };
}
