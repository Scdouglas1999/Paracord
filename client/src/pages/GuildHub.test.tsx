import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GuildHub } from './GuildHub';

const mockState = vi.hoisted(() => ({
  guilds: [] as Array<{
    id: string;
    name: string;
    hub_settings?: {
      banner_hash?: string;
      welcome_text?: string;
      description?: string;
      pinned_channels?: string[];
    };
    server_url?: string | null;
  }>,
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: (selector: (state: { guilds: typeof mockState.guilds }) => unknown) =>
    selector({ guilds: mockState.guilds }),
}));

vi.mock('../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: Record<string, unknown[]>; fetchChannels: () => Promise<void> }) => unknown) =>
    selector({ channelsByGuild: { 'guild-1': [] }, fetchChannels: vi.fn() }),
}));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: { channelParticipants: Map<string, unknown[]> }) => unknown) =>
    selector({ channelParticipants: new Map() }),
}));

function renderGuildHub() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/hub']}>
      <Routes>
        <Route path="/app/guilds/:guildId/hub" element={<GuildHub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GuildHub', () => {
  it('does not render unsafe data URL banners', () => {
    mockState.guilds = [
      {
        id: 'guild-1',
        name: 'Unsafe Banner Guild',
        hub_settings: {
          banner_hash: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+',
        },
      },
    ];

    renderGuildHub();

    expect(screen.queryByAltText('Server Banner')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /welcome to unsafe banner guild/i })).toBeInTheDocument();
  });

  it('renders safe image data URL banners', () => {
    mockState.guilds = [
      {
        id: 'guild-1',
        name: 'Safe Banner Guild',
        hub_settings: {
          banner_hash: 'data:image/png;base64,iVBORw0KGgo=',
        },
      },
    ];

    renderGuildHub();

    expect(screen.getByAltText('Server Banner')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('renders scheme-less federated server hosts without crashing', () => {
    mockState.guilds = [
      {
        id: 'guild-1',
        name: 'Scheme Less Guild',
        server_url: '127.0.0.1:18152',
      },
    ];

    renderGuildHub();

    expect(screen.getByText(/federated server on 127\.0\.0\.1:18152/i)).toBeInTheDocument();
  });
});
