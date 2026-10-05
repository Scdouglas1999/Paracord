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

// The conversation (large title, timeline, welcome, message box) is covered in components/ix/conversation.
// A forum is its chrome over the forum's own posts; here it is reduced to the channel it was given.
vi.mock('../components/ix/conversation/ForumPage', () => ({
  ForumPage: ({ subject }: { subject: { channelId: string; channelName: string } }) => (
    <div data-testid="forum-view" data-channel={subject.channelId} data-title={subject.channelName} />
  ),
}));

vi.mock('../components/glass/stage/StageChannelPanel', () => ({
  StageChannelPanel: ({ channelId }: { channelId: string }) => <div data-testid="stage-panel">{channelId}</div>,
}));

// The text view renders the page's notices (a pinned score, a stage channel's session)
// under its large title, so the stub keeps them, and says which channel and title it was
// given. "Pick roles" is its onboarding callback.
vi.mock('./guild/TextChannelView', () => ({
  TextChannelView: ({
    notices,
    channelId,
    subject,
    onPickRoles,
  }: {
    notices?: ReactNode;
    channelId: string;
    subject: { kind: string; channelName?: string };
    onPickRoles?: () => void;
  }) => (
    <div data-testid="text-view" data-channel={channelId} data-title={subject.channelName}>
      {notices}
      <button type="button" onClick={onPickRoles}>
        Pick roles
      </button>
    </div>
  ),
}));

const gateMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/guild/GuildOnboardingGate', async () => {
  const React = await import('react');
  return {
    GuildOnboardingGate: () => {
      React.useEffect(() => {
        gateMounts.count += 1;
      }, []);
      return <div data-testid="onboarding" />;
    },
  };
});

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
    gateMounts.count = 0;
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
    expect(screen.queryByText('This channel is gone')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fetch).toHaveBeenCalledWith(GUILD_ID, { serverId: '__local__', userId: 'me' });
    fetch.mockRestore();
  });

  it('renders the not-found screen for an unknown channel', () => {
    seedChannels([makeChannel('other', 0)]);

    renderGuildPage('ghost');

    // The empty-state layout (docs/index-spec.md §6.8), not a page with a title.
    expect(screen.getByRole('heading', { name: /this channel is gone/i })).toBeInTheDocument();
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

  it('has no welcome modal: the welcome belongs to the conversation, and the onboarding page stays', () => {
    seedChannels([makeChannel('text', 0)]);

    renderGuildPage('text');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
    // Opening a server writes nothing: being welcomed is the conversation's (it marks it when it is shown).
    expect(window.localStorage.getItem(`paracord:v2:guild-welcomed:${GUILD_ID}`)).toBeNull();
  });

  it('brings the onboarding page back when the welcome\'s Pick roles asks', async () => {
    const user = userEvent.setup();
    seedChannels([makeChannel('text', 0)]);

    renderGuildPage('text');
    expect(gateMounts.count).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Pick roles' }));

    expect(gateMounts.count).toBe(2);
  });

  it('pins the onboarding page over a forum too', () => {
    seedChannels([makeChannel('forum', 7)]);

    renderGuildPage('forum');

    expect(screen.getByTestId('forum-view')).toHaveAttribute('data-channel', 'forum');
    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
  });
});
