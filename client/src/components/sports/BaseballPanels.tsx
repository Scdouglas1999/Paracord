import { useEffect, useId, useRef, useState } from 'react';
import type { AtBat, BaseballDetail, Pitch, PitchResult, SportsAthlete, SportsGame, SportsTeam } from '../../api/sports';
import { AthleteMark } from './TeamMark';
import {
  BASE_POINTS,
  GAMEDAY,
  ZONE_VIEW,
  baseballFieldLabel,
  baseballScorebug,
  catcherLayout,
  diffRunners,
  hitArcControl,
  hitToField,
  pitchInFrame,
  pitchMark,
  pitchResultLabel,
  strikeZoneOrDefault,
  teamPaint,
  type RunnerChange,
} from './gamecast';

const RESULTS: PitchResult[] = ['ball', 'strike-looking', 'strike-swinging', 'foul', 'in-play'];

function starPoints(radius: number): string {
  const points: string[] = [];
  for (let step = 0; step < 10; step += 1) {
    const arm = step % 2 === 0 ? radius : radius * 0.36;
    const angle = -Math.PI / 2 + (step * Math.PI) / 5;
    points.push(`${(Math.cos(angle) * arm).toFixed(2)},${(Math.sin(angle) * arm).toFixed(2)}`);
  }
  return points.join(' ');
}

/** Filled marks. Shape carries the result; the color is a second cue. */
function PitchShape({ result }: { result: string | null | undefined }) {
  const mark = pitchMark(result);
  if (mark.shape === 'square') {
    return <rect x="-8" y="-8" width="16" height="16" rx="1.5" fill={mark.fill} />;
  }
  if (mark.shape === 'diamond') {
    return <rect x="-6" y="-6" width="12" height="12" rx="1" fill={mark.fill} transform="rotate(45)" />;
  }
  if (mark.shape === 'triangle') {
    return <polygon points="0,-9 8,7 -8,7" fill={mark.fill} />;
  }
  if (mark.shape === 'star') {
    return <polygon points={starPoints(9.6)} fill={mark.fill} />;
  }
  if (mark.shape === 'ring') {
    return <circle r="7" fill="none" stroke={mark.fill} strokeWidth="2" />;
  }
  return <circle r="8" fill={mark.fill} />;
}

function fraction(point: { x: number; y: number }): { nx: string; ny: string } {
  return { nx: String(point.x / GAMEDAY.size), ny: String(point.y / GAMEDAY.size) };
}

function batsCaption(bats: 'L' | 'R' | 'S' | null): string | null {
  if (bats === 'L') return 'Bats L';
  if (bats === 'R') return 'Bats R';
  if (bats === 'S') return 'Bats either';
  return null;
}

/**
 * Strike zone (catcher's view) and the diamond. Runners are drawn only on
 * the bases the feed names. A hit lands only where the feed gives a coordinate.
 */
