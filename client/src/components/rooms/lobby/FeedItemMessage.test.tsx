import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { FeedMessageItem } from '../../../api/serverFeed';
import { FeedItemMessage } from './FeedItemMessage';

function forwardedItem(): FeedMessageItem {
  return {
    id: 'm:m1',
    key: 'm:m1',
    type: 'message',
    at: '2026-09-23T14:40:00Z',
    channel_id: 'c1',
    channel_name: 'engineering',
    reason: 'attachment',
    message: {
      id: 'm1',
      channel_id: 'c1',
      author: { id: 'u1', username: 'jonas', discriminator: '0', display_name: 'Jonas Weber' },
      content: 'look at this',
      tts: false,
      mention_everyone: false,
      pinned: false,
      type: 0,
      attachments: [],
      reactions: [],
      created_at: '2026-09-23T14:40:00Z',
      forwarded_from: {
        channel_id: 'c2',
        message_id: 'm0',
        guild_id: 'g1',
        author_id: 'u2',
        author_name: 'Ken Nakamura',
        sent_at: '2026-09-23T14:26:00Z',
        channel_name: 'showcase',
        content: 'the original words',
      },
    },
  } as FeedMessageItem;
}

describe('FeedItemMessage', () => {
  it('says where a forwarded post came from and quotes it, like the channel does', () => {
    render(
      <MemoryRouter>
        <FeedItemMessage
          item={forwardedItem()}
          guildId="g1"
          when="now"
          mentionNames={new Map()}
          onOpen={vi.fn()}
          onToggleReaction={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Forwarded from #showcase/)).toBeInTheDocument();
    expect(screen.getByText('the original words')).toBeInTheDocument();
    expect(screen.getByText('look at this')).toBeInTheDocument();
  });

  it('shows a feed post as the feed with its card, tagged Feed', () => {
    const item = {
      id: 'm:m2',
      key: 'm:m2',
      type: 'message',
      at: '2026-09-23T14:40:00Z',
      channel_id: 'c1',
      channel_name: 'news',
      reason: 'feed',
      message: {
        id: 'm2',
        channel_id: 'c1',
        author: { id: 'f1', username: 'Lantern Journal', discriminator: '0', bot: true },
        content: 'Hello again',
        tts: false,
        mention_everyone: false,
        pinned: false,
        type: 0,
        attachments: [],
        reactions: [],
        created_at: '2026-09-23T14:40:00Z',
        feed: { id: 'f1', kind: 'rss', name: 'Lantern Journal', icon_url: null },
        embeds: [{
          type: 'rich',
          url: 'https://blog.example/hello',
          title: 'Hello again',
          description: 'A short summary.',
          site_name: 'Lantern Journal',
          feed: { kind: 'rss' },
        }],
      },
    } as FeedMessageItem;
    render(
      <MemoryRouter>
        <FeedItemMessage item={item} guildId="g1" when="now" mentionNames={new Map()} onOpen={vi.fn()} onToggleReaction={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Hello again' })).toHaveAttribute('href', 'https://blog.example/hello');
    expect(screen.getByText('A short summary.')).toBeInTheDocument();
    expect(screen.getByText('Feed')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Lantern Journal in news' })).toBeInTheDocument();
  });

  it('folds a run from one feed under its newest card, three listed and the rest behind a count', async () => {
    const onOpenMessage = vi.fn();
    const others = [1, 2, 3, 4, 5].map((n) => ({
      message_id: `m${10 - n}`,
      channel_id: 'c1',
      channel_name: 'news',
      title: `Older post ${n}`,
      at: new Date(Date.parse('2026-09-24T12:00:00Z') - n * 3600_000).toISOString(),
    }));
    const item = {
      id: 'm:m10',
      key: 'm5',
      type: 'message',
      at: '2026-09-24T12:00:00Z',
      channel_id: 'c1',
      channel_name: 'news',
      reason: 'feed',
      message: {
        id: 'm10',
        channel_id: 'c1',
        author: { id: 'f1', username: 'Lantern Journal', discriminator: '0', bot: true },
        content: 'Newest post',
        tts: false,
        mention_everyone: false,
        pinned: false,
        type: 0,
        attachments: [],
        reactions: [],
        created_at: '2026-09-24T12:00:00Z',
        feed: { id: 'f1', kind: 'rss', name: 'Lantern Journal', icon_url: null },
        embeds: [{ type: 'rich', url: 'https://blog.example/new', title: 'Newest post', feed: { kind: 'rss' } }],
      },
      feed_group: { feed_id: 'f1', name: 'Lantern Journal', items: others },
    } as FeedMessageItem;
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FeedItemMessage
          item={item}
          guildId="g1"
          when="now"
          mentionNames={new Map()}
          onOpen={vi.fn()}
          onToggleReaction={vi.fn()}
          nowMs={Date.parse('2026-09-24T12:00:00Z')}
          onOpenMessage={onOpenMessage}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Newest post' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'More from Lantern Journal' });
    expect(within(list).getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Older post 11h',
      'Older post 22h',
      'Older post 33h',
    ]);
    await user.click(within(list).getByRole('button', { name: /Older post 2/ }));
    expect(onOpenMessage).toHaveBeenCalledWith('c1', 'm8');
    await user.click(screen.getByRole('button', { name: '2 more from Lantern Journal' }));
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });
});
