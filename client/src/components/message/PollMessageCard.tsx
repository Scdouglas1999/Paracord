import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Poll, PollOption } from '../../types';
import { channelApi } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { toast } from '../../stores/toastStore';
import { endsWhen } from '../glass/cards/eventTime';
import { PlanCard } from '../glass/cards/PlanCard';
import { IxGlyph } from '../ix/glyphs/IxGlyph';

interface PollMessageCardProps {
  channelId: string;
  poll: Poll;
  canVote: boolean;
  /** Follows a bubble of the same group; kept as a hook for the timeline (`data-join-top`). */
  joinTop?: boolean;
}

/** Longest a single timer waits (a browser clamps near 2^31 ms): a poll further out is re-checked each minute. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

export interface PollCardProps {
  poll: Poll;
  /** The reader may vote (a permission; not whether the poll is still open). */
  canVote: boolean;
  /** Now, for "ends Fri" and whether it has closed. */
  nowMs: number;
  /** The option whose vote is on its way. */
  pendingOptionId?: string | null;
  onVote: (option: PollOption) => void;
  joinTop?: boolean;
}

/** "Pick one · 12 votes · ends Fri". */
export function pollMeta(poll: Poll, nowMs: number, closed: boolean): string {
  return [
    poll.allow_multiselect ? 'Pick any' : 'Pick one',
    `${poll.total_votes} vote${poll.total_votes === 1 ? '' : 's'}`,
    closed ? null : endsWhen(poll.expires_at ? new Date(poll.expires_at) : null, nowMs),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A poll (docs/index-spec.md §4.11): the question as the card's title, how it is
 * answered and how it is going under it, and each option a row you press to vote
 * (press again to take the vote back; the poll API votes per option, at once).
 * The bar behind an option is its share, drawn as a `scaleX` from the left edge
 * so a vote moving it is a composited change, not a relayout; your vote is
 * checked.
 *
 * This is the view: it holds no state and calls no API, so every state can be
 * drawn from data. `PollMessageCard` is the card with the poll store behind it.
 */
export function PollCard({ poll, canVote, nowMs, pendingOptionId, onVote, joinTop }: PollCardProps) {
  const orderedOptions = useMemo(() => [...poll.options].sort((a, b) => a.position - b.position), [poll.options]);
  const closed = Boolean(poll.expires_at) && new Date(poll.expires_at as string).getTime() <= nowMs;
  const canToggle = canVote && !closed;
  const total = poll.total_votes;

  return (
    <PlanCard
      kind="Poll"
      joinTop={joinTop}
      className="ix-poll"
      title={poll.question}
      meta={pollMeta(poll, nowMs, closed)}
      action={closed ? <span className="ix-poll__state">Closed</span> : undefined}
    >
      {/* The choice marks take a column while there is a choice to make or a vote to show, so the words line up. */}
      <ul className="ix-poll__options" data-marks={canToggle || orderedOptions.some((o) => o.voted) || undefined}>
        {orderedOptions.map((option) => {
          const percent = total > 0 ? Math.round((option.vote_count / total) * 100) : 0;
          return (
            <li key={option.id}>
              <button
                type="button"
                className="ix-poll__option"
                data-voted={option.voted || undefined}
                data-votable={canToggle || undefined}
                aria-pressed={option.voted}
                disabled={!canToggle || pendingOptionId === option.id}
                onClick={() => onVote(option)}
                // The share of the vote, as a scale from the left edge.
                style={{ '--share': percent / 100 } as CSSProperties}
              >
                <span className="ix-poll__bar" aria-hidden />
                <span className="ix-poll__body">
                  <span className="ix-poll__mark" aria-hidden>
                    {option.voted && <IxGlyph name="check" size={12} />}
                  </span>
                  <span className="ix-poll__text">
                    {option.emoji ? `${option.emoji} ` : ''}
                    {option.text}
                  </span>
                  <span className="ix-poll__stat">{percent}%</span>
                  <span className="sr-only">{`${option.vote_count} vote${option.vote_count === 1 ? '' : 's'}`}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </PlanCard>
  );
}

/** A poll in the timeline: the poll store behind `PollCard`, kept fresh while it is open. */
export function PollMessageCard({ channelId, poll, canVote, joinTop }: PollMessageCardProps) {
  const livePoll = usePollStore((s) => s.pollsById[poll.id]) ?? poll;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);

  const expiresMs = livePoll.expires_at ? new Date(livePoll.expires_at).getTime() : null;
  const isExpired = expiresMs !== null && expiresMs <= nowMs;

  // One timer to the moment it closes (so the card closes on time), and one
  // tick a minute for "ends in 12 min": a poll does not need a clock a second.
  useEffect(() => {
    if (expiresMs === null || isExpired) return;
    const toClose = window.setTimeout(() => setNowMs(Date.now()), Math.min(Math.max(expiresMs - Date.now(), 0) + 50, MAX_TIMER_MS));
    const tick = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      window.clearTimeout(toClose);
      window.clearInterval(tick);
    };
  }, [expiresMs, isExpired]);

  useEffect(() => {
    let canceled = false;
    const refreshPoll = async () => {
      try {
        const { data } = await channelApi.getPoll(channelId, livePoll.id);
        if (!canceled) {
          usePollStore.getState().upsertPoll(data);
        }
      } catch {
        // Ignore transient refresh errors; vote actions still work.
      }
    };

    void refreshPoll();
    if (isExpired) {
      return () => {
        canceled = true;
      };
    }

    const interval = window.setInterval(() => {
      void refreshPoll();
    }, 15_000);

    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, [channelId, livePoll.id, isExpired]);

  const applyVoteChange = async (option: PollOption) => {
    if (!canVote || isExpired || pendingOptionId) return;
    setPendingOptionId(option.id);
    try {
      const response = option.voted
        ? await channelApi.removePollVote(channelId, livePoll.id, option.id)
        : await channelApi.addPollVote(channelId, livePoll.id, option.id);
      usePollStore.getState().upsertPoll(response.data);
    } catch (err) {
      const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
      toast.error(responseData?.message || responseData?.error || 'Failed to update poll vote.');
    } finally {
      setPendingOptionId(null);
    }
  };

  return (
    <PollCard
      poll={livePoll}
      canVote={canVote}
      nowMs={nowMs}
      pendingOptionId={pendingOptionId}
      onVote={(option) => void applyVoteChange(option)}
      joinTop={joinTop}
    />
  );
}
