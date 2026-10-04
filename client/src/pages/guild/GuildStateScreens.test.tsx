import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { scopeGuild, useGuildStore } from '../../stores/guildStore';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { ChannelType, type Channel } from '../../types';
import { ChannelLoadErrorScreen, ChannelNotFoundScreen, GuildLoadingScreen, landingChannel } from './GuildStateScreens';

/**
 * The three states of a channel route with no conversation to draw yet
 * (docs/index-spec.md §6.8): a skeleton in the conversation's geometry, and two
 * notices in the empty-state layout, each with one cream action.
 */

const SCOPE = { serverId: LOCAL_SERVER_ID, userId: 'viewer' };
const GUILD = 'g1';

function chan(over: Partial<Channel> & { id: string; name: string }): Channel {
  return { type: ChannelType.Text, position: 0, nsfw: false, created_at: '', guild_id: GUILD, ...over } as Channel;
}

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

function seed(channels: Channel[], defaultChannelId: string | null = null) {
  useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as never, token: 'token' });
  useGuildStore.setState({
    guilds: [
      scopeGuild(
        { id: GUILD, name: 'Fuel', owner_id: 'viewer', member_count: 1, created_at: '', default_channel_id: defaultChannelId } as never,
        SCOPE,
      ),
    ],
  });
  useChannelStore.getState().setChannels(GUILD, channels, SCOPE);
}

beforeEach(() => {
  useGuildStore.getState().reset();
  useChannelStore.getState().reset();
});
afterEach(cleanup);

describe('GuildLoadingScreen', () => {
  it('is one polite status, busy, that says what is loading', () => {
    inRouter(<GuildLoadingScreen />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading channels...');
  });

  it('is shaped like the conversation: the title, groups of bubbles, the message box', () => {
    const { container } = inRouter(<GuildLoadingScreen />);
    expect(container.querySelector('.ix-skeleton__head .ix-skeleton__title')).not.toBeNull();
    expect(container.querySelectorAll('.ix-skeleton__feed .ix-skeleton__group').length).toBeGreaterThan(2);
    expect(container.querySelectorAll('.ix-skeleton__group[data-own]').length).toBe(1);
    expect(container.querySelector('.ix-skeleton__box')).not.toBeNull();
    // Static and inert: no spinner, nothing to tab to, nothing that pulses.
    expect(container.querySelector('button, a, input, .pc-skeleton')).toBeNull();
  });
});

describe('landingChannel', () => {
  const general = chan({ id: 'c1', name: 'general', position: 1 });
  const clips = chan({ id: 'c2', name: 'clips', position: 2 });
  const room = chan({ id: 'v1', name: 'Lounge', type: ChannelType.Voice, position: 0 });
  const news = chan({ id: 'a1', name: 'news', type: ChannelType.Announcement, position: 3 });

  it('prefers the server default, then the first text channel in sidebar order', () => {
    expect(landingChannel([clips, room, general], 'c2')?.id).toBe('c2');
    expect(landingChannel([clips, room, general], null)?.id).toBe('c1');
    expect(landingChannel([clips, room, general], 'gone')?.id).toBe('c1');
  });

  it('never lands on a room, and falls back to an announcement channel', () => {
    expect(landingChannel([room], null)).toBeNull();
    expect(landingChannel([room, news], 'v1')?.id).toBe('a1');
  });
});

describe('ChannelNotFoundScreen', () => {
  it('says the channel may be gone or not yours, without saying which', () => {
    seed([chan({ id: 'c1', name: 'general' })]);
    inRouter(<ChannelNotFoundScreen guildId={GUILD} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This channel is gone' })).toBeInTheDocument();
    expect(screen.getByText(/may have been deleted, or you might not have permission to see it/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Channel not found' })).toBeInTheDocument();
  });

  it('leads back to the server’s landing channel by name', async () => {
    const user = userEvent.setup();
    seed([chan({ id: 'c2', name: 'clips', position: 2 }), chan({ id: 'c1', name: 'general', position: 1 })], 'c1');
    inRouter(<ChannelNotFoundScreen guildId={GUILD} />);
    await user.click(screen.getByRole('button', { name: 'Go to general' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/c1');
  });

  it('opens the server when it has no channel to read', async () => {
    const user = userEvent.setup();
    seed([chan({ id: 'v1', name: 'Lounge', type: ChannelType.Voice })]);
    inRouter(<ChannelNotFoundScreen guildId={GUILD} />);
    await user.click(screen.getByRole('button', { name: 'Open the server' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/app\/guilds\/g1$/);
  });

  it('offers no way back when it does not know the server', () => {
    inRouter(<ChannelNotFoundScreen guildId={undefined} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wears the server’s hue on its tile', () => {
    seed([chan({ id: 'c1', name: 'general' })]);
    useGuildStore.setState({
      guilds: [scopeGuild({ id: GUILD, name: 'Fuel', owner_id: 'viewer', member_count: 1, created_at: '', hue: 195 } as never, SCOPE)],
    });
    inRouter(<ChannelNotFoundScreen guildId={GUILD} />);
    expect(screen.getByTestId('ix-empty').style.getPropertyValue('--ix-hue')).toBe('195');
  });
});

describe('ChannelLoadErrorScreen', () => {
  it('announces the failure with its reason, and tries again on request', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    inRouter(<ChannelLoadErrorScreen error="Could not reach the server." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load channels");
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.');
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
