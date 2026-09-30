import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceStore } from '../../../stores/voiceStore';
import type { GuildEventResult, GuildEventView } from './useGuildEvent';
import { ChannelMentionChip, EventChip } from './InlineChips';

const mocks = vi.hoisted(() => ({
  channels: {} as Record<string, { id: string; name: string; type: number; guild_id: string }>,
  event: { status: 'ready', event: null, error: null, busy: false, toggleRsvp: vi.fn() } as unknown as GuildEventResult,
}));

vi.mock('../../../hooks/useChannels', () => ({
  useCurrentChannelStore: (selector: (view: { channelsById: typeof mocks.channels }) => unknown) =>
    selector({ channelsById: mocks.channels }),
}));
vi.mock('./useGuildEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useGuildEvent')>()),
  useGuildEvent: () => mocks.event,
}));

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const inside = (channelId: string, count: number) =>
  act(() => {
    useVoiceStore.setState({
      channelParticipants: new Map([[channelId, Array.from({ length: count }, (_, i) => ({ user_id: String(i) }) as never)]]),
    });
  });

const chip = (channelId: string) =>
  render(
    <MemoryRouter>
      <ChannelMentionChip channelId={channelId} />
      <Where />
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.channels = {
    '2002': { id: '2002', name: 'Lounge', type: 2, guild_id: 'g1' },
    '2001': { id: '2001', name: 'General', type: 0, guild_id: 'g1' },
  };
  act(() => {
    useVoiceStore.setState({ channelParticipants: new Map() });
  });
});

describe('a channel in a sentence', () => {
  it('is the live chip when it is a voice channel with people in it: amber dot, the name, “3 in”', () => {
    inside('2002', 3);
    chip('2002');
    const live = screen.getByRole('button', { name: 'Lounge, 3 in it now' });
    expect(live).toHaveClass('glass-chip--live');
    expect(live.querySelector('.glass-chip__dot')).not.toBeNull();
    expect(live).toHaveTextContent('Lounge3 in');
  });

  it('is a quiet chip with just its name when nobody is in the voice channel', () => {
    chip('2002');
    const quiet = screen.getByRole('button', { name: 'Lounge' });
    expect(quiet).not.toHaveClass('glass-chip--live');
    expect(quiet.querySelector('.glass-chip__dot')).toBeNull();
  });

  it('is a quiet chip for a text channel, and never has a #', () => {
    chip('2001');
    const quiet = screen.getByRole('button', { name: 'General' });
    expect(quiet).toHaveTextContent(/^General$/);
    expect(quiet.textContent).not.toContain('#');
  });

  it('goes to the channel when pressed', () => {
    chip('2001');
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/guilds/g1/channels/2001');
  });

  it('says so, quietly, about a channel that is gone or not yours to see', () => {
    chip('9999');
    expect(screen.getByText('a channel')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('only counts people in a voice channel: a text channel with somebody “in” it is still quiet', () => {
    inside('2001', 4);
    chip('2001');
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveClass('glass-chip--live');
  });
});

describe('an event in a sentence', () => {
  const ev = (over: Partial<GuildEventView> = {}): GuildEventView => ({
    id: '7002',
    guildId: 'g1',
    name: 'Movie night',
    startsAt: new Date(Date.now() + 26 * 60 * 60 * 1000),
    endsAt: null,
    channelId: null,
    location: null,
    creatorId: '42',
    going: 6,
    youAreGoing: true,
    status: 1,
    ...over,
  });

  it('is the calendar glyph, the name and a short time', () => {
    mocks.event = { status: 'ready', event: ev(), error: null, busy: false, toggleRsvp: vi.fn() };
    const { container } = render(<EventChip guildId="g1" eventId="7002" />);
    const el = container.querySelector('.glass-chip--event') as HTMLElement;
    expect(el).toHaveTextContent('Movie night');
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('.glass-inline-chip__aside')?.textContent).toMatch(/\d/);
  });

  it('says “now” while it is happening', () => {
    mocks.event = {
      status: 'ready',
      event: ev({ startsAt: new Date(Date.now() - 30 * 60 * 1000), status: 2 }),
      error: null,
      busy: false,
      toggleRsvp: vi.fn(),
    };
    const { container } = render(<EventChip guildId="g1" eventId="7002" />);
    expect(container.querySelector('.glass-inline-chip__aside')).toHaveTextContent('now');
  });

  it('is quiet when the event is loading or gone', () => {
    mocks.event = { status: 'loading', event: null, error: null, busy: false, toggleRsvp: vi.fn() };
    const { rerender } = render(<EventChip guildId="g1" eventId="7002" />);
    expect(screen.getByText('an event')).toBeInTheDocument();
    mocks.event = { status: 'missing', event: null, error: null, busy: false, toggleRsvp: vi.fn() };
    rerender(<EventChip guildId="g1" eventId="7002" />);
    expect(screen.getByText('an event that is gone')).toBeInTheDocument();
  });
});