export function BaseballPanels({
  baseball,
  game,
  selectedId,
  onSelect,
  flat,
  hideScores,
}: {
  baseball: BaseballDetail;
  game: SportsGame;
  selectedId: string | null;
  onSelect: (id: string) => void;
  flat: boolean;
  hideScores: boolean;
}) {
  const atBats = baseball.at_bats ?? [];
  const selected = atBats.find((atBat) => atBat.id === selectedId) ?? atBats[atBats.length - 1] ?? null;
  const pitches = (selected?.pitches ?? []).filter((pitch) => pitch.x != null && pitch.y != null);
  const newest = pitches[pitches.length - 1];
  const zone = strikeZoneOrDefault(baseball.strike_zone);
  const live = game.state === 'in';
  const status = baseballScorebug({
    state: game.state,
    detail: game.detail,
    half: baseball.half,
    inning: baseball.inning,
    balls: baseball.balls,
    strikes: baseball.strikes,
    outs: baseball.outs,
  });
  const label = baseballFieldLabel({
    live,
    status,
    half: baseball.half,
    inning: baseball.inning,
    outs: baseball.outs,
    balls: baseball.balls,
    strikes: baseball.strikes,
    bases: baseball.bases,
  });
  const batter = selected?.batter ?? baseball.batter;
  const pitcher = selected?.pitcher ?? baseball.pitcher;
  const bats = batsCaption(baseball.bats);
  const [hot, setHot] = useState<number | null>(null);
  const stance = stanceSide(selected, baseball);
  const atBatHalf = selected?.half ?? baseball.half;
  const atBatTeam = atBatHalf === 'bottom' ? game.home : atBatHalf === 'top' ? game.away : null;
  const atBatOther = atBatTeam?.id === game.home.id ? game.away : game.home;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="pc-sports-scorebug pc-mono text-label text-text-secondary">{status}</p>
      {(batter || pitcher) && (
        <div className="flex min-w-0 flex-wrap gap-4">
          {batter && (
            <p className="flex min-w-0 items-center gap-2 text-label text-text-primary">
              <AthleteMark athlete={batter} />
              <span className="min-w-0 truncate">{batter.short_name || batter.name || 'Batter'}</span>
            </p>
          )}
          {pitcher && (
            <p className="flex min-w-0 items-center gap-2 text-label text-text-secondary">
              <AthleteMark athlete={pitcher} />
              <span className="min-w-0 truncate">{pitcher.short_name || pitcher.name || 'Pitcher'}</span>
            </p>
          )}
        </div>
      )}
      <div className="pc-sports-baseball">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="pc-sports-zone-row">
            <div className="pc-sports-zone">
              <StrikeZone
                pitches={pitches}
                newestId={newest ? `${newest.n}` : null}
                zone={zone}
                stance={stance}
                hot={hot}
                onHot={setHot}
                label={pitches.length > 0 ? `${pitches.length} pitches from the catcher` : 'Strike zone from the catcher'}
              />
              {bats && <p className="text-meta text-text-muted">{bats}</p>}
            </div>
            <table className="pc-sports-pitch-list">
              <caption className="sr-only">Pitches</caption>
              <tbody>
                {pitches.map((pitch) => {
                  const mark = pitchMark(pitch.result);
                  const fresh = String(pitch.n) === String(newest?.n);
                  const lit = hot === pitch.n;
                  return (
                    <tr key={pitch.n} className={lit ? 'is-hot' : fresh ? 'is-fresh' : undefined}>
                      <td className="pc-mono text-text-faint">{pitch.n}</td>
                      <td>
                        <span className="pc-sports-pitch-dot" style={{ background: mark.fill }} aria-hidden />
                        <span className="min-w-0 truncate">{pitch.type || pitch.type_abbr || 'Pitch'}</span>
                      </td>
                      <td className="pc-mono">{pitch.velocity != null ? `${Math.round(pitch.velocity)} mph` : ''}</td>
                      <td>{pitchResultLabel(pitch.result)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="pc-sports-legend" aria-label="Pitch marks">
            {RESULTS.map((result) => (
              <li key={result}>
                <svg width="18" height="18" viewBox="-12 -12 24 24" aria-hidden>
                  <PitchShape result={result} />
                </svg>
                {pitchResultLabel(result)}
              </li>
            ))}
          </ul>
        </div>
        <Diamond
          baseball={baseball}
          game={game}
          hit={selected?.hit ?? null}
          hitKey={selected?.id ?? ''}
          batting={atBatTeam}
          battingOther={atBatOther}
          label={label}
          flat={flat}
          hideScores={hideScores}
          status={status}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-section text-text-faint">At-bats</h2>
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {atBats.map((atBat) => (
            <li key={atBat.id}>
              <button
                type="button"
                className="pc-focusable flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-label text-text-secondary hover:bg-bg-mod-strong"
                aria-pressed={selected?.id === atBat.id}
                onClick={() => onSelect(atBat.id)}
              >
                <AthleteMark athlete={atBat.batter} />
                <AtBatLine atBat={atBat} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AtBatLine({ atBat }: { atBat: AtBat }) {
  const half = atBat.half === 'bottom' ? 'Bot' : atBat.half === 'top' ? 'Top' : '';
  const who = atBat.batter?.short_name || 'Batter';
  const result = atBat.result_text || (atBat.live ? 'At the plate' : 'At-bat');
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      {atBat.inning != null && half && (
        <span className="pc-mono shrink-0 text-meta text-text-faint">{`${half} ${atBat.inning}`}</span>
      )}
      <span className="min-w-0 truncate">{who}</span>
      <span className="min-w-0 truncate text-text-muted">{result}</span>
    </span>
  );
}

/**
 * A switch-hitter stands on the side of this at-bat when that side is known.
 * The feed only names bats for the player at the plate, so an earlier at-bat
 * stays on the right-handed side rather than guessing.
 */
function stanceSide(atBat: AtBat | null, baseball: BaseballDetail): 'L' | 'R' {
  const same = atBat?.batter && baseball.batter && atBat.batter.id === baseball.batter.id;
  const bats = same || !atBat ? baseball.bats : null;
  if (bats === 'L') return 'L';
  return 'R';
}

function pitchWords(pitch: Pitch): string {
  const type = pitch.type || pitch.type_abbr || 'Pitch';
  const speed = pitch.velocity != null ? `${Math.round(pitch.velocity)} mph` : null;
  return [type, speed, pitchResultLabel(pitch.result)].filter(Boolean).join(' · ');
}

function StrikeZone({
  pitches,
  newestId,
  zone,
  stance,
  hot,
  onHot,
  label,
}: {
  pitches: Pitch[];
  newestId: string | null;
  zone: { left: number; right: number; top: number; bottom: number };
  stance: 'L' | 'R';
  hot: number | null;
  onHot: (n: number | null) => void;
  label: string;
}) {
  const uid = useId().replace(/:/g, '');
  const layout = catcherLayout();
  const { plate, boxes, catcher } = layout;
  const zoneRect = layout.zone;
  const half = plate.width / 2;
  const points = pitches.map((pitch) => pitchInFrame(pitch.x ?? 0, pitch.y ?? 0, zone));
  const counts = heatCounts(points, zoneRect);
  const peak = Math.max(1, ...counts);
  const feet = boxes.y + boxes.height;
  const stanceX = stance === 'L' ? boxes.right + boxes.width / 2 : boxes.left + boxes.width / 2;
  return (
    <div className="pc-sports-zone-frame">
      <svg viewBox={`0 0 ${ZONE_VIEW.width} ${ZONE_VIEW.height}`} className="block h-full w-full" role="img" aria-label={label}>
        <defs>
          <linearGradient id={`${uid}-dirt`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="var(--sports-dirt-dark)" />
            <stop offset="0.38" stopColor="var(--sports-dirt)" />
            <stop offset="1" stopColor="var(--sports-dirt)" />
          </linearGradient>
        </defs>
        <rect width={ZONE_VIEW.width} height={ZONE_VIEW.height} fill={`url(#${uid}-dirt)`} rx="8" />
        {points.slice(1).map((point, index) => {
          const prev = points[index];
          if (point.held || prev.held) return null;
          return (
            <line
              key={`link-${index}`}
              x1={prev.x}
              y1={prev.y}
              x2={point.x}
              y2={point.y}
              stroke="var(--sports-chalk)"
              strokeWidth="1"
              opacity="0.25"
            />
          );
        })}
        <rect
          x={zoneRect.x}
          y={zoneRect.y}
          width={zoneRect.width}
          height={zoneRect.height}
          fill="none"
          stroke="var(--sports-chalk)"
          strokeWidth="1.75"
        />
        {counts.map((count, index) => {
          if (count === 0) return null;
          const col = index % 3;
          const row = Math.floor(index / 3);
          return (
            <rect
              key={index}
              x={zoneRect.x + (zoneRect.width * col) / 3}
              y={zoneRect.y + (zoneRect.height * row) / 3}
              width={zoneRect.width / 3}
              height={zoneRect.height / 3}
              fill="var(--sports-pitch-looking)"
              opacity={0.16 + (0.2 * count) / peak}
            />
          );
        })}
        {[1, 2].map((step) => (
          <g key={step} stroke="var(--sports-chalk)" strokeWidth="1" opacity="0.35">
            <line
              x1={zoneRect.x + (zoneRect.width * step) / 3}
              x2={zoneRect.x + (zoneRect.width * step) / 3}
              y1={zoneRect.y}
              y2={zoneRect.y + zoneRect.height}
            />
            <line
              y1={zoneRect.y + (zoneRect.height * step) / 3}
              y2={zoneRect.y + (zoneRect.height * step) / 3}
              x1={zoneRect.x}
              x2={zoneRect.x + zoneRect.width}
            />
          </g>
        ))}
        <rect x={boxes.left} y={boxes.y} width={boxes.width} height={boxes.height} fill="none" stroke="var(--sports-chalk)" strokeWidth="1.25" />
        <rect x={boxes.right} y={boxes.y} width={boxes.width} height={boxes.height} fill="none" stroke="var(--sports-chalk)" strokeWidth="1.25" />
        <rect x={catcher.x} y={catcher.y} width={catcher.width} height={catcher.height} fill="none" stroke="var(--sports-chalk)" strokeWidth="1" opacity="0.7" />
        <g stroke="var(--sports-chalk)" strokeWidth="1" opacity="0.4">
          <line x1={plate.cx - half} y1={plate.top + plate.height} x2={catcher.x} y2={catcher.y + catcher.height} />
          <line x1={plate.cx + half} y1={plate.top + plate.height} x2={catcher.x + catcher.width} y2={catcher.y + catcher.height} />
        </g>
        <path
          d={`M${plate.cx} ${plate.top} L${plate.cx + half} ${plate.top + plate.height * 0.42} L${plate.cx + half} ${plate.top + plate.height} L${plate.cx - half} ${plate.top + plate.height} L${plate.cx - half} ${plate.top + plate.height * 0.42} Z`}
          fill="var(--sports-chalk)"
        />
        <Batter stance={stance} x={stanceX} feetY={feet} height={layout.batterHeight} />
      </svg>
      <div className="pc-sports-pitch-hits">
        {pitches.map((pitch, index) => {
          const point = points[index];
          const fresh = String(pitch.n) === newestId;
          const abbr = pitch.type_abbr || pitch.type || 'Pitch';
          const speed = pitch.velocity != null ? String(Math.round(pitch.velocity)) : '';
          return (
            <button
              key={pitch.n}
              type="button"
              className={hot === pitch.n ? 'pc-sports-pitch-hit pc-focusable is-hot' : 'pc-sports-pitch-hit pc-focusable'}
              style={{
                left: `${(point.x / ZONE_VIEW.width) * 100}%`,
                top: `${(point.y / ZONE_VIEW.height) * 100}%`,
              }}
              aria-label={`Pitch ${pitch.n}. ${pitchWords(pitch)}`}
              onMouseEnter={() => onHot(pitch.n)}
              onMouseLeave={() => onHot(null)}
              onFocus={() => onHot(pitch.n)}
              onBlur={() => onHot(null)}
            >
              <svg width="26" height="26" viewBox="-12 -12 24 24" aria-hidden className={fresh ? 'pc-sports-pitch-in' : undefined}>
                {fresh && <circle className="pc-sports-pitch-halo" r="10" fill="var(--sports-chalk)" />}
                <PitchShape result={pitch.result} />
                <text textAnchor="middle" dominantBaseline="central" fill="var(--sports-pitch-ink)" fontSize="8" fontWeight="600" fontFamily="var(--font-display)">
                  {pitch.n}
                </text>
              </svg>
              {fresh && (abbr || speed) && (
                <span className="pc-sports-pitch-chip pc-mono">{[abbr, speed].filter(Boolean).join(' ')}</span>
              )}
              <span className="pc-sports-pitch-tip" aria-hidden>{pitchWords(pitch)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function heatCounts(
  points: { x: number; y: number; held: boolean }[],
  zoneRect: { x: number; y: number; width: number; height: number },
): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (zoneRect.width <= 0 || zoneRect.height <= 0) return counts;
  for (const point of points) {
    if (point.held) continue;
    if (point.x < zoneRect.x || point.x > zoneRect.x + zoneRect.width) continue;
    if (point.y < zoneRect.y || point.y > zoneRect.y + zoneRect.height) continue;
    const col = Math.min(2, Math.floor(((point.x - zoneRect.x) / zoneRect.width) * 3));
    const row = Math.min(2, Math.floor(((point.y - zoneRect.y) / zoneRect.height) * 3));
    counts[row * 3 + col] += 1;
  }
  return counts;
}

/** Feet on the box baseline. Tall enough that the head sits near the top of the panel. The bat reaches the plate. */
function Batter({ stance, x, feetY, height }: { stance: 'L' | 'R'; x: number; feetY: number; height: number }) {
  const unit = height / 100;
  const face = stance === 'L' ? -unit : unit;
  return (
    <g transform={`translate(${x} ${feetY}) scale(${face} ${-unit})`} fill="var(--text-faint)">
      <path d="M-4 0 L-6 30 L2 32 L3 2 Z" />
      <path d="M-1 14 L-4 50 L2 52 L5 16 Z" />
      <path d="M-6 28 C-6 54 2 62 7 48 L6 26 Z" />
      <path d="M-2 56 H4 L3 78 H-1 Z" />
      <circle cx="2" cy="84" r="10" />
      <path d="M-4 78 H10 L8 84 H-2 Z" />
      <path d="M2 50 L6 66 L10 62 L6 46 Z" />
      <path d="M4 46 L14 66 L17 62 L7 42 Z" />
    </g>
  );
}

function Diamond({
  baseball,
  game,
  hit,
  hitKey,
  batting,
  battingOther,
  label,
  flat,
  hideScores,
  status,
}: {
  baseball: BaseballDetail;
  game: SportsGame;
  hit: { x: number; y: number; trajectory: string | null } | null;
  hitKey: string;
  batting: SportsTeam | null;
  battingOther: SportsTeam | null;
  label: string;
  flat: boolean;
  hideScores: boolean;
  status: string;
}) {
  const [ghosts, setGhosts] = useState<RunnerChange[]>([]);
  const prev = useRef(baseball.bases);
  const outs = useRef(baseball.outs ?? 0);
  const seen = useRef(false);

  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      prev.current = baseball.bases;
      outs.current = baseball.outs ?? 0;
      return;
    }
    const scoring = baseball.at_bats[baseball.at_bats.length - 1]?.scoring === true;
    const changes = diffRunners(prev.current, baseball.bases, {
      outsBefore: outs.current,
      outsAfter: baseball.outs ?? 0,
      scoring,
      inningChanged: (baseball.outs ?? 0) < outs.current,
    });
    prev.current = baseball.bases;
    outs.current = baseball.outs ?? 0;
    const scored = changes.filter((change) => change.kind === 'scored');
    if (scored.length === 0) return;
    setGhosts(scored);
    const timer = window.setTimeout(() => setGhosts([]), 1200);
    return () => window.clearTimeout(timer);
  }, [baseball.bases, baseball.outs, baseball.at_bats]);

  const landing = hit ? hitToField(hit.x, hit.y) : null;
  const control = landing ? hitArcControl(landing, hit?.trajectory) : null;
  const plate = fraction(BASE_POINTS.home);
  const mid = control ? fraction(control) : plate;
  const end = landing ? fraction(landing) : plate;
  const uid = useId().replace(/:/g, '');
  const runnerTeam = baseball.half === 'bottom' ? game.home : baseball.half === 'top' ? game.away : null;
  const runnerOther = runnerTeam?.id === game.home.id ? game.away : game.home;
  const occupiedFill = runnerTeam ? teamPaint(runnerTeam, runnerOther).fill : 'var(--sports-chalk)';
  const hitFill = batting ? teamPaint(batting, battingOther).fill : 'var(--sports-chalk)';

  const runners: { id: string; name: string; athlete: SportsAthlete | null; point: { x: number; y: number } }[] = (['first', 'second', 'third'] as const).flatMap((name) => {
    const athlete = baseball.bases[name];
    if (!athlete) return [];
    return [{ id: athlete.id, name: athlete.short_name || athlete.name || 'Runner', athlete, point: BASE_POINTS[name] }];
  });
  for (const ghost of ghosts) {
    if (runners.some((runner) => runner.id === ghost.id)) continue;
    runners.push({ id: ghost.id, name: ghost.shortName, athlete: null, point: BASE_POINTS.home });
  }

  return (
    <div className="pc-sports-field-stage is-ballpark" data-flat={flat ? 'true' : 'false'}>
      <div className="pc-sports-field-plane">
        <svg viewBox={`0 0 ${GAMEDAY.size} ${GAMEDAY.size}`} className="block h-auto w-full" role="img" aria-label={label}>
          <defs>
            <linearGradient id={`${uid}-trail`} x1={GAMEDAY.plateX} y1={GAMEDAY.plateY} x2={landing?.x ?? GAMEDAY.plateX} y2={landing?.y ?? GAMEDAY.plateY} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={hitFill} stopOpacity="0.05" />
              <stop offset="1" stopColor={hitFill} stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <rect width={GAMEDAY.size} height={GAMEDAY.size} fill="var(--sports-turf)" />
          <clipPath id={`${uid}-outfield`}>
            <path d="M16 28 L125 198 L234 28 L234 8 L16 8 Z" />
          </clipPath>
          <g clipPath={`url(#${uid}-outfield)`}>
            {[7, 6, 5, 4, 3, 2, 1, 0].map((ring) => (
              <ellipse
                key={ring}
                cx="125"
                cy="150"
                rx={28 + ring * 24}
                ry={16 + ring * 16}
                fill={ring % 2 === 0 ? 'var(--sports-turf-alt)' : 'var(--sports-turf)'}
              />
            ))}
          </g>
          <rect x="8" y="156" width="22" height="26" rx="2" fill="var(--sports-stadium)" opacity="0.72" />
          <rect x="220" y="156" width="22" height="26" rx="2" fill="var(--sports-stadium)" opacity="0.72" />
          <line x1="8" y1="156" x2="30" y2="156" stroke="var(--sports-chalk)" strokeWidth="1.25" opacity="0.7" />
          <line x1="220" y1="156" x2="242" y2="156" stroke="var(--sports-chalk)" strokeWidth="1.25" opacity="0.7" />
          <path d="M28 72 A118 94 0 0 1 222 72" fill="none" stroke="var(--sports-dirt)" strokeWidth="14" />
          <path d="M22 60 A126 102 0 0 1 228 60" fill="none" stroke="var(--sports-stadium)" strokeWidth="5" />
          <path d="M20 54 A130 106 0 0 1 230 54" fill="none" stroke="var(--sports-dirt-dark)" strokeWidth="2.5" />
          <g stroke="var(--sports-chalk)" strokeWidth="1.4" opacity="0.5">
            <line x1="78" y1="40" x2="74" y2="50" />
            <line x1="125" y1="32" x2="125" y2="42" />
            <line x1="172" y1="40" x2="176" y2="50" />
          </g>
          <line x1="125" y1="204" x2="22" y2="58" stroke="var(--sports-chalk)" strokeWidth="1.4" />
          <line x1="125" y1="204" x2="228" y2="58" stroke="var(--sports-chalk)" strokeWidth="1.4" />
          <line x1="22" y1="58" x2="22" y2="34" stroke="var(--sports-chalk)" strokeWidth="2" />
          <line x1="228" y1="58" x2="228" y2="34" stroke="var(--sports-chalk)" strokeWidth="2" />
          <polygon points="22,34 28,40 22,40" fill="var(--sports-chalk)" />
          <polygon points="228,34 222,40 228,40" fill="var(--sports-chalk)" />
          <ellipse cx="125" cy="158" rx="86" ry="58" fill="var(--sports-dirt)" />
          <path d="M125 204 L185 145 L125 78 L65 145 Z" fill="var(--sports-infield)" stroke="var(--sports-chalk)" strokeWidth="1.6" />
          {(['first', 'second', 'third'] as const).map((name) => {
            const point = BASE_POINTS[name];
            return <circle key={name} cx={point.x} cy={point.y} r="14" fill="var(--sports-dirt-dark)" />;
          })}
          <ellipse cx="125" cy="162" rx="18" ry="9" fill="var(--sports-dirt-dark)" />
          <rect x="120" y="160" width="10" height="2.5" rx="0.4" fill="var(--sports-chalk)" />
          <path d="M125 192 L136 200 L136 208 L114 208 L114 200 Z" fill="var(--sports-chalk)" />
          <rect x="96" y="196" width="16" height="20" fill="none" stroke="var(--sports-chalk)" strokeWidth="1" />
          <rect x="138" y="196" width="16" height="20" fill="none" stroke="var(--sports-chalk)" strokeWidth="1" />
          <rect x="112" y="210" width="26" height="12" fill="none" stroke="var(--sports-chalk)" strokeWidth="1" />
          <circle cx="48" cy="188" r="7" fill="none" stroke="var(--sports-chalk)" strokeWidth="1" />
          <circle cx="202" cy="188" r="7" fill="none" stroke="var(--sports-chalk)" strokeWidth="1" />
          {landing && control && (
            <path
              d={`M ${GAMEDAY.plateX} ${GAMEDAY.plateY} Q ${control.x} ${control.y} ${landing.x} ${landing.y}`}
              fill="none"
              stroke={`url(#${uid}-trail)`}
              strokeWidth="3.5"
              strokeLinecap="round"
            />
          )}
          {landing && (
            <>
              <circle className="pc-sports-ripple" cx={landing.x} cy={landing.y} r="7" fill="none" stroke={hitFill} strokeWidth="1.5" />
              <circle cx={landing.x} cy={landing.y} r="4.5" fill={hitFill} stroke="var(--sports-chalk)" strokeWidth="1.25" />
            </>
          )}
          {(['first', 'second', 'third'] as const).map((name) => {
            const point = BASE_POINTS[name];
            const occupied = Boolean(baseball.bases[name]);
            return (
              <g key={name}>
                <rect
                  x={point.x - 6}
                  y={point.y - 4.5}
                  width="12"
                  height="12"
                  transform={`rotate(45 ${point.x} ${point.y + 1.5})`}
                  fill="var(--sports-chain-shadow)"
                />
                <rect
                  x={point.x - 6}
                  y={point.y - 6}
                  width="12"
                  height="12"
                  transform={`rotate(45 ${point.x} ${point.y})`}
                  fill={occupied ? occupiedFill : 'var(--sports-chalk)'}
                  stroke="var(--sports-chalk)"
                  strokeWidth="1.25"
                />
              </g>
            );
          })}
        </svg>
        <div className="pc-sports-field-overlay" aria-hidden>
          {runners.map((runner) => {
            const point = fraction(runner.point);
            return (
              <div
                key={runner.id}
                className="pc-sports-runner"
                style={{ ['--nx' as string]: point.nx, ['--ny' as string]: point.ny }}
              >
                <span className="pc-sports-runner-name">
                  {runner.athlete && <AthleteMark athlete={runner.athlete} />}
                  {runner.name}
                </span>
              </div>
            );
          })}
          {landing && (
            <div
              key={hitKey}
              className="pc-sports-hitball is-animating"
              style={{
                ['--x0' as string]: plate.nx,
                ['--y0' as string]: plate.ny,
                ['--x1' as string]: mid.nx,
                ['--y1' as string]: mid.ny,
                ['--x2' as string]: end.nx,
                ['--y2' as string]: end.ny,
                ['--nx' as string]: end.nx,
                ['--ny' as string]: end.ny,
              }}
            >
              <span className="pc-sports-ball-dot" style={{ background: hitFill }} />
            </div>
          )}
        </div>
      </div>
      <ParkBug game={game} baseball={baseball} hideScores={hideScores} status={status} />
    </div>
  );
}

function ParkBug({
  game,
  baseball,
  hideScores,
  status,
}: {
  game: SportsGame;
  baseball: BaseballDetail;
  hideScores: boolean;
  status: string;
}) {
  const live = game.state === 'in';
  const score = hideScores ? null : `${game.away.abbr} ${game.away.score ?? '–'}  ${game.home.abbr} ${game.home.score ?? '–'}`;
  return (
    <div className="pc-sports-bug" aria-hidden>
      {live ? (
        <>
          <InningMark half={baseball.half} inning={baseball.inning} />
          {baseball.balls != null && <PipRow label="B" filled={baseball.balls} total={3} />}
          {baseball.strikes != null && <PipRow label="S" filled={baseball.strikes} total={2} />}
          {baseball.outs != null && <PipRow label="Out" filled={baseball.outs} total={3} square />}
          {score && <span className="pc-mono">{score}</span>}
        </>
      ) : (
        <span className="pc-mono">{score && game.state === 'post' ? `${status}  ${score}` : status}</span>
      )}
    </div>
  );
}

function InningMark({ half, inning }: { half: 'top' | 'bottom' | null; inning: number | null }) {
  if (inning == null || inning <= 0) return null;
  const down = half === 'bottom';
  return (
    <span className="pc-sports-inning">
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <polygon points={down ? '1,1 7,1 4,7' : '1,7 7,7 4,1'} fill="currentColor" />
      </svg>
      <span className="pc-mono">{inning}</span>
    </span>
  );
}

function PipRow({
  label,
  filled,
  total,
  square,
}: {
  label: string;
  filled: number;
  total: number;
  square?: boolean;
}) {
  const on = Math.max(0, Math.min(total, filled));
  return (
    <span className="pc-sports-piprow">
      <span>{label}</span>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={index < on ? 'pc-sports-pip is-on' : 'pc-sports-pip'} data-shape={square ? 'square' : 'round'} />
      ))}
    </span>
  );
}
