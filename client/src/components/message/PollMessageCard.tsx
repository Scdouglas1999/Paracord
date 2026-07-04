import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Check, Clock3 } from 'lucide-react';
import type { Poll, PollOption } from '../../types';
import { channelApi } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { toast } from '../../stores/toastStore';

interface PollMessageCardProps {
  channelId: string;
  poll: Poll;
  canVote: boolean;
}

function formatExpiryLabel(expiresAt: string | null | undefined, nowMs: number): string {
  if (!expiresAt) return 'No end time';
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

export function PollMessageCard({ channelId, poll, canVote }: PollMessageCardProps) {
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
    let cancelled = false;
    const refreshPoll = async () => {
      try {
        const { data } = await channelApi.getPoll(channelId, livePoll.id);
        if (!cancelled) {
          usePollStore.getState().upsertPoll(data);
        }
      } catch {
        // Ignore transient refresh errors; vote actions still work.
      }
    };

    void refreshPoll();
    if (isExpired) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void refreshPoll();
    }, 15_000);

    return () => {
      cancelled = true;
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
    <div className="mt-2 max-w-[480px] rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <BarChart3 size={16} className="mt-0.5 shrink-0 text-accent-primary" />
          <p className="text-subhead text-text-primary">{livePoll.question}</p>
        </div>
        <span className="shrink-0 rounded-xs bg-bg-mod-strong px-2 py-0.5 text-section uppercase text-text-secondary">
          {livePoll.allow_multiselect ? 'Multi Select' : 'Single Select'}
        </span>
      </div>

      <div className="mt-3.5 flex flex-col gap-2">
        {orderedOptions.map((option) => {
          const votePercent = totalVotes > 0 ? Math.round((option.vote_count / totalVotes) * 100) : 0;
          const canToggle = canVote && !isExpired;
          return (
            <button
              key={option.id}
              type="button"
              disabled={!canToggle || pendingOptionId === option.id}
              onClick={() => void applyVoteChange(option)}
              className="relative overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-75"
            >
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-accent-tint"
                style={{ width: `${votePercent}%` }}
              />
              <span className="relative z-[1] flex items-center gap-2.5">
                <span className="min-w-0 flex-1 truncate text-label text-text-primary">
                  {option.emoji ? `${option.emoji} ` : ''}
                  {option.text}
                </span>
                <span className="text-meta font-semibold tabular-nums text-text-secondary">{votePercent}%</span>
                <span className="text-meta font-semibold tabular-nums text-text-muted">{option.vote_count}</span>
                {option.voted && (
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-tint-strong text-accent-primary">
                    <Check size={12} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2.5 text-meta text-text-muted">
        <span className="tabular-nums">{totalVotes} vote{totalVotes === 1 ? '' : 's'}</span>
        <span className="inline-flex items-center gap-1">
          <Clock3 size={12} />
          {formatExpiryLabel(livePoll.expires_at, nowMs)}
        </span>
        {isExpired ? (
          <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-section uppercase text-text-secondary">
            Closed
          </span>
        ) : (
          <span className="rounded-xs bg-success-tint px-2 py-0.5 text-section uppercase text-accent-success">
            Open
          </span>
        )}
      </div>
    </div>
  );
}
