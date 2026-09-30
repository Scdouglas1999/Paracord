import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Poll, PollOption } from '../../types';
import { channelApi } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { toast } from '../../stores/toastStore';
import { CheckMark } from '../glass/cards/CardGlyphs';
import { PlanCard } from '../glass/cards/PlanCard';

interface PollMessageCardProps {
  channelId: string;
  poll: Poll;
  canVote: boolean;
  /** Follows a bubble of the same group, so the card's top corner joins too. */
  joinTop?: boolean;
}

/** "2h 5m left", or null when the poll has no end (that is the ordinary case: nothing to say). */
function formatExpiryLabel(expiresAt: string | null | undefined, nowMs: number): string | null {
  if (!expiresAt) return null;
  const expiresMs = new Date(expiresAt).getTime();
  const remaining = expiresMs - nowMs;
  if (remaining <= 0) return 'Ended';

  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return `${seconds}s left`;
}

/**
 * A poll, as a plan card (docs/glass-spec.md §3.2): the question is the title,
 * the line under it says how it is answered and how it is going, and each
 * option is a row you press to vote (press again to take the vote back). The
 * bar behind an option is its share of the vote; a check marks yours.
 */
export function PollMessageCard({ channelId, poll, canVote, joinTop }: PollMessageCardProps) {
  const livePoll = usePollStore((s) => s.pollsById[poll.id]) ?? poll;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);

  const orderedOptions = useMemo(
    () => [...livePoll.options].sort((a, b) => a.position - b.position),
    [livePoll.options],
  );
  const totalVotes = livePoll.total_votes;
  const isExpired = Boolean(livePoll.expires_at) && new Date(livePoll.expires_at as string).getTime() <= nowMs;

  useEffect(() => {
    if (!livePoll.expires_at) return;
    if (isExpired) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [livePoll.expires_at, isExpired]);

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

  const expiry = formatExpiryLabel(livePoll.expires_at, nowMs);
  const meta = [
    livePoll.allow_multiselect ? 'Pick any' : 'Pick one',
    `${totalVotes} vote${totalVotes === 1 ? '' : 's'}`,
    expiry && !isExpired ? expiry : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <PlanCard
      kind="Poll"
      joinTop={joinTop}
      title={livePoll.question}
      meta={meta}
      action={isExpired ? <span className="glass-plan__state">Closed</span> : undefined}
    >
      <ul className="glass-plan__options">
        {orderedOptions.map((option) => {
          const votePercent = totalVotes > 0 ? Math.round((option.vote_count / totalVotes) * 100) : 0;
          const canToggle = canVote && !isExpired;
          return (
            <li key={option.id}>
              <button
                type="button"
                className="glass-plan__option"
                data-voted={option.voted || undefined}
                aria-pressed={option.voted}
                disabled={!canToggle || pendingOptionId === option.id}
                onClick={() => void applyVoteChange(option)}
                // The share of the vote, drawn as a scale from the left edge so
                // a vote moving the bar is a composited change, not a relayout.
                style={{ '--share': votePercent / 100 } as CSSProperties}
              >
                <span className="glass-plan__option-body">
                  <span className="glass-plan__option-text">
                    {option.emoji ? `${option.emoji} ` : ''}
                    {option.text}
                  </span>
                  <span className="glass-plan__option-stat glass-instrument">{votePercent}%</span>
                  <span className="glass-plan__option-stat glass-instrument">{option.vote_count}</span>
                  {option.voted && <CheckMark />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </PlanCard>
  );
}
