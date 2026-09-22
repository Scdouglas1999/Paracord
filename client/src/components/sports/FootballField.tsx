import { useId } from 'react';
import type { FootballPlay, SportsTeam } from '../../api/sports';
import {
  FIELD,
  fieldPoint,
  firstDownYard,
  playStroke,
  redZoneYards,
  teamPaint,
  yardsToFieldX,
  type OffenseDirection,
  type TeamPaint,
} from './gamecast';
import { TeamMark } from './TeamMark';

const STROKE = {
  solid: undefined,
  dashed: '7 6',
  dotted: '1.5 5',
} as const;

const CHAIN_Y = 266;

function strokeColor(style: 'solid' | 'dashed' | 'dotted', paint: string): string {
  if (style === 'dotted') return 'var(--sports-first-down)';
  return paint;
}

/**
 * A football field in perspective. Home defends the left end zone.
 * The ball and the drive move only to yards the feed reported.
 * A finished game draws the drive and the ball, not a live first-down line.
 */
export function FootballField({
  yards,
  possessionTeamId,
  home,
  away,
  distance,
  redZone,
  live,
  plays,
  playIndex,
  label,
  notice,
  flat,
  bugText,
}: {
  yards: number | null;
  possessionTeamId: string | null;
  home: SportsTeam;
  away: SportsTeam;
  distance: number | null;
  redZone: boolean;
  live: boolean;
  plays: FootballPlay[];
  playIndex: number;
  label: string;
  notice: string | null;
  flat: boolean;
  bugText: string;
}) {
  const uid = useId().replace(/:/g, '');
  const homePaint = teamPaint(home, away);
  const awayPaint = teamPaint(away, home);
  const placed = yards == null
    ? null
    : fieldPoint(yards, possessionTeamId, home.id, away.id);
  const direction: OffenseDirection = placed?.direction ?? 1;
  const first = live && yards != null ? firstDownYard(yards, distance, direction) : null;
  const zone = live && redZone ? redZoneYards(direction) : null;
  const defended: TeamPaint = direction > 0 ? awayPaint : homePaint;
  const possession = possessionTeamId === away.id ? away : home;
  const shown = plays.slice(0, Math.max(0, playIndex) + 1);
  const band = yardsToFieldX(5) - yardsToFieldX(0);
  const paintFor = (teamId: string | null | undefined): TeamPaint => {
    if (teamId === away.id) return awayPaint;
    if (teamId === home.id) return homePaint;
    return { fill: 'var(--sports-chalk)', ink: 'var(--sports-chalk)' };
  };

  return (
    <div className="pc-sports-field-stage" data-flat={flat ? 'true' : 'false'}>
      <div className="pc-sports-field-plane">
        <svg
          viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
          className="block h-auto w-full"
          role="img"
          aria-label={label || 'Football field'}
        >
          <defs>
            <filter id={`${uid}-grain`} x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency="0.45" numOctaves="2" seed="4" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <linearGradient id={`${uid}-light`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--sports-chalk)" stopOpacity="0.28" />
              <stop offset="0.42" stopColor="var(--sports-chalk)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--sports-stadium)" stopOpacity="0.28" />
            </linearGradient>
            <pattern id={`${uid}-crowd`} width="16" height="10" patternUnits="userSpaceOnUse">
              <circle cx="3" cy="4" r="1.15" fill="var(--sports-chalk)" opacity="0.45" />
              <circle cx="11" cy="7" r="0.9" fill="var(--sports-chalk)" opacity="0.28" />
            </pattern>
            <linearGradient id={`${uid}-vignette`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--sports-stadium)" stopOpacity="0.45" />
              <stop offset="0.35" stopColor="var(--sports-stadium)" stopOpacity="0" />
              <stop offset="0.65" stopColor="var(--sports-stadium)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--sports-stadium)" stopOpacity="0.45" />
            </linearGradient>
          </defs>
          <rect width={FIELD.width} height={FIELD.height} fill="var(--sports-turf)" />
          {Array.from({ length: 20 }, (_, index) => (
            <rect
              key={index}
              x={yardsToFieldX(index * 5)}
              y={0}
              width={band}
              height={FIELD.height}
              fill={index % 2 === 0 ? 'var(--sports-turf-alt)' : 'var(--sports-turf)'}
            />
          ))}
          <rect width={FIELD.width} height="60" fill="var(--sports-sideline)" />
          <rect width={FIELD.width} height="28" fill="var(--sports-stadium)" />
          <rect width={FIELD.width} height="28" fill={`url(#${uid}-crowd)`} />
          <rect y={FIELD.height - 60} width={FIELD.width} height="60" fill="var(--sports-sideline)" />
          <EndZone x={0} paint={homePaint} abbr={home.abbr} vignette={`${uid}-vignette`} />
          <EndZone x={FIELD.width - FIELD.endzone} paint={awayPaint} abbr={away.abbr} vignette={`${uid}-vignette`} />
          {zone && (
            <rect
              x={yardsToFieldX(zone.from)}
              y={60}
              width={yardsToFieldX(zone.to) - yardsToFieldX(zone.from)}
              height={FIELD.height - 120}
              fill={defended.fill}
              opacity="0.34"
            />
          )}
          {Array.from({ length: 21 }, (_, step) => {
            const yard = step * 5;
            if (yard === 0 || yard === 100) return null;
            const x = yardsToFieldX(yard);
            const heavy = yard % 10 === 0;
            return (
              <g key={yard}>
                <line
                  x1={x}
                  x2={x}
                  y1={60}
                  y2={FIELD.height - 60}
                  stroke="var(--sports-chalk)"
                  strokeWidth={heavy ? 2.4 : 1}
                  opacity={heavy ? 0.95 : 0.7}
                />
                <line x1={x} x2={x} y1={214} y2={228} stroke="var(--sports-chalk)" strokeWidth="2" />
                <line x1={x} x2={x} y1={FIELD.height - 228} y2={FIELD.height - 214} stroke="var(--sports-chalk)" strokeWidth="2" />
              </g>
            );
          })}
          {[0, 100].map((yard) => {
            const x = yardsToFieldX(yard);
            return (
              <line
                key={yard}
                x1={x}
                x2={x}
                y1={8}
                y2={FIELD.height - 8}
                stroke="var(--sports-chalk)"
                strokeWidth="5"
              />
            );
          })}
          <YardNumbers />
          {shown.map((play, index) => {
            if (play.start_yard == null || play.end_yard == null) return null;
            const style = playStroke(play.type);
            const current = index === shown.length - 1;
            const paint = paintFor(play.team_id);
            const x1 = yardsToFieldX(play.start_yard);
            const x2 = yardsToFieldX(play.end_yard);
            const fade = shown.length <= 1 ? 1 : 0.28 + (0.72 * index) / (shown.length - 1);
            const lane = CHAIN_Y + (index % 2 === 0 ? -11 : 11);
            return (
              <g key={play.id} opacity={fade}>
                <line
                  x1={x1}
                  x2={x2}
                  y1={lane}
                  y2={lane}
                  stroke={paint.fill}
                  strokeWidth="16"
                  strokeLinecap="round"
                  opacity="0.35"
                />
                <line
                  x1={x1}
                  x2={x2}
                  y1={lane}
                  y2={lane}
                  stroke={strokeColor(style, paint.fill)}
                  strokeWidth={current ? 6 : 4}
                  strokeLinecap="round"
                  strokeDasharray={STROKE[style]}
                />
                <circle cx={x2} cy={lane} r={current ? 9 : 6.5} fill={paint.fill} />
                {current && (
                  <circle cx={x2} cy={lane} r="14" fill="none" stroke="var(--sports-chalk)" strokeWidth="2" />
                )}
              </g>
            );
          })}
          {live && placed && (
            <>
              <line
                x1={placed.x}
                x2={placed.x}
                y1={60}
                y2={FIELD.height - 60}
                stroke="var(--sports-chain-shadow)"
                strokeWidth="8"
              />
              <line
                x1={placed.x}
                x2={placed.x}
                y1={60}
                y2={FIELD.height - 60}
                stroke="var(--sports-los)"
                strokeWidth="3"
              />
            </>
          )}
          {live && first != null && yards != null && first !== yards && (
            <>
              <line
                x1={yardsToFieldX(first)}
                x2={yardsToFieldX(first)}
                y1={60}
                y2={FIELD.height - 60}
                stroke="var(--sports-first-down)"
                strokeWidth="8"
                opacity="0.35"
              />
              <line
                x1={yardsToFieldX(first)}
                x2={yardsToFieldX(first)}
                y1={60}
                y2={FIELD.height - 60}
                stroke="var(--sports-first-down)"
                strokeWidth="2.5"
                strokeDasharray="8 7"
              />
            </>
          )}
          <Pylons />
          <rect x="6" y="6" width={FIELD.width - 12} height={FIELD.height - 12} fill="none" stroke="var(--sports-chalk)" strokeWidth="2.5" />
          <rect width={FIELD.width} height={FIELD.height} fill={`url(#${uid}-light)`} />
          <rect width={FIELD.width} height={FIELD.height} filter={`url(#${uid}-grain)`} opacity="0.32" style={{ mixBlendMode: 'overlay' }} />
        </svg>
        <GoalPost side="left" />
        <GoalPost side="right" />
        <div className="pc-sports-field-overlay" aria-hidden>
          {placed && (
            <div
              className="pc-sports-marker"
              style={{
                ['--nx' as string]: String(placed.x / FIELD.width),
                ['--ny' as string]: String(((shown.length === 0 ? CHAIN_Y : CHAIN_Y + ((shown.length - 1) % 2 === 0 ? -11 : 11)) + 22) / FIELD.height),
              }}
            >
              <span key={placed.x} className="pc-sports-football is-pulse" />
            </div>
          )}
          {notice && placed && (
            <div
              className="pc-sports-marker"
              style={{
                ['--nx' as string]: String(placed.x / FIELD.width),
                ['--ny' as string]: '0.18',
              }}
            >
              <span className="pc-sports-runner-name">{notice}</span>
            </div>
          )}
        </div>
      </div>
      <div className="pc-sports-bug" aria-hidden>
        {live && <TeamMark team={possession} />}
        <span className="pc-mono">{bugText}</span>
      </div>
    </div>
  );
}

