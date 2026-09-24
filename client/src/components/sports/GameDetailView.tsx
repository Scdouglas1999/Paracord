import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import { Link } from 'react-router';
import type { FootballDetail, GameDetail, SportsGame } from '../../api/sports';
import { Button, Plate, Switch } from '../ui';
import { useGameDetail } from '../../hooks/useGameDetail';
import { prefersReducedMotion } from '../../lib/motion/reducedMotion';
import {
  HIDE_SCORES_EVENT,
  gameAriaLabel,
  readHideScores,
  sportsHref,
  statusLine,
  stripMatchup,
  teamLabel,
  writeHideScores,
} from './model';
import {
  PLAY_STEP_MS,
  fieldPoint,
  footballFieldLabel,
  losingSide,
  openingDriveId,
  ordinal,
  pitchAnnouncement,
  scoreCall,
  redZoneYards,
  situationBugText,
  stepIndex,
  teamPaint,
  winAreaFill,
  winProbabilityText,
  yardSpot,
} from './gamecast';
import { FootballField, PlayLegend } from './FootballField';
import { BaseballPanels } from './BaseballPanels';
import { BoxScorePanel, DriveChart, GameSkeleton, LeadersPanel, LineScoreTable } from './detailPanels';
import { PitcherCharts } from './PitcherCharts';
import { PinGameButton } from './ChannelPin';
import { ScoringTimeline } from './ScoringTimeline';
import { StageFrame } from './StageFrame';
import { followedAtBatId, freshPlayId, landscapeStage } from './timeline';
import { TeamMark } from './TeamMark';

