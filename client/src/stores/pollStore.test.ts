import { beforeEach, describe, expect, it } from 'vitest';
import type { Poll } from '../types';
import { usePollStore } from './pollStore';

function poll(votes: [number, number], voted: [boolean, boolean]): Poll {
  return {
    id: 'p1',
    message_id: 'm1',
    channel_id: 'c1',
    question: 'Which day?',
    allow_multiselect: false,
    created_at: '2026-09-23T00:00:00Z',
    total_votes: votes[0] + votes[1],
    options: [
      { id: 'o1', text: 'Thursday', position: 0, vote_count: votes[0], voted: voted[0] },
      { id: 'o2', text: 'Friday', position: 1, vote_count: votes[1], voted: voted[1] },
    ],
  } as unknown as Poll;
}

describe('pollStore vote events', () => {
  beforeEach(() => usePollStore.setState({ pollsById: {} }));

  it("takes the counts from somebody else's vote but keeps the reader's own marks", () => {
    usePollStore.getState().upsertPoll(poll([1, 0], [true, false]));
    // Mira voted Friday; the event carries Mira's marks.
    usePollStore.getState().applyVoteEvent(poll([1, 1], [false, true]), 'mira', 'jonas');
    const kept = usePollStore.getState().pollsById.p1;
    expect(kept.options.map((option) => option.vote_count)).toEqual([1, 1]);
    expect(kept.options.map((option) => option.voted)).toEqual([true, false]);
  });

  it('takes the marks too when the reader is the voter', () => {
    usePollStore.getState().upsertPoll(poll([0, 0], [false, false]));
    usePollStore.getState().applyVoteEvent(poll([0, 1], [false, true]), 'jonas', 'jonas');
    expect(usePollStore.getState().pollsById.p1.options.map((option) => option.voted)).toEqual([false, true]);
  });

  it('leaves a poll it has never seen for its card to read', () => {
    usePollStore.getState().applyVoteEvent(poll([0, 1], [false, true]), 'mira', 'jonas');
    expect(usePollStore.getState().pollsById.p1).toBeUndefined();
  });
});
