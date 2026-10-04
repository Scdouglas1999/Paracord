import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';

import { useDailyWordSettings } from '../../../../hooks/useDailyWord';
import { useDailyWordStore } from '../../../../stores/dailyWordStore';
import { dailyWordHref, boardName, resultPhrase, solvedCaption, timeUntil } from '../../../dailyWord/model';
import { AvatarStack } from '../../../ix/identity';
import { WidgetCard, WidgetError } from './WidgetCard';

/**
 * "Daily word": how many people here solved today's word, who, where you
 * stand, and when the next word comes. Only when the add-on is on and the
 * server shows it on the front page.
 */
export function DailyWordWidget({ guildId, nowMs }: { guildId: string; nowMs: number }) {
  const { settings, enabled } = useDailyWordSettings(guildId);
  const shown = enabled && settings?.show_on_front_page !== false;
  const today = useDailyWordStore((state) => state.today);
  const todayError = useDailyWordStore((state) => state.todayError);
  const boardEntry = useDailyWordStore((state) => state.boards[guildId]);

  useEffect(() => {
    if (!shown) return;
    void useDailyWordStore.getState().refreshToday();
    void useDailyWordStore.getState().refreshBoard(guildId);
  }, [shown, guildId]);

  const board = boardEntry?.board ?? null;
  const solvers = useMemo(
    () =>
      (board?.solvers ?? []).map((user) => ({
        userId: user.id,
        name: boardName(user),
        avatar: user.avatar_hash ?? null,
      })),
    [board],
  );

  if (!shown) return null;
  const href = dailyWordHref(guildId);
  const error = boardEntry?.error ?? todayError;
  if (error && !board) {
    return (
      <WidgetCard title="Daily word">
        <WidgetError>{error}</WidgetError>
      </WidgetCard>
    );
  }

  const status = today?.finished ? resultPhrase(today.solved, today.guesses.length) : null;
  const started = (today?.guesses.length ?? 0) > 0;
  const nextIn = today ? timeUntil(today.next_puzzle_at, nowMs) : '';

  return (
    <WidgetCard
      title="Daily word"
      action={
        today?.finished ? (
          <Link to={href} className="ix-link">
            Results
          </Link>
        ) : undefined
      }
    >
      <div className="min-w-0">
        <p className="ix-row__name">
          Today's word
          <span className="ix-wsecondary"> · {solvedCaption(board?.solved ?? 0)}</span>
        </p>
        {nextIn && <p className="ix-wsecondary">Next word in {nextIn}</p>}
      </div>
      <div className="ix-wfoot">
        {today?.finished ? (
          <span className="ix-pill" data-tone={today.solved ? 'accent' : undefined}>
            {status}
          </span>
        ) : (
          <Link
            to={href}
            aria-label={started ? `Keep playing, ${today?.guesses.length} of ${today?.max_guesses} guesses used` : undefined}
            className="ix-chip"
          >
            {started ? 'Keep playing' : 'Play'}
          </Link>
        )}
        {solvers.length > 0 && (
          <span role="img" aria-label={`Solved today's word: ${solvers.slice(0, 5).map((solver) => solver.name).join(', ')}`}>
            <AvatarStack people={solvers.slice(0, 5)} size={26} overlap={7} ring="var(--ix-main)" />
          </span>
        )}
      </div>
    </WidgetCard>
  );
}
