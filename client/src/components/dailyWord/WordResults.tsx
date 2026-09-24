import type { CSSProperties } from 'react';
import type { DailyWordStats, DailyWordToday } from '../../api/dailyWord';
import { MAX_GUESSES, resultPhrase } from './model';

/** What you got today: solved or missed, the word, and its definition when the list has one. */
export function WordResult({ today }: { today: DailyWordToday }) {
  const answer = today.answer ?? '';
  return (
    <section aria-label="Your result" className="flex min-w-0 flex-col gap-2">
      <p className="text-label font-semibold text-text-secondary">
        {resultPhrase(today.solved, today.guesses.length)}
      </p>
      <p className="font-display text-heading uppercase tracking-[0.12em] text-text-primary">{answer}</p>
      {today.definition ? (
        <p className="text-body text-text-secondary">
          <span className="italic text-text-muted">{today.definition.part_of_speech}</span>
          {' · '}
          {today.definition.text}
        </p>
      ) : null}
    </section>
  );
}

/** Played, solved share, current and best streak. */
export function WordStats({ stats }: { stats: DailyWordStats }) {
  const winRate = stats.played > 0 ? Math.round((stats.solved / stats.played) * 100) : 0;
  const tiles: { label: string; value: string }[] = [
    { label: 'Played', value: String(stats.played) },
    { label: 'Solved', value: `${winRate}%` },
    { label: 'Streak', value: String(stats.current_streak) },
    { label: 'Best streak', value: String(stats.max_streak) },
  ];
  return (
    <dl className="grid grid-cols-4 gap-2" aria-label="Your stats">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex min-w-0 flex-col items-center gap-0.5 rounded-[var(--radius-card)] bg-bg-mod-subtle px-1 py-2.5 text-center">
          <dd className="font-display text-title font-semibold tabular-nums text-text-primary">{tile.value}</dd>
          <dt className="text-meta text-text-muted">{tile.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** How many days you solved in one guess, two, … six. Today's bar is marked. */
export function WordDistribution({ stats, today }: { stats: DailyWordStats; today: number | null }) {
  const counts = Array.from({ length: MAX_GUESSES }, (_, index) => stats.distribution[index] ?? 0);
  const max = Math.max(1, ...counts);
  return (
    <section aria-label="Guess distribution" className="flex flex-col gap-1.5">
      <h3 className="text-label font-semibold text-text-secondary">Guess distribution</h3>
      <ol className="flex flex-col gap-1">
        {counts.map((count, index) => {
          const guesses = index + 1;
          const isToday = today === guesses;
          const width = `${Math.max(8, Math.round((count / max) * 100))}%`;
          return (
            <li key={guesses} className="flex items-center gap-2">
              <span className="w-3 shrink-0 text-right text-meta tabular-nums text-text-muted">{guesses}</span>
              <span className="min-w-0 flex-1">
                <span
                  className="pc-word-bar flex items-center justify-end px-2 text-meta font-semibold tabular-nums"
                  data-today={isToday ? 'true' : undefined}
                  style={{ width } as CSSProperties}
                  aria-label={`${count} ${count === 1 ? 'day' : 'days'} in ${guesses}${isToday ? ', today' : ''}`}
                >
                  {count}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
