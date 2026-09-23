import { render, screen } from '@testing-library/react';
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
});
