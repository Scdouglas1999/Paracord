import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GitHubEventEmbed, isGitHubWebhookMessage } from './GitHubEventEmbed';

describe('GitHubEventEmbed URL safety', () => {
  it('renders safe GitHub event URLs', () => {
    render(
      <GitHubEventEmbed content="**alice** opened PR [#42](https://github.com/acme/app/pull/42) in **acme/app**" />,
    );

    expect(screen.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/42',
    );
  });

  it('does not render unsafe GitHub event URLs', () => {
    render(
      <GitHubEventEmbed content="**alice** opened PR [#42](javascript:alert(1)) in **acme/app**" />,
    );

    expect(screen.queryByRole('link', { name: 'View on GitHub' })).not.toBeInTheDocument();
  });

  it('still detects webhook messages when unsafe links are omitted from rendering', () => {
    expect(
      isGitHubWebhookMessage({
        author: { bot: true },
        content: '**alice** opened issue [#7](javascript:alert(1)) in **acme/app**',
      }),
    ).toBe(true);
  });

  it('is a card of the family: the mark, what happened in sentence case, and the repo', () => {
    const { container } = render(
      <GitHubEventEmbed content="**alice** opened PR [#42](https://github.com/acme/app/pull/42) in **acme/app**" />,
    );
    expect(container.querySelector('.ix-card.ix-gh')).not.toBeNull();
    expect(container.querySelector('.ix-gh__label')).toHaveTextContent('Pull request');
    expect(container.querySelector('.ix-gh__repo')).toHaveTextContent('acme/app');
  });

  it('tints only what removes something', () => {
    const { container, rerender } = render(<GitHubEventEmbed content="**alice** deleted branch `old-ui` in **acme/app**" />);
    expect(container.querySelector('.ix-gh__label')).toHaveAttribute('data-tone', 'danger');
    rerender(<GitHubEventEmbed content="**alice** pushed 3 commits to `main` in **acme/app**" />);
    expect(container.querySelector('.ix-gh__label')).not.toHaveAttribute('data-tone');
  });

  it('renders nothing for a message that is not a GitHub event', () => {
    const { container } = render(<GitHubEventEmbed content="lunch?" />);
    expect(container).toBeEmptyDOMElement();
  });
});
