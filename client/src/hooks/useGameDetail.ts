import { useCallback, useEffect, useState } from 'react';
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

interface DetailSnap {
  detail: GameDetail | null;
  error: string | null;
  status: 'loading' | 'ready' | 'error';
}

interface DetailSlot {
  args: { guildId: string; sport: string; league: string; eventId: string };
  listeners: Set<(snap: DetailSnap) => void>;
  snap: DetailSnap;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
  onVisibility: () => void;
}

const detailSlots = new Map<string, DetailSlot>();

function detailKey(guildId: string, sport: string, league: string, eventId: string): string {
  return `${guildId}/${sport}/${league}/${eventId}`;
}

function emitDetail(slot: DetailSlot) {
  for (const listener of slot.listeners) listener(slot.snap);
}

function clearDetailTimer(slot: DetailSlot) {
  if (slot.timer != null) clearTimeout(slot.timer);
  slot.timer = undefined;
}

function armDetail(slot: DetailSlot, state?: string) {
  clearDetailTimer(slot);
  if (slot.stopped || slot.listeners.size === 0 || document.hidden) return;
  const delay = detailInterval(state ?? slot.snap.detail?.game?.state);
  slot.timer = setTimeout(() => {
    void tickDetail(slot);
  }, delay);
}

async function tickDetail(slot: DetailSlot) {
  if (slot.stopped || document.hidden) return;
  const { guildId, sport, league, eventId } = slot.args;
  try {
    const res = await sportsApi.getGame(guildId, sport, league, eventId);
    if (slot.stopped) return;
    slot.snap = { detail: res.data, error: null, status: 'ready' };
    emitDetail(slot);
    armDetail(slot, res.data.game.state);
  } catch (err) {
    if (slot.stopped) return;
    const had = slot.snap.detail != null;
    slot.snap = {
      detail: slot.snap.detail,
      error: gameDetailError(err),
      status: had ? 'ready' : 'error',
    };
    emitDetail(slot);
    const code = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (code === 400 || code === 404) return;
    armDetail(slot, slot.snap.detail?.game?.state);
  }
}

function dropDetailSlot(key: string, slot: DetailSlot) {
  slot.stopped = true;
  clearDetailTimer(slot);
  document.removeEventListener('visibilitychange', slot.onVisibility);
  detailSlots.delete(key);
}

/**
 * One poll per game, shared by every view that has it open. The pinned
 * stage and the game page therefore do not each fetch.
 */
export function watchGameDetail(
  guildId: string,
  sport: string,
  league: string,
  eventId: string,
  listener: (snap: DetailSnap) => void,
): () => void {
  const key = detailKey(guildId, sport, league, eventId);
  let slot = detailSlots.get(key);
  if (!slot) {
    const created: DetailSlot = {
      args: { guildId, sport, league, eventId },
      listeners: new Set(),
      snap: { detail: null, error: null, status: 'loading' },
      timer: undefined,
      stopped: false,
      onVisibility: () => {},
    };
    created.onVisibility = () => {
      if (document.hidden) {
        clearDetailTimer(created);
        return;
      }
      void tickDetail(created);
    };
    detailSlots.set(key, created);
    document.addEventListener('visibilitychange', created.onVisibility);
    slot = created;
    void tickDetail(created);
  }
  slot.listeners.add(listener);
  listener(slot.snap);
  return () => {
    const current = detailSlots.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) dropDetailSlot(key, current);
  };
}

/** Drop every shared detail poll. Tests use this between cases. */
export function resetGameDetailWatchers() {
  for (const [key, slot] of detailSlots) dropDetailSlot(key, slot);
}

/**
 * Poll one game. 10s while it is live, 60s otherwise, and only while the
 * document is visible. Unmounting clears the timer when nothing else is
 * watching. A 400 or 404 does not keep asking.
 */
export function useGameDetail(guildId: string, sport: string, league: string, eventId: string) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const reload = useCallback(() => {
    setStatus('loading');
    const key = detailKey(guildId, sport, league, eventId);
    const slot = detailSlots.get(key);
    if (slot) void tickDetail(slot);
  }, [guildId, sport, league, eventId]);

  useEffect(() => {
    return watchGameDetail(guildId, sport, league, eventId, (snap) => {
      setDetail(snap.detail);
      setError(snap.error);
      setStatus(snap.status);
    });
  }, [guildId, sport, league, eventId]);

  return { detail, error, status, reload };
}
