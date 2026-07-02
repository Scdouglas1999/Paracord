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
});
