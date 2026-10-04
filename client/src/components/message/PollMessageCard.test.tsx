import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Poll } from '../../types';
import { usePollStore } from '../../stores/pollStore';
import { PollCard, PollMessageCard, pollMeta } from './PollMessageCard';

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

describe('PollMessageCard (the poll card)', () => {
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

  it('closes on time, without a clock that ticks every second', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2026-10-05T21:00:00Z'));
      render(<PollMessageCard channelId="c1" poll={poll({ expires_at: '2026-10-05T21:00:30Z' })} canVote />);
      expect(screen.getByRole('group')).toHaveTextContent('ends in 1 min');
      expect(screen.queryByText('Closed')).toBeNull();
      // Still a single timer for the close, plus the minute tick and the refresh.
      act(() => {
        vi.advanceTimersByTime(31_000);
      });
      expect(screen.getByText('Closed')).toBeInTheDocument();
      for (const option of screen.getAllByRole('button')) expect(option).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PollCard (the view)', () => {
  const NOW = new Date('2026-10-05T21:12:00Z').getTime();
  const view = (over: Partial<Poll> = {}, props: Partial<Parameters<typeof PollCard>[0]> = {}) =>
    render(<PollCard poll={poll(over)} canVote nowMs={NOW} onVote={() => {}} {...props} />);

  it('is a card of the family, named by its question, with the question as its title', () => {
    view();
    const card = screen.getByRole('group', { name: 'Poll: Late one after the run?' });
    expect(card).toHaveClass('ix-card', 'ix-poll');
    expect(card.querySelector('.ix-plan__title')).toHaveTextContent('Late one after the run?');
  });

  it('draws every option’s share as a bar of its own, a scale from the left, and says the count to assistive tech', () => {
    view();
    const options = screen.getAllByRole('button');
    const shares = options.map((option) => option.style.getPropertyValue('--share'));
    expect(shares).toEqual(['0.5', '0.33', '0.17']);
    for (const option of options) expect(option.querySelector('.ix-poll__bar')).not.toBeNull();
    expect(within(options[0]).getByText('3 votes')).toHaveClass('sr-only');
    expect(within(options[2]).getByText('1 vote')).toHaveClass('sr-only');
  });

  it('checks your vote, and leaves the others a ring to press', () => {
    view();
    const [yours, other] = screen.getAllByRole('button');
    expect(yours).toHaveAttribute('data-voted', 'true');
    expect(yours.querySelector('.ix-poll__mark svg')).not.toBeNull();
    expect(other).not.toHaveAttribute('data-voted');
    expect(other.querySelector('.ix-poll__mark svg')).toBeNull();
    expect(other).toHaveAttribute('data-votable', 'true');
  });

  it('holds a share of nothing at zero, not NaN, when nobody has voted', () => {
    view({
      total_votes: 0,
      options: [
        { id: 'o1', text: 'A', emoji: null, position: 0, vote_count: 0, voted: false },
        { id: 'o2', text: 'B', emoji: null, position: 1, vote_count: 0, voted: false },
      ],
    });
    for (const button of screen.getAllByRole('button')) {
      expect(button.style.getPropertyValue('--share')).toBe('0');
      expect(button).toHaveTextContent('0%');
    }
  });

  it('keeps the marks column only while there is a choice to make or a vote to show', () => {
    const { container, rerender } = view();
    expect(container.querySelector('.ix-poll__options')).toHaveAttribute('data-marks');
    rerender(<PollCard poll={poll({ options: poll().options.map((o) => ({ ...o, voted: false })) })} canVote={false} nowMs={NOW} onVote={() => {}} />);
    expect(container.querySelector('.ix-poll__options')).not.toHaveAttribute('data-marks');
    rerender(<PollCard poll={poll()} canVote={false} nowMs={NOW} onVote={() => {}} />);
    expect(container.querySelector('.ix-poll__options')).toHaveAttribute('data-marks');
  });

  it('puts the option it is waiting on out of reach, and hands a press to onVote', () => {
    const onVote = vi.fn();
    view({}, { onVote, pendingOptionId: 'o2' });
    expect(screen.getByRole('button', { name: /Maybe one round/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Bed/ }));
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ id: 'o3' }));
  });

  it('closes when its end has passed, whatever the clock said when it was drawn', () => {
    view({ expires_at: new Date(NOW - 1000).toISOString() });
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByRole('group')).not.toHaveTextContent('ended');
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('pollMeta', () => {
  const NOW = new Date(2026, 9, 5, 21, 12).getTime();
  it('says how it is answered, how it is going, and when it ends', () => {
    expect(pollMeta(poll({ total_votes: 12 }), NOW, false)).toBe('Pick one · 12 votes');
    expect(pollMeta(poll({ allow_multiselect: true, total_votes: 1 }), NOW, false)).toBe('Pick any · 1 vote');
    expect(pollMeta(poll({ expires_at: new Date(2026, 9, 9, 21, 0).toISOString() }), NOW, false)).toBe('Pick one · 6 votes · ends Fri');
  });

  it('says nothing about an end once it has closed (the card says Closed)', () => {
    expect(pollMeta(poll({ expires_at: new Date(2026, 9, 4, 21, 0).toISOString() }), NOW, true)).toBe('Pick one · 6 votes');
  });
});
