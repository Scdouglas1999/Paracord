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
