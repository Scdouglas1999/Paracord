import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeedPostCard, isFeedEmbed, type FeedEmbed } from './FeedPostCard';

function embed(over: Partial<FeedEmbed> = {}): FeedEmbed {
  return {
    type: 'rich',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    title: 'Building the lantern',
    description: 'How we made it.',
    site_name: 'Lantern Works',
    thumbnail: 'https://i1.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
    timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
    feed: { kind: 'youtube', video_id: 'aaaaaaaaaaa', source_url: 'https://www.youtube.com/channel/UCx' },
    ...over,
  };
}

describe('FeedPostCard', () => {
  it('tells a feed embed from a link preview', () => {
    expect(isFeedEmbed(embed())).toBe(true);
    expect(isFeedEmbed({ url: 'https://example.com', title: 'Link' })).toBe(false);
    expect(isFeedEmbed(null)).toBe(false);
  });

  it('leads a video with its thumbnail and a play mark that opens the video', () => {
    render(<FeedPostCard embed={embed()} />);
    const play = screen.getByRole('link', { name: 'Play Building the lantern on YouTube' });
    expect(play).toHaveAttribute('href', 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(play).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Building the lantern' })).toBeInTheDocument();
    expect(screen.getByText('youtube.com')).toBeInTheDocument();
    expect(screen.getByText('How we made it.')).toBeInTheDocument();
    expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
  });

  it('has room for more actions under the card', () => {
    render(<FeedPostCard embed={embed()} actions={<button type="button">Watch together</button>} />);
    expect(screen.getByRole('button', { name: 'Watch together' })).toBeInTheDocument();
  });

  it('shows a picture beside the text for other sources', () => {
    const { container } = render(
      <FeedPostCard embed={embed({ feed: { kind: 'rss' }, url: 'https://blog.example/post', thumbnail: 'https://cdn.example/p.jpg' })} />,
    );
    expect(screen.queryByRole('link', { name: /Play/ })).not.toBeInTheDocument();
    expect(container.querySelector('img.pc-feed-thumb.is-square')).toHaveAttribute('src', 'https://cdn.example/p.jpg');
  });

  it('turns the overflow into one line to the source', () => {
    render(
      <FeedPostCard
        embed={embed({
          title: 'and 7 more from Lantern Journal',
          url: 'https://blog.example/',
          thumbnail: undefined,
          feed: { kind: 'rss', more: 7 },
        })}
      />,
    );
    const line = screen.getByRole('link', { name: 'and 7 more from Lantern Journal' });
    expect(line).toHaveAttribute('href', 'https://blog.example/');
  });

  it('refuses a card link that is not http or https', () => {
    render(<FeedPostCard embed={embed({ url: 'javascript:alert(1)', feed: { kind: 'rss' }, thumbnail: undefined })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Building the lantern')).toBeInTheDocument();
  });

  it('reads a date in the future as just now', () => {
    render(<FeedPostCard embed={embed({ timestamp: new Date(Date.now() + 3600_000).toISOString() })} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });
});
