import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ChannelPin, SportsGame } from '../../api/sports';
import { sportsApi } from '../../api/sports';
import { useGuildChannels } from '../../hooks/useChannels';
import { usePermissions } from '../../hooks/usePermissions';
import { useSportsPolling, useSportsSettings } from '../../hooks/useSportsBoard';
import { useReducedMotion } from '../../lib/motion/reducedMotion';
import { ChannelType, Permissions, hasPermission } from '../../types';
import { useSportsStore } from '../../stores/sportsStore';
import { GameNight } from './GameNight';
import { miniFieldBar, teamPaint } from './gamecast';
import { HIDE_SCORES_EVENT, LIVE_POLL_MS, QUIET_POLL_MS, gameAriaLabel, gameHref, pinOneLine, readHideScores, runnersLabel, statusLine } from './model';
import { latestPlayText, pinGameKey } from './timeline';
import { TeamMark } from './TeamMark';

const NIGHT_KEY = 'paracord.sports.game-night';

function readNight(channelId: string): boolean {
  try {
    const raw = localStorage.getItem(NIGHT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed[channelId] === true;
  } catch {
    return false;
  }
}

function writeNight(channelId: string, open: boolean) {
  try {
    const raw = localStorage.getItem(NIGHT_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    localStorage.setItem(NIGHT_KEY, JSON.stringify({ ...parsed, [channelId]: open }));
  } catch {
    // A blocked store still toggles for this visit.
  }
}

function canManage(permissions: bigint, isAdmin: boolean): boolean {
  return isAdmin
    || hasPermission(permissions, Permissions.MANAGE_CHANNELS)
    || hasPermission(permissions, Permissions.MANAGE_GUILD);
}

export function PinGameButton({
  guildId,
  game,
}: {
  guildId: string;
  game: SportsGame;
}) {
  const { permissions, isAdmin, isLoading } = usePermissions(guildId || null);
  const channels = useGuildChannels(guildId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = !isLoading && canManage(permissions, isAdmin);
  if (!allowed) return null;
  const text = channels.filter((channel) => (channel.type ?? channel.channel_type) === ChannelType.Text);
  const key = pinGameKey(game);
  const pin = async (channelId: string) => {
    setError(null);
    try {
      const res = await sportsApi.pinGame(guildId, channelId, key);
      useSportsStore.getState().adoptSettings(res.data);
      setOpen(false);
    } catch {
      setError('That channel could not be pinned.');
    }
  };
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        className="pc-focusable text-label text-text-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Pin to a channel
      </button>
      {open && (
        <ul className="pc-sports-pin-picker" aria-label="Text channels">
          {text.length === 0 && <li className="text-meta text-text-muted">No text channels</li>}
          {text.map((channel) => (
            <li key={channel.id}>
              <button type="button" className="pc-focusable w-full truncate text-left text-label" onClick={() => { void pin(channel.id); }}>
                #{channel.name || 'channel'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="status" className="text-meta text-text-secondary">{error}</p>}
    </div>
  );
}

export function ChannelAmbient({
  guildId,
  channelId,
}: {
  guildId: string;
  channelId: string;
}) {
  const { settings, board } = useSportsSettings(guildId);
  const { permissions, isAdmin, isLoading } = usePermissions(guildId || null);
  const pins = settings?.channel_pins ?? [];
  const pin = pins.find((item) => item.channel_id === channelId) ?? null;
  const game = pin ? matchPin(pin, board?.games ?? []) : null;
  useSportsPolling(guildId, Boolean(pin && settings?.enabled), 'page');
  useEffect(() => {
    if (!pin || !settings?.enabled) return;
    const wait = game?.state === 'in' ? LIVE_POLL_MS : QUIET_POLL_MS;
    const timer = window.setInterval(() => {
      void useSportsStore.getState().refreshSettings(guildId);
    }, wait);
    return () => window.clearInterval(timer);
  }, [pin, settings?.enabled, game?.state, guildId]);
  if (!settings?.enabled || !pin || !game) return null;
  return (
    <AmbientStrip
      guildId={guildId}
      channelId={channelId}
      game={game}
      canUnpin={!isLoading && canManage(permissions, isAdmin)}
      onUnpin={async () => {
        const res = await sportsApi.unpinGame(guildId, channelId);
        useSportsStore.getState().adoptSettings(res.data);
      }}
    />
  );
}

function matchPin(pin: ChannelPin, games: SportsGame[]): SportsGame | null {
  return games.find((game) => pinGameKey(game) === pin.game) ?? null;
}

/** The board often omits last_play during a replay. The game detail still has the sentence. */
function useBoardPlay(guildId: string, game: SportsGame): string | null {
  const boardPlay = game.last_play?.trim() || null;
  const [extra, setExtra] = useState<string | null>(null);
  useEffect(() => {
    if (boardPlay) return;
    const parts = game.league_path.split('/');
    if (parts.length !== 2) return;
    let cancelled = false;
    const load = () => {
      void sportsApi.getGame(guildId, parts[0], parts[1], game.id).then((res) => {
        if (cancelled) return;
        const text = latestPlayText(res.data);
        if (text) setExtra(text);
      }).catch(() => {});
    };
    load();
    if (game.state !== 'in') return () => { cancelled = true; };
    const timer = window.setInterval(load, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boardPlay, guildId, game.league_path, game.id, game.state]);
  return boardPlay || extra;
}

export function AmbientStrip({
  guildId,
  channelId,
  game,
  canUnpin,
  onUnpin,
}: {
  guildId: string;
  channelId: string;
  game: SportsGame;
  canUnpin: boolean;
  onUnpin: () => void;
}) {
  const [hideScores, setHideScores] = useState(readHideScores);
  const stageable = game.sport === 'football' || game.sport === 'baseball';
  const [open, setOpen] = useState(() => stageable && readNight(channelId));
  const reduced = useReducedMotion();
  const flash = useSportsStore((state) => state.byGuild[guildId]?.flashes[game.id]);
  const [burst, setBurst] = useState<NonNullable<typeof flash> | null>(flash ?? null);
  useEffect(() => {
    const sync = () => setHideScores(readHideScores());
    window.addEventListener(HIDE_SCORES_EVENT, sync);
    return () => window.removeEventListener(HIDE_SCORES_EVENT, sync);
  }, []);
  useEffect(() => {
    if (open || !flash || flash.until <= Date.now()) {
      setBurst(null);
      return;
    }
    setBurst(flash);
    const timer = window.setTimeout(() => setBurst(null), Math.max(0, flash.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [open, flash]);
  const awayPaint = teamPaint(game.away, game.home);
  const homePaint = teamPaint(game.home, game.away);
  const away = awayPaint.fill;
  const home = homePaint.fill;
  const scorePaint = burst?.side === 'away' ? awayPaint : burst?.side === 'home' ? homePaint : null;
  const field = !hideScores && game.sport === 'football' ? miniFieldBar(game) : null;
  const awayScore = hideScores ? '–' : (game.away.score ?? '–');
  const homeScore = hideScores ? '–' : (game.home.score ?? '–');
  const playText = useBoardPlay(guildId, game);
  const flashing = Boolean(burst) && !reduced && !hideScores;
  return (
    <section
      className={`pc-sports-pin${open ? ' is-open' : ''}${flashing ? ' is-score' : ''}`}
      style={{
        ['--pc-away' as string]: away,
        ['--pc-home' as string]: home,
        ['--pc-score' as string]: scorePaint?.fill,
      }}
      aria-label={`Pinned game. ${gameAriaLabel(game, hideScores)}`}
    >
      <div className="pc-sports-pin-main">
        <span className="pc-sports-pin-label text-meta text-text-faint">Pinned game</span>
        <span className="pc-sports-pin-score pc-sports-pin-wide">
          <TeamMark team={game.away} />
          <span className="text-label text-text-primary">{game.away.abbr}</span>
          <span className="pc-mono text-label text-text-primary">{awayScore}</span>
          <span className="pc-mono text-meta text-text-secondary">{statusLine(game)}</span>
          <span className="pc-mono text-label text-text-primary">{homeScore}</span>
          <span className="text-label text-text-primary">{game.home.abbr}</span>
          <TeamMark team={game.home} />
        </span>
        <span className="pc-sports-pin-compact pc-mono">{pinOneLine(game, hideScores)}</span>
        {burst?.chip && !hideScores && (
          <span className="pc-sports-pin-chip" style={{ background: scorePaint?.fill, color: scorePaint?.ink }}>{burst.chip}</span>
        )}
        {stageable && (
          <button
            type="button"
            className="pc-focusable pc-sports-pin-chevron"
            aria-expanded={open}
            aria-label={open ? 'Collapse the game' : 'Expand the game'}
            onClick={() => {
              setOpen((value) => {
                const next = !value;
                writeNight(channelId, next);
                return next;
              });
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d={open ? 'M2 8 L6 4 L10 8' : 'M2 4 L6 8 L10 4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <Link to={gameHref(guildId, game)} className="pc-focusable shrink-0 text-label text-text-link">Open</Link>
        {canUnpin && (
          <button type="button" className="pc-focusable pc-sports-unpin" aria-label="Unpin" onClick={onUnpin}>
            ×
          </button>
        )}
      </div>
      {open && <GameNight guildId={guildId} game={game} hideScores={hideScores} />}
      {!open && !hideScores && (
        <div className="pc-sports-pin-more">
          {field && <PinField field={field} away={away} home={home} />}
          {game.sport === 'baseball' && <PinDiamond game={game} />}
          {playText && <p className="truncate text-meta text-text-faint">{playText}</p>}
        </div>
      )}
    </section>
  );
}

function PinField({
  field,
  away,
  home,
}: {
  field: NonNullable<ReturnType<typeof miniFieldBar>>;
  away: string;
  home: string;
}) {
  const x = (yards: number) => 10 + (Math.min(100, Math.max(0, yards)) / 100) * 100;
  return (
    <svg viewBox="0 0 120 18" preserveAspectRatio="none" className="pc-sports-minifield" role="img" aria-label={field.label}>
      <rect width="120" height="18" rx="2" fill="var(--sports-stadium)" />
      <rect x="10" y="2" width="100" height="14" fill="var(--sports-turf)" />
      <rect x="0" y="2" width="10" height="14" fill={home} />
      <rect x="110" y="2" width="10" height="14" fill={away} />
      <circle cx={x(field.ball)} cy="9" r="2.4" fill="var(--sports-leather)" />
    </svg>
  );
}

function PinDiamond({ game }: { game: SportsGame }) {
  const detail = game.detail.toLowerCase();
  const batting = detail.includes('bot') ? game.home : detail.includes('top') ? game.away : null;
  const other = batting?.id === game.home.id ? game.away : game.home;
  const fill = batting ? teamPaint(batting, other).fill : 'var(--text-faint)';
  const base = (on: boolean | null, points: string) => (
    <polygon points={points} fill={on ? fill : 'none'} stroke={on ? fill : 'var(--text-faint)'} strokeWidth="1.2" />
  );
  return (
    <svg viewBox="0 0 28 22" className="pc-sports-mini-diamond" role="img" aria-label={runnersLabel(game)}>
      {base(game.on_second, '14,2 18,6 14,10 10,6')}
      {base(game.on_third, '6,10 10,14 6,18 2,14')}
      {base(game.on_first, '22,10 26,14 22,18 18,14')}
    </svg>
  );
}
