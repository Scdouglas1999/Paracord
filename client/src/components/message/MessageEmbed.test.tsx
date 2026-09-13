import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageEmbedCard } from './MessageEmbed';

describe('MessageEmbedCard URL safety', () => {
  it('renders safe embed URLs as external links', () => {
    render(
      <MessageEmbedCard
        embed={{
          url: 'https://example.com/release',
          title: 'Release notes',
          description: 'Current release notes',
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /release notes/i })).toHaveAttribute(
      'href',
      'https://example.com/release',
    );
  });

  it('does not render unsafe embed URLs', () => {
    const { container } = render(
      <MessageEmbedCard
        embed={{
          url: 'javascript:alert(1)',
          title: 'Unsafe',
          description: 'Should not be clickable',
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  // A webhook may post an embed that is only a title and a description. The
  // type said `url` was required, the renderer trusted it, and
  // `safeExternalUrl(undefined)` threw — taking the whole message feed down
  // with it ("Couldn't display the message feed") for every reader of the
  // channel, not just that one message.
  it('renders an embed with no URL as a plain card', () => {
    render(
      <MessageEmbedCard
        embed={{ title: 'Build 42', description: 'is green' }}
      />,
    );

    expect(screen.getByText('Build 42')).toBeInTheDocument();
    expect(screen.getByText('is green')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing for an embed with neither a URL nor a body', () => {
    const { container } = render(<MessageEmbedCard embed={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render unsafe embed image URLs', () => {
    const { container } = render(
      <MessageEmbedCard
        embed={{
          url: 'https://example.com/release',
          title: 'Release notes',
          image: 'javascript:alert(1)',
        }}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /release notes/i })).toBeInTheDocument();
  });
});
