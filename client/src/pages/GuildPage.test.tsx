import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore, scopeGuild } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { useUIStore } from '../stores/uiStore';
import type { Channel } from '../types';
import { GuildPage } from './GuildPage';

// The conversation header (WP-G11) is covered in components/glass/conversation.
vi.mock('../components/glass/conversation/ConversationHeader', () => ({
  ConversationHeader: ({ subject }: { subject: { kind: string; channelName?: string; title?: string } }) => (
    <div data-testid="topbar">{subject.kind === 'dm' ? subject.title : subject.channelName}</div>
  ),
}));

vi.mock('../components/channel/ForumView', () => ({
  ForumView: () => <div data-testid="forum-view" />,
}));

vi.mock('../components/glass/stage/StageChannelPanel', () => ({
  StageChannelPanel: ({ channelId }: { channelId: string }) => <div data-testid="stage-panel">{channelId}</div>,
}));

// The text view renders the page's notices (welcome, onboarding gate, pinned
// score, a stage channel's session) into its conversation pane, so the stub
// keeps them, and says which channel and header it was given.
vi.mock('./guild/TextChannelView', () => ({
  TextChannelView: ({
    notices,
    channelId,
    subject,
  }: {
    notices?: ReactNode;
    channelId: string;
    subject: { kind: string; channelName?: string };
  }) => (
    <div data-testid="text-view" data-channel={channelId} data-title={subject.channelName}>
      {notices}
    </div>
  ),
}));

vi.mock('../components/guild/GuildWelcomeScreen', () => ({
  GuildWelcomeScreen: ({ onDismiss }: { onDismiss: () => void }) => (
    <div data-testid="welcome">
      <button type="button" onClick={onDismiss}>
        Dismiss Welcome
      </button>
    </div>
  ),
}));

vi.mock('../components/guild/GuildOnboardingGate', () => ({
  GuildOnboardingGate: () => <div data-testid="onboarding" />,
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: false }),
}));

vi.mock('../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../api/sports')>('../api/sports');
  return {
    ...actual,
    sportsApi: {
      ...actual.sportsApi,
      getSettings: vi.fn().mockReturnValue(new Promise(() => {})),
      getBoard: vi.fn().mockReturnValue(new Promise(() => {})),
    },
  };
});

vi.mock('../api/channels', () => ({
  channelApi: { get: vi.fn().mockRejectedValue(new Error('offline')) },
  createChannelApi: () => ({ get: vi.fn().mockRejectedValue(new Error('offline')) }),
}));

const GUILD_ID = 'guild-1';

function makeChannel(id: string, type: number): Channel {
  return {
    id,
    name: `chan-${id}`,
    type,
    channel_type: type,
    guild_id: GUILD_ID,
    position: 0,
    permission_overwrites: [],
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as Channel;
}

function seedChannels(channels: Channel[], { isLoading = false }: { isLoading?: boolean } = {}) {
  const scope = { serverId: '__local__', userId: 'me' };
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels(GUILD_ID, isLoading ? [] : channels, scope);
  useChannelStore.setState({ loading: { [JSON.stringify(['__local__', 'me', GUILD_ID])]: isLoading } });
}

function renderGuildPage(channelId: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/guilds/${GUILD_ID}/channels/${channelId}`]}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<GuildPage />} />
        <Route path="/app/guilds/:guildId" element={<GuildPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GuildPage composition shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    useGuildStore.setState({ guilds: [scopeGuild({ id: GUILD_ID, name: 'Test Guild' } as never, { serverId: '__local__', userId: 'me' })] });
    useMemberStore.setState({ membersLoaded: { [JSON.stringify(['__local__', 'me', GUILD_ID])]: true } });
    useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'Me' } as never });
    useUIStore.setState({ contextPanelMode: null });
  });

  it('renders the loading screen while channels load', () => {
    seedChannels([], { isLoading: true });

    renderGuildPage('any');

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent(/Loading channels/);
  });

  it('distinguishes a failed channel request from a missing channel and retries its account', () => {
    seedChannels([]);
    const key = JSON.stringify(['__local__', 'me', GUILD_ID]);
    useChannelStore.setState({ errors: { [key]: 'Visibility service unavailable' } });
    const fetch = vi.spyOn(useChannelStore.getState(), 'fetchChannels').mockResolvedValue(undefined);
    renderGuildPage('any');
    expect(screen.getByRole('alert')).toHaveTextContent('Visibility service unavailable');
    expect(screen.queryByText('Channel not found')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fetch).toHaveBeenCalledWith(GUILD_ID, { serverId: '__local__', userId: 'me' });
    fetch.mockRestore();
  });

  it('renders the not-found screen for an unknown channel', () => {
    seedChannels([makeChannel('other', 0)]);

    renderGuildPage('ghost');

    expect(screen.getByRole('heading', { name: /channel not found/i })).toBeInTheDocument();
    expect(screen.queryByTestId('text-view')).not.toBeInTheDocument();
  });

  it('opens a voice channel as its chat: the conversation pane, not a separate page', () => {
    seedChannels([makeChannel('vc', 2)]);

    renderGuildPage('vc');

    const view = screen.getByTestId('text-view');
    expect(view).toHaveAttribute('data-channel', 'vc');
    expect(view).toHaveAttribute('data-title', 'chan-vc');
    expect(screen.queryByTestId('stage-panel')).not.toBeInTheDocument();
  });

  it('opens a stage channel as its chat with the stage session over it', () => {
    seedChannels([makeChannel('stage', 13)]);

    renderGuildPage('stage');

    expect(screen.getByTestId('text-view')).toHaveAttribute('data-channel', 'stage');
    expect(screen.getByTestId('stage-panel')).toHaveTextContent('stage');
  });

  it('renders the forum section for forum channels', () => {
    seedChannels([makeChannel('forum', 7)]);

    renderGuildPage('forum');

    expect(screen.getByTestId('forum-view')).toBeInTheDocument();
    expect(screen.queryByTestId('text-view')).not.toBeInTheDocument();
  });

  it('renders the text section for text channels', () => {
    seedChannels([makeChannel('text', 0)]);

    renderGuildPage('text');

    expect(screen.getByTestId('text-view')).toBeInTheDocument();
    expect(screen.queryByTestId('stage-panel')).not.toBeInTheDocument();
  });

  it('dismisses the welcome screen and persists the dismissal', async () => {
    const user = userEvent.setup();
    seedChannels([makeChannel('text', 0)]);

    renderGuildPage('text');

    expect(screen.getByTestId('welcome')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss Welcome' }));

    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`paracord:v2:guild-welcomed:${GUILD_ID}`)).toBe('1');
  });
});
