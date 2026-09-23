import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GuildWelcomeScreen } from './GuildWelcomeScreen';
import type { Channel, Guild } from '../../types';

function buildGuild(iconHash: string | null): Guild {
  return {
    id: 'guild-1',
    name: 'Launch Server',
    icon_hash: iconHash,
    description: 'Release testing',
    owner_id: 'user-1',
    member_count: 2,
      created_at: '2026-05-17T00:00:00Z',
  };
}

const channels: Channel[] = [
  {
    id: 'channel-1',
    type: 0,
    channel_type: 0,
    guild_id: 'guild-1',
    name: 'general',
    position: 0,
    nsfw: false,
    created_at: '2026-05-17T00:00:00Z',
  },
];

describe('GuildWelcomeScreen', () => {
  it('renders safe stored data-url icons directly', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';

    render(<GuildWelcomeScreen guild={buildGuild(icon)} channels={channels} onDismiss={() => undefined} />);

    expect(screen.getByAltText('Launch Server')).toHaveAttribute('src', icon);
  });

  it('falls back to initials for unsafe or unresolved stored icon values', () => {
    render(
      <GuildWelcomeScreen
        guild={buildGuild('data:image/svg+xml;base64,PHN2Zz4=')}
        channels={channels}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.queryByAltText('Launch Server')).not.toBeInTheDocument();
    expect(screen.getByText('L')).toBeInTheDocument();
  });

  it('lists channels to explore, not the threads inside them', () => {
    const withThread: Channel[] = [
      ...channels,
      {
        id: 'thread-1',
        type: 6,
        channel_type: 6,
        guild_id: 'guild-1',
        parent_id: 'channel-1',
        name: 'resume ordering follow-ups',
        position: 0,
        nsfw: false,
        created_at: '2026-05-17T00:00:00Z',
      },
    ];
    render(<GuildWelcomeScreen guild={buildGuild(null)} channels={withThread} onDismiss={() => undefined} />);

    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.queryByText('resume ordering follow-ups')).not.toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });
});
