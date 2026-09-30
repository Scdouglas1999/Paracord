import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ChannelLoadErrorScreen, ChannelNotFoundScreen, GuildLoadingScreen } from './GuildStateScreens';

/**
 * The three states of a channel route with no conversation to draw yet. They
 * fill the conversation pane in the Glass layout: a skeleton shaped like the
 * conversation it becomes, and two pages with a title at the column's edge.
 */

vi.mock('../../components/glass/conversation/HeaderAvatar', () => ({ HeaderAvatar: () => <div data-testid="face" /> }));
vi.mock('../../components/glass/shell/useGlassLayout', () => ({ useGlassLayout: () => 'wide' }));

function Probe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function inRouter(element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/missing']}>
      <Routes>
        <Route path="*" element={element} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}

describe('GuildLoadingScreen', () => {
  it('is one polite status, busy, that says what is loading', () => {
    inRouter(<GuildLoadingScreen />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading channels...');
  });

  it('is shaped like the conversation: a header row, bubbles in the column, the message box', () => {
    const { container } = inRouter(<GuildLoadingScreen />);
    expect(container.querySelector('.glass-conversation__header .glass-header__heading')).not.toBeNull();
    expect(container.querySelectorAll('.glass-conversation__timeline .glass-msg').length).toBeGreaterThan(2);
    expect(container.querySelector('.glass-conversation__composer .glass-composer__capsule')).not.toBeNull();
    // It pulses and nothing more: no spinner, nothing to tab to.
    expect(container.querySelector('.pc-skeleton')).not.toBeNull();
    expect(container.querySelector('button, a, input')).toBeNull();
  });
});

describe('ChannelNotFoundScreen', () => {
  it('says the channel may be gone or not yours, without saying which', () => {
    inRouter(<ChannelNotFoundScreen guildId="g1" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Channel not found' })).toBeInTheDocument();
    expect(screen.getByText(/may have been deleted, or you might not have permission to see it/)).toBeInTheDocument();
  });

  it('leads back to the server', async () => {
    const user = userEvent.setup();
    inRouter(<ChannelNotFoundScreen guildId="g1" />);
    await user.click(screen.getByRole('button', { name: 'Back to a channel you can see' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');
  });

  it('offers no way back when it does not know the server', () => {
    inRouter(<ChannelNotFoundScreen guildId={undefined} />);
    expect(screen.queryByRole('button', { name: 'Back to a channel you can see' })).not.toBeInTheDocument();
  });
});

describe('ChannelLoadErrorScreen', () => {
  it('announces the failure with its reason, and tries again on request', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    inRouter(<ChannelLoadErrorScreen error="Could not reach the server." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load channels");
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
