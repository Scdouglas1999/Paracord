import type { DailyWordBoard } from '../../api/dailyWord';
import { FeedAvatar } from '../rooms/lobby/feedParts';
import { boardName, resultPhrase } from './model';

/**
 * Today on this server. Before you finish it only counts people; once you have
 * finished it lists everyone who played, with their grid of colors (never letters).
 */
export function ServerWordBoard({
  board,
  error,
  serverName,
}: {
  board: DailyWordBoard | null;
  error: string | null;
  serverName: string;
}) {
  const title = serverName ? `Today on ${serverName}` : 'Today on this server';
  if (!board) {
    return (
      <section aria-label={title} className="flex flex-col gap-2">
        <h3 className="text-label font-semibold text-text-secondary">{title}</h3>
        <p className={error ? 'text-meta text-accent-danger' : 'text-meta text-text-muted'} role={error ? 'alert' : undefined}>
          {error ?? 'Loading…'}
        </p>
      </section>
    );
  }
  const summary = board.played === 0
    ? 'No one has played yet.'
    : `${board.played} played · ${board.solved} solved`;
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-label font-semibold text-text-secondary">{title}</h3>
        <span className="shrink-0 text-meta tabular-nums text-text-muted">{summary}</span>
      </div>
      {error && <p role="alert" className="text-meta text-accent-danger">{error}</p>}
      {!board.visible ? (
        <p className="text-meta text-text-muted">Finish today's word to see how everyone did.</p>
      ) : board.entries.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {board.entries.map((entry) => (
            <li key={entry.user.id} className="flex min-w-0 items-center gap-2.5">
              <FeedAvatar user={entry.user} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label text-text-primary">{boardName(entry.user)}</span>
                <span className="block text-meta text-text-muted">
                  {entry.finished ? resultPhrase(entry.solved, entry.guess_count) : 'Still playing'}
                </span>
              </span>
              {entry.grid.length > 0 && (
                <span className="pc-word-mini shrink-0" aria-hidden>
                  {entry.grid.flatMap((row, rowIndex) =>
                    row.map((state, index) => <span key={`${rowIndex}-${index}`} data-state={state} />),
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
