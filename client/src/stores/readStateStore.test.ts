import { beforeEach, describe, expect, it } from 'vitest';
import { useReadStateStore } from './readStateStore';
import { computeGuildUnread } from '../hooks/useUnreadCounts';
import type { Channel, ReadState } from '../types';

function channel(id: string, lastMessageId: string | null, type = 0): Channel {
  return {
    id,
    type,
    last_message_id: lastMessageId,
  } as unknown as Channel;
}

function toMap(states: ReadState[]): Map<string, ReadState> {
  return new Map(states.map((rs) => [rs.channel_id, rs]));
}

describe('computeGuildUnread', () => {
  it('counts channels whose latest message is past the read cursor', () => {
    const channels = [
      channel('c1', 'm5'),
      channel('c2', 'm9'),
      channel('cat', null, 4), // category is skipped
    ];
    const readStates = toMap([
      { channel_id: 'c1', last_message_id: 'm5', mention_count: 0 }, // read
      { channel_id: 'c2', last_message_id: 'm7', mention_count: 2 }, // unread + mentions
    ]);

    expect(computeGuildUnread(channels, readStates)).toEqual({
      unreadCount: 1,
      mentionCount: 2,
    });
  });

  it('treats a channel with no read state and messages as unread', () => {
    const channels = [channel('c1', 'm1')];
    expect(computeGuildUnread(channels, new Map())).toEqual({
      unreadCount: 1,
      mentionCount: 0,
    });
  });

  it('returns null when nothing is unread and there are no mentions', () => {
    const channels = [channel('c1', 'm1')];
    const readStates = toMap([{ channel_id: 'c1', last_message_id: 'm1', mention_count: 0 }]);
    expect(computeGuildUnread(channels, readStates)).toBeNull();
  });
});

describe('readStateStore incremental updates', () => {
  beforeEach(() => {
    useReadStateStore.getState().reset();
  });

  it('markRead advances the cursor and clears mentions, flipping a channel to read', () => {
    const channels = [channel('c1', 'm9')];
    useReadStateStore.getState().setAll([
      { channel_id: 'c1', last_message_id: 'm4', mention_count: 3 },
    ]);

    // Before: behind the latest message and carrying mentions.
    let map = toMap(Object.values(useReadStateStore.getState().readStates));
    expect(computeGuildUnread(channels, map)).toEqual({ unreadCount: 1, mentionCount: 3 });

    // Reading up to the latest message clears both.
    useReadStateStore.getState().markRead('c1', 'm9');
    map = toMap(Object.values(useReadStateStore.getState().readStates));
    expect(computeGuildUnread(channels, map)).toBeNull();
  });

  it('incrementMention bumps only the targeted channel without touching the cursor', () => {
    useReadStateStore.getState().setAll([
      { channel_id: 'c1', last_message_id: 'm4', mention_count: 1 },
    ]);

    useReadStateStore.getState().incrementMention('c1');
    useReadStateStore.getState().incrementMention('c2'); // no prior state

    const states = useReadStateStore.getState().readStates;
    expect(states.c1).toEqual({ channel_id: 'c1', last_message_id: 'm4', mention_count: 2 });
    expect(states.c2).toEqual({ channel_id: 'c2', last_message_id: '', mention_count: 1 });
  });
});
