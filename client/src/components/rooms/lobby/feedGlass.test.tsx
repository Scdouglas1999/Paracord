import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { FeedForumPostItem, FeedMembersJoinedItem, FeedUser } from '../../../api/serverFeed';
import type { Attachment } from '../../../types';
import { FeedCardHeader, FeedAvatar, FileChips, PhotoGrid, ReasonTag } from './feedParts';
import { FeedItemForumPost } from './FeedItemForumPost';
import { FeedItemMembersJoined } from './FeedItemMembersJoined';

// A face draws its picture from an authenticated URL; the ticket is not this suite's business.
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const user = (id: string, name: string): FeedUser => ({ id, username: name.toLowerCase(), display_name: name, avatar_hash: null });
const NOW = Date.parse('2026-10-01T21:12:00Z');

describe('a feed post header', () => {
  it('names who and where, opens the channel from where, and writes no #', async () => {
    const onOpen = vi.fn();
    render(
      <FeedCardHeader
        lead={<FeedAvatar user={user('1', 'Nick')} size={32} />}
        name="Nick"
        channelName="Clips"
        when="6m"
        onOpen={onOpen}
        aside={<ReasonTag reason="poll" />}
      />,
    );
    const where = screen.getByRole('button', { name: 'Open in Clips' });
    expect(where).toHaveTextContent('Clips');
    expect(where).toHaveTextContent('6m');
    expect(where.textContent).not.toContain('#');
    expect(screen.getByText('Poll')).toHaveClass('glass-post__tag');
    await userEvent.click(where);
    expect(onOpen).toHaveBeenCalled();
  });

  it('says nothing for a reason a picture already gives', () => {
    const { container } = render(<ReasonTag reason="attachment" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('pictures and files in a post', () => {
  const image = (id: string): Attachment =>
    ({ id, filename: `${id}.png`, content_type: 'image/png', size: 10, url: `/api/v1/attachments/${id}` }) as Attachment;

  it('lays out several pictures in two columns and counts the rest', () => {
    const { container } = render(<PhotoGrid images={['1', '2', '3', '4', '5', '6'].map(image)} />);
    expect(container.querySelector('.glass-photogrid')).not.toBeNull();
    expect(container.querySelectorAll('.glass-photo')).toHaveLength(4);
    expect(container.querySelector('.glass-photo__more')).toHaveTextContent('+2');
  });

  it('gives a single picture the full width', () => {
    const { container } = render(<PhotoGrid images={[image('1')]} />);
    expect(container.querySelector('.glass-photogrid')).toBeNull();
    expect(container.querySelector('.glass-photo')).not.toBeNull();
  });

  it('draws a file as a named solid chip that opens the message', async () => {
    const onOpen = vi.fn();
    render(<FileChips files={[{ id: 'f', filename: 'notes.pdf' } as Attachment]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'notes.pdf. Open the message' }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('a forum post in the feed', () => {
  const item: FeedForumPostItem = {
    type: 'forum_post',
    id: 'f:1',
    key: '1',
    at: '2026-10-01T20:31:00Z',
    channel_id: 'forum',
    channel_name: 'Strategy',
    thread_id: 'post-1',
    title: 'Best loadout for Hazard 5?',
    author: user('1', 'Brendan'),
    excerpt: 'Three of us on tonight, **no** revive perk.',
    reply_count: 7,
    last_reply_at: '2026-10-01T21:04:00Z',
    last_reply_author: user('2', 'Vincent'),
    participants: [user('2', 'Vincent'), user('3', 'Luke')],
  };

  it('is a solid card: who asked, the title, the start of the question and how it is going', () => {
    render(<FeedItemForumPost item={item} when="41m" nowMs={NOW} onOpen={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'Forum post: Best loadout for Hazard 5?' });
    expect(card).toHaveClass('glass-post');
    expect(card).toHaveTextContent('Brendan asked');
    expect(card).toHaveTextContent('Strategy');
    expect(card).toHaveTextContent('Three of us on tonight, no revive perk.');
    expect(card).toHaveTextContent('7 replies · last from Vincent');
    expect(within(card).getByText('Forum')).toHaveClass('glass-post__tag');
  });

  it('opens the post from its title and from where it was posted', async () => {
    const onOpen = vi.fn();
    render(<FeedItemForumPost item={item} when="41m" nowMs={NOW} onOpen={onOpen} />);
    await userEvent.click(screen.getByText('Best loadout for Hazard 5?'));
    await userEvent.click(screen.getByRole('button', { name: 'Open in Strategy' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe('who joined, in the feed', () => {
  const item: FeedMembersJoinedItem = {
    type: 'members_joined',
    id: 'j:1',
    key: '1',
    at: '2026-10-01T17:00:00Z',
    day: '2026-10-01',
    users: [user('9', 'Mara'), user('8', 'Dana')],
    total: 2,
  };

  it('is one line, not a card, with the way to say hello as text', async () => {
    const onSayHi = vi.fn();
    const { container } = render(<FeedItemMembersJoined item={item} when="4h" onSayHi={onSayHi} viewerId="1" />);
    const line = screen.getByRole('article', { name: 'Mara and Dana joined' });
    expect(line).toHaveClass('glass-happened');
    expect(container.querySelector('.glass-post')).toBeNull();
    await userEvent.click(within(line).getByRole('button', { name: 'Say hi to Mara' }));
    expect(onSayHi).toHaveBeenCalledWith(item.users[0]);
  });

  it('does not offer to say hi to yourself', () => {
    render(<FeedItemMembersJoined item={{ ...item, users: [user('1', 'Sean')], total: 1 }} when="4h" onSayHi={vi.fn()} viewerId="1" />);
    expect(screen.queryByRole('button', { name: /Say hi/ })).not.toBeInTheDocument();
  });
});
