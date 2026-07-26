import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { Channel } from '../types';
import { GuildPage } from './GuildPage';

vi.mock('../components/layout/TopBar', () => ({
  TopBar: ({ channelName }: { channelName: string }) => <div data-testid="topbar">{channelName}</div>,
}));

vi.mock('../components/channel/ForumView', () => ({
  ForumView: () => <div data-testid="forum-view" />,
}));

vi.mock('./guild/VoiceStageChannel', () => ({
  VoiceStageChannel: () => <div data-testid="voice-stage" />,
}));

vi.mock('./guild/TextChannelView', () => ({
  TextChannelView: () => <div data-testid="text-view" />,
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

vi.mock('../api/channels', () => ({
  channelApi: { get: vi.fn().mockRejectedValue(new Error('offline')) },
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
  useChannelStore.setState({
    channels,
    channelsByGuild: { [GUILD_ID]: isLoading ? [] : channels },
    channelsById: Object.fromEntries(channels.map((c) => [c.id, c])),
    guildChannelsLoaded: { [GUILD_ID]: true },
    isLoading,
    selectedChannelId: null,
    selectedGuildId: null,
  });
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
    useGuildStore.setState({ guilds: [{ id: GUILD_ID, name: 'Test Guild' }] as never });
    useMemberStore.setState({ membersLoaded: { [GUILD_ID]: true } });
    useAuthStore.setState({ user: { id: 'me', username: 'Me' } as never });
    useUIStore.setState({ contextPanelMode: null });
  });

  it('renders the loading screen while channels load', () => {
    seedChannels([], { isLoading: true });

    renderGuildPage('any');

    expect(screen.getByTestId('topbar')).toHaveTextContent('Loading...');
    expect(screen.getByText('Loading channels...')).toBeInTheDocument();
  });

  it('renders the not-found screen for an unknown channel', () => {
    seedChannels([makeChannel('other', 0)]);

    renderGuildPage('ghost');

    expect(screen.getByRole('heading', { name: /channel not found/i })).toBeInTheDocument();
    expect(screen.queryByTestId('text-view')).not.toBeInTheDocument();
  });

  it('renders the voice/stage section for voice channels', () => {
    seedChannels([makeChannel('vc', 2)]);

    renderGuildPage('vc');

    expect(screen.getByTestId('voice-stage')).toBeInTheDocument();
    expect(screen.queryByTestId('text-view')).not.toBeInTheDocument();
  });

  it('preserves a RoomCard Watch handoff (watchedStreamerId) when landing on the voice channel', () => {
    // CHAT-4 handoff seam: RoomCard.Watch sets voiceStore.watchedStreamerId THEN
    // navigates to the voice channel route. GuildPage must NOT clear it on the
    // initial mount — only when the user actually switches channels.
    useVoiceStore.setState({ watchedStreamerId: 'streamer-1' });
    seedChannels([makeChannel('vc', 2)]);

    renderGuildPage('vc');

    expect(screen.getByTestId('voice-stage')).toBeInTheDocument();
    expect(useVoiceStore.getState().watchedStreamerId).toBe('streamer-1');
  });

  it('renders the forum section for forum channels', () => {
    seedChannels([makeChannel('forum', 7)]);

    renderGuildPage('forum');

    expect(screen.getByTestId('forum-view')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-stage')).not.toBeInTheDocument();
  });

  it('renders the text section for text channels', () => {
    seedChannels([makeChannel('text', 0)]);

    renderGuildPage('text');

    expect(screen.getByTestId('text-view')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-stage')).not.toBeInTheDocument();
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