export function GameDetailView({
  guildId,
  sport,
  league,
  eventId,
  serverName,
}: {
  guildId: string;
  sport: string;
  league: string;
  eventId: string;
  serverName: string;
}) {
  const { detail, error, status, reload } = useGameDetail(guildId, sport, league, eventId);
  const [hideScores, setHideScores] = useState(readHideScores);
  const landscape = useLandscape();
  const hideId = useId();

  useEffect(() => {
    const sync = () => setHideScores(readHideScores());
    window.addEventListener(HIDE_SCORES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDE_SCORES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return (
    <div className={cn('pc-sports-page h-full min-w-0 overflow-x-hidden overflow-y-auto bg-bg-base', landscape ? 'is-landscape' : 'p-[var(--gutter)]')}>
      <Plate as="section" aria-label="Game" bare className="pc-sports-detail flex min-w-0 flex-col gap-5 px-4 py-5 sm:px-6">
        <Link to={sportsHref(guildId)} className="pc-focusable w-fit text-meta text-text-link">
          Back to Sports
        </Link>
        {status === 'loading' && !detail && <GameSkeleton sport={sport} />}
        {status === 'error' && (
          <div role="status" className="pc-well flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-label text-text-secondary">{error || 'This game could not be loaded.'}</p>
            <Button size="sm" onClick={reload}>Try again</Button>
          </div>
        )}
        {detail && (
          <DetailBody
            detail={detail}
            error={error}
            serverName={serverName}
            guildId={guildId}
            hideScores={hideScores}
            hideId={hideId}
            onHide={(next) => {
              setHideScores(next);
              writeHideScores(next);
            }}
          />
        )}
      </Plate>
    </div>
  );
}

function DetailBody({
  detail,
  error,
  serverName,
  guildId,
  hideScores,
  hideId,
  onHide,
}: {
  detail: GameDetail;
  error: string | null;
  serverName: string;
  guildId: string;
  hideScores: boolean;
  hideId: string;
  onHide: (next: boolean) => void;
}) {
  const game = detail.game;
  const matchup = stripMatchup(game);
  const chartText = winProbabilityText(detail.win_probability ?? [], teamLabel(game.home), game.state === 'post');

  return (
    <>
      <header
        className="pc-sports-hero-band"
        style={{
          '--pc-away': teamPaint(game.away, game.home).fill,
          '--pc-home': teamPaint(game.home, game.away).fill,
        } as CSSProperties}
      >
        <span className="pc-sports-wash" aria-hidden />
        <span className="pc-sports-header-scrim" aria-hidden />
        <span className="pc-sports-card-face flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="sr-only">{matchup}</h1>
            {serverName && <p className="truncate text-meta text-text-muted">{serverName}</p>}
          </div>
          <span className="flex shrink-0 flex-wrap items-start justify-end gap-3">
            <PinGameButton guildId={guildId} game={game} />
            <span id={hideId} className="text-label text-text-secondary">Hide scores</span>
            <Switch checked={hideScores} labeledBy={hideId} onChange={onHide} />
          </span>
        </div>
        <Scoreboard game={game} hideScores={hideScores} />
        {!hideScores && detail.line_score && (
          <LineScoreTable line={detail.line_score} game={game} baseball={detail.kind === 'baseball'} />
        )}
        {game.broadcasts.length > 0 && (
          <p className="text-center text-meta text-text-muted">On {game.broadcasts.slice(0, 4).join(', ')}</p>
        )}
        {!hideScores && chartText && (
          <WinChart
            points={detail.win_probability}
            caption={chartText}
            home={game.home}
            away={game.away}
          />
        )}
        {detail.stale && (
          <p role="status" className="text-label text-text-secondary">
            Showing the last update. The live feed did not answer.
          </p>
        )}
        {error && (
          <p role="status" className="text-label text-text-secondary">{error}</p>
        )}
        </span>
      </header>

      {detail.kind === 'football' && detail.football && (
        <FootballBody
          game={game}
          football={detail.football}
          hideScores={hideScores}
          scoringPlays={detail.scoring_plays ?? []}
          leaders={detail.leaders ?? []}
          box={detail.box}
        />
      )}
      {detail.kind === 'football' && !detail.football && (
        <p className="text-body text-text-secondary">This game did not include a field.</p>
      )}
      {detail.kind === 'baseball' && detail.baseball && (
        <BaseballBody detail={detail} hideScores={hideScores} />
      )}
      {detail.kind === 'baseball' && !detail.baseball && (
        <p className="text-body text-text-secondary">This game did not include a field.</p>
      )}
      {detail.kind === 'other' && (
        <p className="text-body text-text-secondary">A live field is available for football and baseball games.</p>
      )}

      {!hideScores && detail.kind !== 'football' && (detail.scoring_plays?.length ?? 0) > 0 && (
        <section aria-label="Scoring plays" className="flex flex-col gap-2">
          <h2 className="text-section text-text-faint">Scoring plays</h2>
          <ScoringTimeline plays={detail.scoring_plays} game={game} sport={detail.kind} hideScores={hideScores} />
        </section>
      )}
    </>
  );
}

function Scoreboard({ game, hideScores }: { game: SportsGame; hideScores: boolean }) {
  const loser = hideScores ? null : losingSide(game);
  const awayDim = loser === 'away';
  const homeDim = loser === 'home';
  return (
    <div className="pc-sports-scoreboard">
      <Club team={game.away} other={game.home} side="away" />
      <p className={awayDim ? 'pc-sports-bigscore pc-mono is-dim' : 'pc-sports-bigscore pc-mono'}>
        {hideScores ? '–' : (game.away.score ?? '–')}
      </p>
      <div className="pc-sports-status">
        {game.state === 'in' && <span className="pc-live-dot pc-sports-live" aria-hidden />}
        <span className="pc-mono text-label text-text-secondary">{statusLine(game)}</span>
        {hideScores && <span className="text-meta text-text-muted">Scores hidden</span>}
      </div>
      <p className={homeDim ? 'pc-sports-bigscore pc-mono is-dim' : 'pc-sports-bigscore pc-mono'}>
        {hideScores ? '–' : (game.home.score ?? '–')}
      </p>
      <Club team={game.home} other={game.away} side="home" />
    </div>
  );
}

function Club({
  team,
  other,
  side,
}: {
  team: SportsGame['home'];
  other: SportsGame['home'];
  side: 'home' | 'away';
}) {
  const paint = teamPaint(team, other);
  return (
    <div className={side === 'home' ? 'pc-sports-club is-home' : 'pc-sports-club is-away'}>
      {side === 'away' && <TeamMark team={team} size="xl" />}
      <div className={side === 'home' ? 'min-w-0 text-right' : 'min-w-0'}>
        <p className="truncate font-display text-name text-text-primary">{teamLabel(team)}</p>
        {team.record && <p className="pc-mono text-meta text-text-faint">{team.record}</p>}
      </div>
      {side === 'home' && <TeamMark team={team} size="xl" />}
      <span className="pc-sports-team-bar" style={{ background: paint.fill }} aria-hidden />
    </div>
  );
}

function WinChart({
  points,
  caption,
  home,
  away,
}: {
  points: { home_pct: number }[];
  caption: string;
  home: SportsGame['home'];
  away: SportsGame['home'];
}) {
  const width = 640;
  const height = 96;
  const frame = { width, height, left: 36, right: 8, top: 16, bottom: 16 };
  const plotW = width - frame.left - frame.right;
  const plotH = height - frame.top - frame.bottom;
  const yOf = (pct: number) => frame.top + (1 - Math.min(100, Math.max(0, pct)) / 100) * plotH;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? frame.left + plotW / 2 : frame.left + (index / (points.length - 1)) * plotW;
    return `${x},${yOf(point.home_pct)}`;
  }).join(' ');
  const mid = yOf(50);
  const area = winAreaFill(points, frame);
  const homePaint = teamPaint(home, away);
  const awayPaint = teamPaint(away, home);
  const endAbbr = area?.end.side === 'away' ? away.abbr : area?.end.side === 'home' ? home.abbr : '';
  const endLabel = area ? `${endAbbr} ${area.end.pct}`.trim() : '';
  return (
    <section aria-label="Win probability" className="pc-sports-winpanel">
      <h2 className="text-section text-text-faint">Win probability</h2>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" role="img" aria-label={caption}>
        <text x="0" y={frame.top} fill="var(--text-secondary)" fontSize="11" fontFamily="var(--font-display)">{home.abbr}</text>
        <text x="0" y={height - 4} fill="var(--text-secondary)" fontSize="11" fontFamily="var(--font-display)">{away.abbr}</text>
        <line x1={frame.left} x2={width - frame.right} y1={mid} y2={mid} stroke="var(--border-strong)" strokeDasharray="5 6" />
        {area?.home && <path d={area.home} fill={homePaint.fill} opacity="0.28" />}
        {area?.away && <path d={area.away} fill={awayPaint.fill} opacity="0.28" />}
        <polyline fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" points={coords} />
        {area && endLabel && (
          <text
            x={Math.min(area.end.x, width - 8)}
            y={Math.max(12, area.end.y - 6)}
            textAnchor="end"
            fill="var(--text-primary)"
            fontSize="12"
            fontFamily="var(--font-display)"
          >
            {endLabel}
          </text>
        )}
      </svg>
      <p className="text-meta text-text-muted">{caption}</p>
    </section>
  );
}

const FOOTBALL_BOX = ['passing', 'rushing', 'receiving', 'defensive'];

function FootballBody({
  game,
  football,
  hideScores,
  scoringPlays,
  leaders,
  box,
}: {
  game: SportsGame;
  football: FootballDetail;
  hideScores: boolean;
  scoringPlays: GameDetail['scoring_plays'];
  leaders: GameDetail['leaders'];
  box: GameDetail['box'];
}) {
  const drives = football.drives ?? [];
  const liveDrive = drives[drives.length - 1] ?? null;
  const liveCount = liveDrive?.plays.length ?? 0;
  const liveDriveId = liveDrive?.id ?? '';
  const live = game.state === 'in';
  const [driveId, setDriveId] = useState<string | null>(() => openingDriveId(drives, game.state));
  const [playIndex, setPlayIndex] = useState(() => {
    const id = openingDriveId(drives, game.state);
    const opening = (id ? drives.find((item) => item.id === id) : drives[drives.length - 1]) ?? null;
    return Math.max(0, (opening?.plays.length ?? 1) - 1);
  });
  const [playing, setPlaying] = useState(false);
  const [manual, setManual] = useState(!live);
  const [flat, setFlat] = useState(false);
  const [tab, setTab] = useState<'drive' | 'drives' | 'scoring' | 'box'>('drive');
  const [scoreBanner, setScoreBanner] = useState<'TOUCHDOWN' | 'FIELD GOAL' | null>(null);
  const tabId = useId();
  const playsBodyRef = useRef<HTMLDivElement>(null);
  const currentPlayRef = useRef<HTMLButtonElement>(null);
  const playScroll = useRef(0);
  const scrollDrive = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [seenPlay, setSeenPlay] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const seenPlayIds = useRef<Set<string> | null>(null);
  const [seenPossession, setSeenPossession] = useState<string | null>(null);
  const scoredPlay = useRef<string | null>(null);

  const drive = drives.find((item) => item.id === driveId) ?? liveDrive;
  const drivePlays = drive?.plays;
  const plays = useMemo(() => drivePlays ?? [], [drivePlays]);
  const count = plays.length;
  const play = plays[Math.min(playIndex, Math.max(0, count - 1))] ?? null;
  const following = live && !manual && (driveId == null || drive?.id === liveDrive?.id);

  useEffect(() => {
    if (hideScores && (tab === 'scoring' || tab === 'box')) setTab('drive');
  }, [hideScores, tab]);

  useEffect(() => {
    const id = play?.id ?? null;
    const call = scoreCall(play?.type, Boolean(play?.scoring) && !hideScores);
    if (scoredPlay.current === null) {
      scoredPlay.current = id;
      return;
    }
    if (scoredPlay.current === id) return;
    scoredPlay.current = id;
    if (!call) {
      setScoreBanner(null);
      return;
    }
    setScoreBanner(call);
    const timer = window.setTimeout(() => setScoreBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [play?.id, play?.type, play?.scoring, hideScores]);

  const driveKey = drive?.id ?? '';
  if (scrollDrive.current !== driveKey) {
    scrollDrive.current = driveKey;
    playScroll.current = 0;
  }

  useEffect(() => {
    const scroller = playsBodyRef.current;
    if (!scroller) return;
    const onScroll = () => { playScroll.current = scroller.scrollTop; };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [driveKey]);

  useLayoutEffect(() => {
    const scroller = playsBodyRef.current;
    if (!scroller || tab !== 'drive') return;
    if (scroller.scrollTop === 0 && playScroll.current > 8) {
      scroller.scrollTop = playScroll.current;
    }
  });

  useEffect(() => {
    const node = currentPlayRef.current;
    const scroller = playsBodyRef.current;
    if (!node || !scroller || tab !== 'drive') return;
    const box = node.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    if (box.height === 0 || frame.height === 0) return;
    if (box.top >= frame.top && box.bottom <= frame.bottom) return;
    const delta = box.top < frame.top ? box.top - frame.top : box.bottom - frame.bottom;
    scroller.scrollTo({
      top: scroller.scrollTop + delta,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [playIndex, tab, drive?.id]);

  useEffect(() => {
    if (!following || liveCount === 0) return;
    setPlayIndex(liveCount - 1);
  }, [following, liveDriveId, liveCount]);

  useEffect(() => {
    const next = freshPlayId(seenPlayIds.current, plays.map((item) => item.id));
    seenPlayIds.current = next.seen;
    if (!next.fresh) return;
    setFreshId(next.fresh);
    const timer = window.setTimeout(() => {
      setFreshId((current) => (current === next.fresh ? null : current));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [plays]);

  useEffect(() => {
    if (!playing) return;
    if (count === 0 || playIndex >= count - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setPlayIndex((index) => stepIndex(index, count, 1));
    }, PLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, playIndex, count]);

  useEffect(() => {
    const text = play?.text?.trim() ?? '';
    if (!text) return;
    if (seenPlay === null) {
      setSeenPlay(play?.id ?? text);
      return;
    }
    if (seenPlay === (play?.id ?? text)) return;
    setSeenPlay(play?.id ?? text);
    setAnnouncement(text.endsWith('.') ? text : `${text}.`);
  }, [play?.id, play?.text, seenPlay]);

  useEffect(() => {
    const id = football.possession_team_id;
    if (!id) return;
    if (seenPossession && seenPossession !== id) {
      setNotice(play?.scoring ? 'Score' : 'Turnover');
      const timer = window.setTimeout(() => setNotice(null), 2000);
      setSeenPossession(id);
      return () => window.clearTimeout(timer);
    }
    setSeenPossession(id);
  }, [football.possession_team_id, play?.scoring, seenPossession]);

  const possessionId = following
    ? football.possession_team_id
    : (play?.team_id ?? football.possession_team_id);
  const yards = following
    ? football.ball_on
    : (play?.end_yard ?? football.ball_on);
  const distance = following ? football.distance : (play?.distance ?? football.distance);
  const direction = yards == null
    ? 1
    : fieldPoint(yards, possessionId, game.home.id, game.away.id).direction;
  const zone = redZoneYards(direction);
  const redZone = following
    ? football.red_zone === true
    : yards != null && yards >= zone.from && yards <= zone.to;
  const downText = following
    ? football.down_distance_text
    : (play?.down != null && play.distance != null ? `${ordinal(play.down)} and ${play.distance}` : football.down_distance_text);
  const possessionAbbr = live ? abbrFor(possessionId, game) : null;
  const possessionTeam = live ? teamFor(possessionId, game) : null;
  const playWords = hideScores && play?.scoring ? null : play?.text;
  const label = live
    ? footballFieldLabel({
      ballOn: yards,
      downText,
      homeAbbr: game.home.abbr,
      awayAbbr: game.away.abbr,
      possessionAbbr,
      playText: playWords,
    })
    : ['Final. Replay any drive.', playWords].filter(Boolean).join(' ');
  const spot = yards == null ? null : yardSpot(yards, game.home.abbr, game.away.abbr);

  const chooseDrive = (id: string) => {
    setPlaying(false);
    const chosen = drives.find((item) => item.id === id);
    const isLive = live && id === liveDrive?.id;
    setManual(!isLive);
    setDriveId(isLive ? null : id);
    setPlayIndex(isLive ? Math.max(0, (chosen?.plays.length ?? 1) - 1) : 0);
    setTab('drive');
  };

  return (
    <>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <div className="pc-sports-game">
      <div className="pc-sports-field-column flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="flex min-h-6 min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden text-label text-text-secondary">
            {live ? (
              <>
                {downText && <span className="pc-mono">{downText}</span>}
                {spot && <span>{downText ? '· ' : ''}Ball on {spot}</span>}
                {possessionTeam && possessionAbbr && (
                  <span className="inline-flex items-center gap-1.5">
                    <TeamMark team={possessionTeam} />
                    {possessionAbbr} has the ball
                  </span>
                )}
                {redZone && <span>Red zone</span>}
              </>
            ) : (
              <span>{game.state === 'post' ? 'Final — replay any drive' : 'Replay any drive'}</span>
            )}
          </p>
          <Button size="sm" variant={flat ? 'primary' : 'ghost'} aria-pressed={flat} onClick={() => setFlat((value) => !value)}>
            Flat view
          </Button>
        </div>
        <StageFrame game={game} hideScores={hideScores}>
        <FootballField
          yards={yards}
          possessionTeamId={possessionId}
          home={game.home}
          away={game.away}
          distance={live ? distance : null}
          redZone={live && redZone}
          live={live}
          plays={plays}
          driveTeamId={drive?.team_id ?? null}
          playIndex={Math.min(playIndex, Math.max(0, count - 1))}
          label={label || gameAriaLabel(game, hideScores)}
          notice={live ? notice : null}
          scoreCall={scoreBanner}
          scoreSide={scoreBanner ? (direction > 0 ? 'right' : 'left') : null}
          scorePaint={scoreBanner && play?.team_id ? teamPaint(
            play.team_id === game.away.id ? game.away : game.home,
            play.team_id === game.away.id ? game.home : game.away,
          ).fill : null}
          flat={flat}
          bugText={situationBugText({
            state: game.state,
            downText,
            spot,
            clock: game.clock,
            awayAbbr: game.away.abbr,
            homeAbbr: game.home.abbr,
            awayScore: game.away.score,
            homeScore: game.home.score,
            hideScores,
          })}
        />
        </StageFrame>
        {drive && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setManual(true); setPlayIndex((index) => stepIndex(index, count, -1)); }} disabled={playIndex <= 0}>
              Previous play
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setManual(true); setPlayIndex((index) => stepIndex(index, count, 1)); }} disabled={playIndex >= count - 1}>
              Next play
            </Button>
            <Button
              size="sm"
              variant="primary"
              aria-label="Play this drive"
              onClick={() => {
                setManual(true);
                if (drive.id !== liveDrive?.id) setDriveId(drive.id);
                setPlayIndex(0);
                setPlaying(true);
              }}
              disabled={count < 2}
            >
              {playing ? 'Playing' : 'Play'}
            </Button>
          </div>
        )}
        <PlayLegend live={live} />
        {!hideScores && <LeadersPanel leaders={leaders} game={game} />}
      </div>
      <div className="pc-sports-plays">
        <div role="tablist" aria-label="Drives" className="pc-sports-tabs">
          <button type="button" role="tab" id={`${tabId}-drive`} className="pc-focusable" aria-selected={tab === 'drive'} aria-controls={`${tabId}-panel-drive`} onClick={() => setTab('drive')}>This drive</button>
          <button type="button" role="tab" id={`${tabId}-drives`} className="pc-focusable" aria-selected={tab === 'drives'} aria-controls={`${tabId}-panel-drives`} onClick={() => setTab('drives')}>All drives</button>
          {!hideScores && (
            <button type="button" role="tab" id={`${tabId}-scoring`} className="pc-focusable" aria-selected={tab === 'scoring'} aria-controls={`${tabId}-panel-scoring`} onClick={() => setTab('scoring')}>Scoring</button>
          )}
          {!hideScores && box && (
            <button type="button" role="tab" id={`${tabId}-box`} className="pc-focusable" aria-selected={tab === 'box'} aria-controls={`${tabId}-panel-box`} onClick={() => setTab('box')}>Box score</button>
          )}
        </div>
        <div ref={playsBodyRef} role="tabpanel" id={`${tabId}-panel-drive`} aria-labelledby={`${tabId}-drive`} hidden={tab !== 'drive'} className="pc-sports-plays-body">
          {drive?.description && (
            <p className="text-label text-text-primary">{drive.description}{drive.result ? ` · ${drive.result}` : ''}</p>
          )}
          <ul className="flex flex-col gap-1">
            {plays.map((item, index) => {
              const side = item.team_id === game.away.id ? game.away : item.team_id === game.home.id ? game.home : null;
              const ink = side ? teamPaint(side, side.id === game.away.id ? game.home : game.away).fill : undefined;
              const fresh = freshId === item.id;
              return (
              <li key={item.id}>
                <button
                  type="button"
                  ref={index === playIndex ? currentPlayRef : undefined}
                  className={index === playIndex
                    ? `pc-focusable pc-sports-play-row is-current w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-label${fresh ? ' is-fresh' : ''}`
                    : `pc-focusable pc-sports-play-row w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-label text-text-secondary hover:bg-bg-mod-strong${fresh ? ' is-fresh' : ''}`}
                  style={fresh && ink ? { ['--pc-play' as string]: ink } : undefined}
                  aria-current={index === playIndex ? 'step' : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setManual(true);
                    setPlayIndex(index);
                  }}
                >
                  <span className="pc-mono mr-2 text-meta text-text-faint">{item.clock}</span>
                  {hideScores && item.scoring ? 'Scoring play hidden' : item.text}
                </button>
              </li>
              );
            })}
          </ul>
        </div>
        <div role="tabpanel" id={`${tabId}-panel-drives`} aria-labelledby={`${tabId}-drives`} hidden={tab !== 'drives'} className="pc-sports-plays-body">
          <DriveChart
            drives={drives}
            game={game}
            selectedId={drive?.id ?? null}
            onSelect={chooseDrive}
            scoringPlays={scoringPlays}
            hideScores={hideScores}
          />
        </div>
        {!hideScores && box && (
          <div role="tabpanel" id={`${tabId}-panel-box`} aria-labelledby={`${tabId}-box`} hidden={tab !== 'box'} className="pc-sports-plays-body">
            <BoxScorePanel box={box} game={game} kinds={FOOTBALL_BOX} />
          </div>
        )}
        {!hideScores && (
          <div role="tabpanel" id={`${tabId}-panel-scoring`} aria-labelledby={`${tabId}-scoring`} hidden={tab !== 'scoring'} className="pc-sports-plays-body">
            <section aria-label="Scoring plays">
              <ScoringTimeline plays={scoringPlays} game={game} sport="football" hideScores={hideScores} />
            </section>
          </div>
        )}
      </div>
      </div>
    </>
  );
}

function BaseballBody({ detail, hideScores }: { detail: GameDetail; hideScores: boolean }) {
  const baseball = detail.baseball;
  const [atBatId, setAtBatId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [seen, setSeen] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);
  const atBats = baseball?.at_bats ?? [];
  const followedId = followedAtBatId(atBats.map((item) => item.id), atBatId);
  const selected = atBats.find((item) => item.id === followedId) ?? null;
  const pitch = selected?.pitches?.[selected.pitches.length - 1];
  const pitchKey = pitch ? `${selected?.id}:${pitch.n}` : null;

  useEffect(() => {
    if (!pitchKey || !pitch) return;
    if (seen === null) {
      setSeen(pitchKey);
      return;
    }
    if (seen === pitchKey) return;
    setSeen(pitchKey);
    setAnnouncement(pitchAnnouncement(pitch));
  }, [pitchKey, pitch, seen]);

  return (
    <div className="pc-sports-baseball-wrap flex min-w-0 flex-col gap-3">
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <div className="flex justify-end">
        <Button size="sm" variant={flat ? 'primary' : 'ghost'} aria-pressed={flat} onClick={() => setFlat((value) => !value)}>
          Flat view
        </Button>
      </div>
      {baseball && (
        <>
          <BaseballPanels
            baseball={baseball}
            game={detail.game}
            selectedId={atBatId}
            onSelect={setAtBatId}
            flat={flat}
            hideScores={hideScores}
            leaders={detail.leaders ?? []}
            probables={detail.probables ?? []}
            box={detail.box}
          />
          <PitcherCharts atBats={atBats} />
        </>
      )}
    </div>
  );
}

function useLandscape(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(landscapeStage(window.innerWidth, window.innerHeight));
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return on;
}

function abbrFor(id: string | null | undefined, game: SportsGame): string | null {
  if (id && id === game.home.id) return game.home.abbr;
  if (id && id === game.away.id) return game.away.abbr;
  return null;
}

function teamFor(id: string | null | undefined, game: SportsGame): SportsGame['home'] | null {
  if (id && id === game.home.id) return game.home;
  if (id && id === game.away.id) return game.away;
  return null;
}
