import type { FootballPlay } from '../../api/sports';
import {
  FIELD,
  fieldPoint,
  firstDownYard,
  playStroke,
  redZoneYards,
  yardsToFieldX,
  type OffenseDirection,
} from './gamecast';

const STROKE = {
  solid: undefined,
  dashed: '7 6',
  dotted: '1.5 5',
} as const;

const CHAIN_Y = 266;

function strokeColor(style: 'solid' | 'dashed' | 'dotted'): string {
  if (style === 'dotted') return 'var(--sports-first-down)';
  return 'var(--sports-chalk)';
}

/**
 * A football field in perspective. Home defends the left end zone.
 * The ball and the drive move only to yards the feed reported.
 * A finished game draws the drive and the ball, not a live first-down line.
 */
export function FootballField({
  yards,
  possessionTeamId,
  homeId,
  awayId,
  homeAbbr,
  awayAbbr,
  distance,
  redZone,
  live,
  plays,
  playIndex,
  label,
  notice,
  flat,
}: {
  yards: number | null;
  possessionTeamId: string | null;
  homeId: string;
  awayId: string;
  homeAbbr: string;
  awayAbbr: string;
  distance: number | null;
  redZone: boolean;
  live: boolean;
  plays: FootballPlay[];
  playIndex: number;
  label: string;
  notice: string | null;
  flat: boolean;
}) {
  const placed = yards == null
    ? null
    : fieldPoint(yards, possessionTeamId, homeId, awayId);
  const direction: OffenseDirection = placed?.direction ?? 1;
  const first = live && yards != null ? firstDownYard(yards, distance, direction) : null;
  const zone = live && redZone ? redZoneYards(direction) : null;
  const shown = plays.slice(0, Math.max(0, playIndex) + 1);
  const band = yardsToFieldX(10) - yardsToFieldX(0);

  return (
    <div className="pc-sports-field-stage" data-flat={flat ? 'true' : 'false'}>
      <div className="pc-sports-field-plane">
        <svg
          viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
          className="block h-auto w-full"
          role="img"
          aria-label={label || 'Football field'}
        >
          <rect width={FIELD.width} height={FIELD.height} fill="var(--sports-turf)" />
          {Array.from({ length: 10 }, (_, index) => (
            <rect
              key={index}
              x={yardsToFieldX(index * 10)}
              y={0}
              width={band}
              height={FIELD.height}
              fill={index % 2 === 0 ? 'var(--sports-turf-alt)' : 'var(--sports-turf)'}
            />
          ))}
          <rect width={FIELD.endzone} height={FIELD.height} fill="var(--sports-endzone)" />
          <rect x={FIELD.width - FIELD.endzone} width={FIELD.endzone} height={FIELD.height} fill="var(--sports-endzone)" />
          <text
            x={FIELD.endzone / 2}
            y={FIELD.height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--sports-chalk)"
            fontSize="28"
            fontFamily="var(--font-display)"
            letterSpacing="1"
          >
            {homeAbbr}
          </text>
          <text
            x={FIELD.width - FIELD.endzone / 2}
            y={FIELD.height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--sports-chalk)"
            fontSize="28"
            fontFamily="var(--font-display)"
            letterSpacing="1"
          >
            {awayAbbr}
          </text>
          {zone && (
            <rect
              x={yardsToFieldX(zone.from)}
              y={0}
              width={yardsToFieldX(zone.to) - yardsToFieldX(zone.from)}
              height={FIELD.height}
              fill="var(--sports-redzone)"
            />
          )}
          {Array.from({ length: 21 }, (_, step) => {
            const yard = step * 5;
            const x = yardsToFieldX(yard);
            return (
              <line
                key={yard}
                x1={x}
                x2={x}
                y1={16}
                y2={FIELD.height - 16}
                stroke="var(--sports-chalk)"
                strokeWidth={yard % 10 === 0 ? 3 : 1.25}
              />
            );
          })}
          {Array.from({ length: 9 }, (_, index) => {
            const yard = (index + 1) * 10;
            const x = yardsToFieldX(yard);
            const number = Math.min(yard, 100 - yard);
            return (
              <g key={yard} fill="var(--sports-chalk)" fontSize="32" fontFamily="var(--font-display)">
                <text x={x} y={86} textAnchor="middle">{number}</text>
                <text x={x} y={FIELD.height - 52} textAnchor="middle">{number}</text>
              </g>
            );
          })}
          {Array.from({ length: 99 }, (_, yard) => {
            const x = yardsToFieldX(yard + 1);
            return (
              <g key={yard} stroke="var(--sports-chalk)" strokeWidth="1.5">
                <line x1={x} x2={x} y1={176} y2={190} />
                <line x1={x} x2={x} y1={FIELD.height - 190} y2={FIELD.height - 176} />
              </g>
            );
          })}
          {shown.map((play, index) => {
            if (play.start_yard == null || play.end_yard == null) return null;
            const style = playStroke(play.type);
            const current = index === shown.length - 1;
            const x1 = yardsToFieldX(play.start_yard);
            const x2 = yardsToFieldX(play.end_yard);
            return (
              <g key={play.id}>
                <line
                  x1={x1}
                  x2={x2}
                  y1={CHAIN_Y + 5}
                  y2={CHAIN_Y + 5}
                  stroke="var(--sports-chain-shadow)"
                  strokeWidth={current ? 7 : 5}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={x1}
                  x2={x2}
                  y1={CHAIN_Y}
                  y2={CHAIN_Y}
                  stroke={strokeColor(style)}
                  strokeWidth={current ? 5.5 : 4}
                  strokeLinecap="round"
                  strokeDasharray={STROKE[style]}
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={x2}
                  cy={CHAIN_Y}
                  r={current ? 7 : 4.5}
                  fill={current ? 'var(--sports-chalk)' : 'var(--sports-lace)'}
                  stroke={current ? 'var(--sports-lace)' : 'var(--sports-chalk)'}
                  strokeWidth={current ? 2 : 1.25}
                />
              </g>
            );
          })}
          {live && placed && (
            <line
              x1={placed.x}
              x2={placed.x}
              y1={16}
              y2={FIELD.height - 16}
              stroke="var(--sports-chalk)"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {live && first != null && yards != null && first !== yards && (
            <line
              x1={yardsToFieldX(first)}
              x2={yardsToFieldX(first)}
              y1={16}
              y2={FIELD.height - 16}
              stroke="var(--sports-first-down)"
              strokeWidth="3"
              strokeDasharray="8 7"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div className="pc-sports-field-overlay" aria-hidden>
          {placed && (
            <div
              className="pc-sports-marker"
              style={{
                ['--nx' as string]: String(placed.x / FIELD.width),
                ['--ny' as string]: String((CHAIN_Y + 22) / FIELD.height),
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
    </div>
  );
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
