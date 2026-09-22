import { describe, expect, it } from 'vitest';

import type { FeedItem, FeedMessageItem } from '../../../api/serverFeed';
import { applyReaction, mergeFeedPage } from './useServerFeed';

function message(id: string, reactions: { emoji: string; count: number; me: boolean }[] = []): FeedMessageItem {
  return {
    type: 'message',
    id: `m:${id}`,
    key: id,
    at: '2026-09-22T18:00:00Z',
    channel_id: 'c',
    channel_name: 'general',
    reason: 'reactions',
    message: { id, channel_id: 'c', reactions } as unknown as FeedMessageItem['message'],
  };
}

describe('mergeFeedPage', () => {
  it('appends a page without repeating what is already there', () => {
    const merged = mergeFeedPage([message('3'), message('2')], [message('2'), message('1')] as FeedItem[]);
    expect(merged.map((item) => item.id)).toEqual(['m:3', 'm:2', 'm:1']);
  });
});

describe('applyReaction', () => {
  it('adds your reaction to a tally, or starts one', () => {
    const item = message('1', [{ emoji: '🎉', count: 2, me: false }]);
    expect(applyReaction(item, '🎉', true).message.reactions).toEqual([{ emoji: '🎉', count: 3, me: true }]);
    expect(applyReaction(item, '👍', true).message.reactions).toEqual([
      { emoji: '🎉', count: 2, me: false },
      { emoji: '👍', count: 1, me: true },
    ]);
  });

  it('takes yours away, and the chip with it when it was the last', () => {
    const item = message('1', [
      { emoji: '🎉', count: 3, me: true },
      { emoji: '👍', count: 1, me: true },
    ]);
    const after = applyReaction(applyReaction(item, '🎉', false), '👍', false);
    expect(after.message.reactions).toEqual([{ emoji: '🎉', count: 2, me: false }]);
  });

  it('does not count twice', () => {
    const item = message('1', [{ emoji: '🎉', count: 3, me: true }]);
    expect(applyReaction(item, '🎉', true).message.reactions).toEqual([{ emoji: '🎉', count: 3, me: true }]);
  });
});
