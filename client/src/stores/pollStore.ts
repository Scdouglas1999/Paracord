import { create } from 'zustand';
import type { Poll } from '../types';

interface PollState {
  pollsById: Record<string, Poll>;
  upsertPoll: (poll: Poll) => void;
  /**
   * A vote somebody cast, as the server announced it. The counts are for
   * everyone; the `voted` marks are the voter's own, so they only replace the
   * reader's marks when the reader is the voter.
   */
  applyVoteEvent: (poll: Poll, voterId: string | null | undefined, readerId: string | null | undefined) => void;
  clearPollsForChannel: (channelId: string) => void;
}

export const usePollStore = create<PollState>()((set) => ({
  pollsById: {},

  upsertPoll: (poll) =>
    set((state) => ({
      pollsById: {
        ...state.pollsById,
        [poll.id]: poll,
      },
    })),

  applyVoteEvent: (poll, voterId, readerId) =>
    set((state) => {
      if (voterId && readerId && voterId === readerId) {
        return { pollsById: { ...state.pollsById, [poll.id]: poll } };
      }
      const known = state.pollsById[poll.id];
      // A poll nobody here has on screen: its card reads its own copy when it
      // renders, marks and all.
      if (!known) return state;
      const mine = new Map(known.options.map((option) => [option.id, option.voted]));
      return {
        pollsById: {
          ...state.pollsById,
          [poll.id]: {
            ...poll,
            options: poll.options.map((option) => ({ ...option, voted: mine.get(option.id) ?? false })),
          },
        },
      };
    }),

  clearPollsForChannel: (channelId) =>
    set((state) => {
      const next = { ...state.pollsById };
      for (const [pollId, poll] of Object.entries(next)) {
        if (poll.channel_id === channelId) {
          delete next[pollId];
        }
      }
      return { pollsById: next };
    }),
}));
