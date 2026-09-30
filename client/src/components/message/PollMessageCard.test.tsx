import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Poll } from '../../types';
import { usePollStore } from '../../stores/pollStore';
import { PollMessageCard } from './PollMessageCard';

const api = vi.hoisted(() => ({
  getPoll: vi.fn(),
  addPollVote: vi.fn(),
  removePollVote: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../api/channels', () => ({ channelApi: api }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError } }));

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: 'p1',
    message_id: 'm1',
    channel_id: 'c1',
    question: 'Late one after the run?',
    allow_multiselect: false,
    expires_at: null,
    created_at: '2026-10-01T20:35:00Z',
    total_votes: 6,
    options: [
      { id: 'o1', text: 'Count me in', emoji: null, position: 0, vote_count: 3, voted: true },
      { id: 'o2', text: 'Maybe one round', emoji: null, position: 1, vote_count: 2, voted: false },
      { id: 'o3', text: 'Bed', emoji: null, position: 2, vote_count: 1, voted: false },
    ],
    ...over,
  } as Poll;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePollStore.setState({ pollsById: {} });
  api.getPoll.mockImplementation(async () => ({ data: usePollStore.getState().pollsById.p1 ?? poll() }));
});

describe('PollMessageCard (the plan card style)', () => {
  it('is the question as the title, how it is answered and how it is going under it', async () => {
    render(<PollMessageCard channelId="c1" poll={poll()} canVote />);
    const card = screen.getByRole('group', { name: 'Poll: Late one after the run?' });
    expect(card).toHaveTextContent('Pick one · 6 votes');
    await waitFor(() => expect(api.getPoll).toHaveBeenCalled());
  });

  it('says “Pick any” for a multiple-choice poll and counts one vote in the singular', () => {
    render(<PollMessageCard channelId="c1" poll={poll({ allow_multiselect: true, total_votes: 1 })} canVote />);
    expect(screen.getByRole('group')).toHaveTextContent('Pick any · 1 vote');
  });

  it('shows each option with its share, and yours pressed', () => {
    render(<PollMessageCard channelId="c1" poll={poll()} canVote />);
    const yours = screen.getByRole('button', { name: /Count me in/ });
    expect(yours).toHaveAttribute('aria-pressed', 'true');
    expect(yours).toHaveTextContent('50%');
    expect(yours.style.getPropertyValue('--share')).toBe('0.5');
    expect(screen.getByRole('button', { name: /Bed/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('votes for an option, and takes a vote back', async () => {
    api.addPollVote.mockResolvedValue({ data: poll({ total_votes: 7 }) });
    api.removePollVote.mockResolvedValue({ data: poll({ total_votes: 5 }) });
    render(<PollMessageCard channelId="c1" poll={poll()} canVote />);

    fireEvent.click(screen.getByRole('button', { name: /Maybe one round/ }));
    await waitFor(() => expect(api.addPollVote).toHaveBeenCalledWith('c1', 'p1', 'o2'));

    fireEvent.click(screen.getByRole('button', { name: /Count me in/ }));
    await waitFor(() => expect(api.removePollVote).toHaveBeenCalledWith('c1', 'p1', 'o1'));
  });

  it('says why when a vote is refused', async () => {
    api.addPollVote.mockRejectedValue({ response: { data: { message: 'Polls are closed here' } } });
    render(<PollMessageCard channelId="c1" poll={poll()} canVote />);
    fireEvent.click(screen.getByRole('button', { name: /Bed/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Polls are closed here'));
  });

  it('cannot be voted in without permission, or after it has closed', () => {
    const { rerender } = render(<PollMessageCard channelId="c1" poll={poll()} canVote={false} />);
    for (const option of screen.getAllByRole('button')) expect(option).toBeDisabled();
    rerender(<PollMessageCard channelId="c1" poll={poll({ expires_at: '2020-01-01T00:00:00Z' })} canVote />);
    for (const option of screen.getAllByRole('button')) expect(option).toBeDisabled();
    expect(within(screen.getByRole('group')).getByText('Closed')).toBeInTheDocument();
  });

  it('joins the top corner when it follows a bubble of its group', () => {
    render(<PollMessageCard channelId="c1" poll={poll()} canVote joinTop />);
    expect(screen.getByRole('group')).toHaveAttribute('data-join-top', 'true');
  });
});