function EndZone({
  x,
  paint,
  abbr,
  vignette,
}: {
  x: number;
  paint: TeamPaint;
  abbr: string;
  vignette: string;
}) {
  return (
    <g>
      <rect x={x} width={FIELD.endzone} height={FIELD.height} fill="var(--sports-turf)" />
      <rect x={x} width={FIELD.endzone} height={FIELD.height} fill={paint.fill} opacity="0.78" />
      <rect x={x} width={FIELD.endzone} height={FIELD.height} fill={`url(#${vignette})`} />
      <rect x={x + 3} y="3" width={FIELD.endzone - 6} height={FIELD.height - 6} fill="none" stroke="var(--sports-chalk)" strokeWidth="1.5" />
      <text
        x={x + FIELD.endzone / 2}
        y={FIELD.height / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={paint.ink}
        fontSize="28"
        fontFamily="var(--font-display)"
        letterSpacing="1"
      >
        {abbr}
      </text>
    </g>
  );
}

/**
 * A goal post stands on the end line, so it is not part of the turf drawing:
 * it is its own element, tilted back by the plane's angle (CSS) so it rises
 * out of the field instead of lying painted on it. Uprights 18.5 ft apart,
 * crossbar 10 ft up, uprights 35 ft tall — in yards, scaled to the field.
 */
function GoalPost({ side }: { side: 'left' | 'right' }) {
  return (
    <svg
      className={`pc-sports-goalpost is-${side}`}
      viewBox="0 0 64 120"
      aria-hidden
      fill="none"
      stroke="var(--sports-chalk)"
      strokeWidth="4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M12 8 V88 H52 V8" />
      <line x1="32" y1="88" x2="32" y2="118" />
      <circle cx="32" cy="116" r="4" fill="var(--sports-pylon)" stroke="none" />
    </svg>
  );
}

function Pylons() {
  const posts = [
    [yardsToFieldX(0) + 6, 62],
    [yardsToFieldX(0) + 6, FIELD.height - 86],
    [yardsToFieldX(100) - 16, 62],
    [yardsToFieldX(100) - 16, FIELD.height - 86],
  ];
  return (
    <g>
      {posts.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="10" height="24" rx="1.5" fill="var(--sports-pylon)" stroke="var(--sports-chalk)" strokeWidth="1" />
      ))}
    </g>
  );
}

