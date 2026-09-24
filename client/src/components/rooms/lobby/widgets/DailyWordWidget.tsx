import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';

import { useDailyWordSettings } from '../../../../hooks/useDailyWord';
import { useCurrentAccountScope } from '../../../../hooks/useCurrentUser';
import { usePresenceStore } from '../../../../stores/presenceStore';
import type { PresenceStatus } from '../../../../lib/presence';
import { personLight } from '../../../../lib/attention/personLight';
import { useDailyWordStore } from '../../../../stores/dailyWordStore';
import { dailyWordHref, boardName, resultPhrase, solvedCaption, timeUntil } from '../../../dailyWord/model';
import { AvatarStack } from '../../../light';
import { Chip } from '../../../ui';
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
  const scope = useCurrentAccountScope();
  // One string, so the widget re-renders only when a solver's presence changes.
  const statuses = usePresenceStore((state) =>
    (board?.solvers ?? []).map((user) => state.getPresence(user.id, scope?.serverId)?.status ?? '').join(','));
  const solvers = useMemo(() => {
    const status = statuses.split(',');
    return (board?.solvers ?? []).map((user, index) =>
      personLight({
        userId: user.id,
        name: boardName(user),
        status: (status[index] || null) as PresenceStatus | null,
        avatar: user.avatar_hash,
      }));
  }, [board, statuses]);

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
          <Link to={href} className="pc-focusable -mr-1 rounded-[var(--radius-chip)] px-1 text-meta font-medium text-text-link hover:underline">
            Results
          </Link>
        ) : undefined
      }
    >
      <div className="min-w-0">
        <p className="text-label text-text-primary">
          Today's word
          <span className="text-text-muted"> · {solvedCaption(board?.solved ?? 0)}</span>
        </p>
        {nextIn && <p className="mt-0.5 text-meta text-text-muted">Next word in {nextIn}</p>}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3">
        {today?.finished ? (
          <Chip size="sm" tone={today.solved ? 'accent' : 'neutral'} className="w-fit">{status}</Chip>
        ) : (
          <Link
            to={href}
            aria-label={started ? `Keep playing, ${today?.guesses.length} of ${today?.max_guesses} guesses used` : undefined}
            className="pc-focusable pc-pressable pc-pressable-accent inline-flex h-[var(--h-control)] shrink-0 items-center whitespace-nowrap rounded-[var(--radius-control)] bg-accent-primary px-3 text-label font-semibold text-text-on-accent hover:bg-accent-primary-hover"
          >
            {started ? 'Keep playing' : 'Play'}
          </Link>
        )}
        {solvers.length > 0 && (
          <AvatarStack people={solvers} size={24} max={5} context="solved today's word" />
        )}
      </div>
    </WidgetCard>
  );
}
