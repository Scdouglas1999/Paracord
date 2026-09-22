import { useState } from 'react';
import type { AtBat, SportsGame } from '../../api/sports';
import { Chip } from '../ui';
import { pitcherLines, pitchTypeTone, selectedPitcherId, type PitcherLine } from './timeline';
import { AthleteMark } from './TeamMark';

export function PitcherCharts({ atBats }: { atBats: AtBat[]; game?: SportsGame }) {
  const lines = pitcherLines(atBats);
  const [id, setId] = useState<string | null>(null);
  const currentId = selectedPitcherId(lines.map((line) => line.pitcher.id), id);
  const current = lines.find((line) => line.pitcher.id === currentId) ?? null;
  if (!current) return null;
  return (
    <section aria-label="Pitching" className="pc-sports-pitching flex min-w-0 flex-col gap-3">
      <h2 className="text-section text-text-faint">Pitching</h2>
      {lines.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Pitchers">
          {lines.map((line) => (
            <button
              key={line.pitcher.id}
              type="button"
              className="pc-focusable"
              aria-pressed={current.pitcher.id === line.pitcher.id}
              onClick={() => setId(line.pitcher.id)}
            >
              <Chip size="sm">{line.pitcher.short_name || line.pitcher.name}</Chip>
            </button>
          ))}
        </div>
      )}
      <PitcherCard line={current} />
    </section>
  );
}

function PitcherCard({ line }: { line: PitcherLine }) {
  const name = line.pitcher.short_name || line.pitcher.name;
  const summary = `${name}: ${line.pitches} pitches, ${line.strikePct}% strikes, ${line.whiffs} whiffs. ${line.types.map((type) => `${type.type} ${type.count} (${type.pct}%)`).join(', ')}.`;
  const speeds = line.velocities.map((tick) => tick.velocity);
  const low = speeds.length ? Math.min(...speeds) - 2 : 70;
  const high = speeds.length ? Math.max(...speeds) + 2 : 100;
  const span = Math.max(1, high - low);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <AthleteMark athlete={line.pitcher} size="lg" />
        <span className="min-w-0">
          <span className="block truncate text-label text-text-primary">{name}</span>
          {line.pitcher.position && <span className="block text-meta text-text-faint">{line.pitcher.position}</span>}
        </span>
      </div>
      <p className="pc-mono text-meta text-text-secondary">
        {line.pitches} pitches · {line.strikePct}% strikes · {line.whiffs} whiffs
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="Pitch types">
        {line.types.map((type) => (
          <li key={type.type} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2">
            <span className="truncate text-meta text-text-secondary">{type.type}</span>
            <span className="pc-sports-typebar" aria-hidden>
              <span style={{ width: `${type.pct}%`, background: pitchTypeTone(type.type) }} />
            </span>
            <span className="pc-mono text-meta text-text-faint">{type.count} · {type.pct}%</span>
          </li>
        ))}
      </ul>
      {line.velocities.length > 0 && (
        <div className="pc-sports-velo" role="img" aria-label={summary}>
          <span className="pc-sports-velo-axis" aria-hidden />
          {line.velocities.map((tick, index) => (
            <span
              key={`${tick.type}-${tick.velocity}-${index}`}
              className="pc-sports-velo-tick"
              style={{
                left: `${((tick.velocity - low) / span) * 100}%`,
                background: pitchTypeTone(tick.type),
              }}
              title={`${tick.type} ${tick.velocity} mph`}
            />
          ))}
          {line.fastest != null && (
            <span
              className="pc-sports-velo-fast pc-mono text-meta text-text-primary"
              style={{ left: `${((line.fastest - low) / span) * 100}%` }}
            >
              {line.fastest}
            </span>
          )}
        </div>
      )}
      <p className="sr-only">{summary}</p>
    </div>
  );
}
