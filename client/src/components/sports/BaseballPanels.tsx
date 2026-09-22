import { useEffect, useRef, useState } from 'react';
import type { AtBat, BaseballDetail, Pitch, PitchResult, SportsGame } from '../../api/sports';
import { AthleteMark } from './TeamMark';
import {
  BASE_POINTS,
  GAMEDAY,
  ZONE_VIEW,
  baseballFieldLabel,
  baseballScorebug,
  diffRunners,
  hitArcControl,
  hitToField,
  pitchFrame,
  pitchInFrame,
  pitchResultLabel,
  strikeZoneOrDefault,
  type RunnerChange,
} from './gamecast';

const RESULTS: PitchResult[] = ['ball', 'strike-looking', 'strike-swinging', 'foul', 'in-play'];

function pitchColor(result: string | null | undefined): string {
  switch (result) {
    case 'ball': return 'var(--sports-pitch-ball)';
    case 'strike-looking': return 'var(--sports-pitch-looking)';
    case 'strike-swinging': return 'var(--sports-pitch-swinging)';
    case 'foul': return 'var(--sports-pitch-foul)';
    case 'in-play': return 'var(--sports-pitch-inplay)';
    default: return 'var(--sports-pitch-other)';
  }
}

/** Filled marks. Shape carries the result; the colour is a second cue. */
function PitchShape({ result }: { result: string | null | undefined }) {
  const color = pitchColor(result);
  if (result === 'strike-looking') {
    return <rect x="-6" y="-6" width="12" height="12" rx="1.5" fill={color} />;
  }
  if (result === 'strike-swinging') {
    return <polygon points="0,-7.5 7,6.5 -7,6.5" fill={color} />;
  }
  if (result === 'foul') {
    return <rect x="-5.5" y="-5.5" width="11" height="11" rx="1" fill={color} transform="rotate(45)" />;
  }
  if (result === 'in-play') {
    return <circle r="6.5" fill={color} />;
  }
  if (result === 'ball') {
    return <circle r="6.5" fill={color} />;
  }
  return <circle r="4" fill={color} />;
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
}: {
  baseball: BaseballDetail;
  game: SportsGame;
  selectedId: string | null;
  onSelect: (id: string) => void;
  flat: boolean;
}) {
  const atBats = baseball.at_bats ?? [];
  const selected = atBats.find((atBat) => atBat.id === selectedId) ?? atBats[atBats.length - 1] ?? null;
  const pitches = (selected?.pitches ?? []).filter((pitch) => pitch.x != null && pitch.y != null);
  const newest = pitches[pitches.length - 1];
  const zone = strikeZoneOrDefault(baseball.strike_zone);
  const frame = pitchFrame(zone);
  const origin = pitchInFrame(zone.left, zone.top, frame);
  const far = pitchInFrame(zone.right, zone.bottom, frame);
  const zoneRect = {
    x: origin.x,
    y: origin.y,
    width: Math.max(0, far.x - origin.x),
    height: Math.max(0, far.y - origin.y),
  };
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
                zoneRect={zoneRect}
                frame={frame}
                bats={baseball.bats}
                label={pitches.length > 0 ? `${pitches.length} pitches from the catcher` : 'Strike zone from the catcher'}
              />
              {bats && <p className="text-meta text-text-muted">{bats}</p>}
            </div>
            <ol className="pc-sports-pitch-list" aria-label="Pitches">
              {pitches.map((pitch) => (
                <li key={pitch.n} className={String(pitch.n) === String(newest?.n) ? 'is-fresh' : undefined}>
                  <span className="pc-mono text-text-faint">{pitch.n}</span>
                  <span className="min-w-0 truncate">{pitch.type || pitch.type_abbr || 'Pitch'}</span>
                  <span className="pc-mono">{pitch.velocity != null ? `${Math.round(pitch.velocity)} mph` : ''}</span>
                  <span>{pitchResultLabel(pitch.result)}</span>
                </li>
              ))}
            </ol>
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
          hit={selected?.hit ?? null}
          hitKey={selected?.id ?? ''}
          label={label}
          flat={flat}
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

function StrikeZone({
  pitches,
  newestId,
  zoneRect,
  frame,
  bats,
  label,
}: {
  pitches: Pitch[];
  newestId: string | null;
  zoneRect: { x: number; y: number; width: number; height: number };
  frame: { minX: number; maxX: number; minY: number; maxY: number };
  bats: 'L' | 'R' | 'S' | null;
  label: string;
}) {
  const batterX = bats === 'L' ? ZONE_VIEW.width - 16 : 16;
  const batterY = zoneRect.y + zoneRect.height * 0.15;
  const plateCx = zoneRect.x + zoneRect.width / 2;
  const plateTop = zoneRect.y + zoneRect.height + 14;
  return (
    <svg viewBox={`0 0 ${ZONE_VIEW.width} ${ZONE_VIEW.height}`} className="block h-full w-full" role="img" aria-label={label}>
      <rect width={ZONE_VIEW.width} height={ZONE_VIEW.height} fill="var(--bg-raised)" rx="8" />
      <g fill="var(--text-faint)" stroke="var(--text-faint)" strokeWidth="1.6" strokeLinecap="round">
        <circle cx={batterX} cy={batterY + 6} r="6" fill="var(--text-faint)" stroke="none" />
        <path d={`M${batterX} ${batterY + 12} L${batterX} ${batterY + 32} M${batterX} ${batterY + 16} L${batterX - 10} ${batterY + 26} M${batterX} ${batterY + 16} L${batterX + 10} ${batterY + 24} M${batterX} ${batterY + 32} L${batterX - 6} ${batterY + 50} M${batterX} ${batterY + 32} L${batterX + 7} ${batterY + 50}`} fill="none" />
      </g>
      <rect
        x={zoneRect.x}
        y={zoneRect.y}
        width={zoneRect.width}
        height={zoneRect.height}
        fill="none"
        stroke="var(--sports-chalk)"
        strokeWidth="2"
      />
      {[1, 2].map((step) => (
        <g key={step} stroke="var(--sports-chalk)" strokeWidth="1" opacity="0.45">
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
      <path
        d={`M${plateCx - 12} ${plateTop} L${plateCx + 12} ${plateTop} L${plateCx + 12} ${plateTop + 8} L${plateCx} ${plateTop + 18} L${plateCx - 12} ${plateTop + 8} Z`}
        fill="var(--sports-chalk)"
      />
      {pitches.map((pitch) => {
        const point = pitchInFrame(pitch.x ?? 0, pitch.y ?? 0, frame);
        const fresh = String(pitch.n) === newestId;
        return (
          <g key={pitch.n} transform={`translate(${point.x} ${point.y})`}>
            <g className={fresh ? 'pc-sports-pitch-in' : undefined}>
              <PitchShape result={pitch.result} />
              {fresh && <circle r="10" fill="none" stroke="var(--sports-chalk)" strokeWidth="1.5" />}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--sports-pitch-ink)"
                fontSize="8"
                fontFamily="var(--font-display)"
              >
                {pitch.n}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

function Diamond({
  baseball,
  hit,
  hitKey,
  label,
  flat,
}: {
  baseball: BaseballDetail;
  hit: { x: number; y: number; trajectory: string | null } | null;
  hitKey: string;
  label: string;
  flat: boolean;
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

  const runners: { id: string; name: string; point: { x: number; y: number } }[] = (['first', 'second', 'third'] as const).flatMap((name) => {
    const athlete = baseball.bases[name];
    if (!athlete) return [];
    return [{ id: athlete.id, name: athlete.short_name || athlete.name || 'Runner', point: BASE_POINTS[name] }];
  });
  for (const ghost of ghosts) {
    if (runners.some((runner) => runner.id === ghost.id)) continue;
    runners.push({ id: ghost.id, name: ghost.shortName, point: BASE_POINTS.home });
  }

  return (
    <div className={flat ? 'pc-sports-field-stage is-ballpark' : 'pc-sports-field-stage is-ballpark'} data-flat={flat ? 'true' : 'false'}>
      <div className="pc-sports-field-plane">
        <svg viewBox={`0 0 ${GAMEDAY.size} ${GAMEDAY.size}`} className="block h-auto w-full" role="img" aria-label={label}>
          <rect width={GAMEDAY.size} height={GAMEDAY.size} fill="var(--sports-turf)" />
          <path d="M 8 122 A 148 118 0 0 1 242 122" fill="none" stroke="var(--sports-dirt)" strokeWidth="16" />
          <path d="M 6 112 A 158 126 0 0 1 244 112" fill="none" stroke="var(--sports-chalk)" strokeWidth="1.5" />
          <line x1="125" y1="208" x2="14" y2="30" stroke="var(--sports-chalk)" strokeWidth="1.5" />
          <line x1="125" y1="208" x2="236" y2="30" stroke="var(--sports-chalk)" strokeWidth="1.5" />
          <path d="M125 222 L214 142 L125 50 L36 142 Z" fill="var(--sports-dirt)" />
          <path d="M125 204 L185 145 L125 78 L65 145 Z" fill="var(--sports-infield)" stroke="var(--sports-chalk)" strokeWidth="1.75" />
          <circle cx="125" cy="150" r="12" fill="var(--sports-dirt-dark)" />
          <rect x="123" y="146" width="4" height="2" fill="var(--sports-chalk)" />
          <path d="M117 200 L133 200 L133 208 L125 216 L117 208 Z" fill="var(--sports-chalk)" />
          {landing && control && (
            <path
              d={`M ${GAMEDAY.plateX} ${GAMEDAY.plateY} Q ${control.x} ${control.y} ${landing.x} ${landing.y}`}
              fill="none"
              stroke="var(--sports-chalk)"
              strokeWidth="1.75"
              strokeDasharray="3 4"
            />
          )}
          {landing && <circle cx={landing.x} cy={landing.y} r="4.5" fill="var(--sports-chalk)" stroke="var(--sports-lace)" strokeWidth="1.5" />}
          {(['first', 'second', 'third', 'home'] as const).map((name) => {
            const point = BASE_POINTS[name];
            const occupied = name !== 'home' && Boolean(baseball.bases[name]);
            return (
              <rect
                key={name}
                x={point.x - 8}
                y={point.y - 8}
                width="16"
                height="16"
                transform={`rotate(45 ${point.x} ${point.y})`}
                fill={occupied ? 'var(--accent-primary)' : 'var(--sports-chalk)'}
                stroke="var(--sports-chalk)"
                strokeWidth="1.5"
              />
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
                <span className="pc-sports-runner-name">{runner.name}</span>
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
              <span className="pc-sports-ball-dot" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