function YardNumbers() {
  return (
    <>
      {Array.from({ length: 9 }, (_, index) => {
        const yard = (index + 1) * 10;
        const x = yardsToFieldX(yard);
        const number = Math.min(yard, 100 - yard);
        const toward = yard < 50 ? -1 : yard > 50 ? 1 : 0;
        return (
          <g key={yard} fill="var(--sports-chalk)" fontSize="28" fontFamily="var(--font-display)">
            <text x={x} y={96} textAnchor="middle">{number}</text>
            {toward !== 0 && <Arrow x={x + toward * 26} y={78} dir={toward} />}
            <text x={x} y={FIELD.height - 72} textAnchor="middle">{number}</text>
            {toward !== 0 && <Arrow x={x + toward * 26} y={FIELD.height - 96} dir={toward} />}
          </g>
        );
      })}
    </>
  );
}

function Arrow({ x, y, dir }: { x: number; y: number; dir: number }) {
  const tip = x + dir * 8;
  return <polygon points={`${x},${y} ${tip},${y + 5} ${x},${y + 10}`} />;
}

export function PlayLegend({ live }: { live: boolean }) {
  return (
    <ul className="pc-sports-legend" aria-label="Play marks">
      <li><span className="pc-sports-swatch is-run" aria-hidden /> Run</li>
      <li><span className="pc-sports-swatch is-pass" aria-hidden /> Pass</li>
      <li><span className="pc-sports-swatch is-penalty" aria-hidden /> Penalty</li>
      {live && <li><span className="pc-sports-swatch is-los" aria-hidden /> Scrimmage</li>}
      {live && <li><span className="pc-sports-swatch is-first" aria-hidden /> First down</li>}
    </ul>
  );
}
