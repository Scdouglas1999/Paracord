import { useAuthStore } from '../../stores/authStore';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextPanel } from './ContextPanel';
import { useUIStore, type ContextPanelMode } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import type { Channel } from '../../types';

const navigateMock = vi.fn();

// Isolate ContextPanel from the (heavy, store/router-bound) wrapped surfaces:
// every mode should resolve to exactly one of these stand-ins.
vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    getPins: vi.fn().mockResolvedValue({ data: [] }),
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock('./GroupDmMembersPanel', () => ({
  GroupDmMembersPanel: (props: { channelId: string; onClose: () => void }) => (
    <button type="button" data-testid="surface-recipients" data-channel={props.channelId} onClick={props.onClose}>
      recipients
    </button>
  ),
}));
vi.mock('../message/ThreadPanel', () => ({
  ThreadPanel: (props: { onClose: () => void }) => (
    <button type="button" data-testid="surface-threads" onClick={props.onClose}>
      thread
    </button>
  ),
}));
vi.mock('./overlays/PinnedMessagesOverlay', () => ({
  PinnedMessagesOverlay: (props: { open: boolean; onClose: () => void; presentation?: string }) =>
    props.open ? (
      <button type="button" data-testid="surface-pins" data-presentation={props.presentation} onClick={props.onClose}>
        pins
      </button>
    ) : null,
}));
vi.mock('./overlays/SearchOverlay', () => ({
  SearchOverlay: (props: { open: boolean; onClose: () => void; guildId?: string | null; channelId?: string }) =>
    props.open ? (
      <button type="button" data-testid="surface-search" data-guild={props.guildId ?? ''} data-channel={props.channelId ?? ''} onClick={props.onClose}>
        search
      </button>
    ) : null,
}));
vi.mock('../guild/GuildEconomyPanel', () => ({
  GuildEconomyPanel: (props: { guildId: string }) => (
    <div data-testid="surface-economy" data-guild={props.guildId} />
  ),
}));

const setMode = (mode: ContextPanelMode) => {
  act(() => {
    useUIStore.getState().setContextPanelMode(mode);
  });
};

const baseProps = {
  guildId: 'guild-1',
  channelId: 'chan-1',
  channelName: 'general',
  pins: [],
  onPinsChange: vi.fn(),
  activeThread: {
    threadChannelId: 'thread-1',
    threadName: 'Release plan',
    parentChannelName: 'general',
  },
};

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'chan-1',
    type: 0,
    channel_type: 0,
    guild_id: 'guild-1',
    name: 'general',
    position: 0,
    nsfw: false,
    created_at: '2026-01-01T00:00:00Z',
    thread_metadata: null,
    required_role_ids: [],
    owner_id: null,
    message_count: null,
    ...overrides,
  };
}

describe('ContextPanel', () => {
  beforeEach(() => {
    setMode(null);
    navigateMock.mockReset();
    useChannelStore.getState().reset();
    useAuthStore.setState({ token: 'token', user: { id: 'me' } as never });
  });

  afterEach(() => {
    setMode(null);
    vi.clearAllMocks();
  });

  it('renders nothing when contextPanelMode is null', () => {
    const { container } = render(<ContextPanel {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  // lantern-stage-spec §6.5: there is no docked member list. A group message's
  // recipients are who it is addressed to, and that surface is editable — the
  // one list the panel still opens, and only for a group DM.
  it('renders the group-DM recipients surface, self-chromed', () => {
    useChannelStore.getState().addChannel(makeChannel({ id: 'chan-1', type: 3, channel_type: 3 }), {
      serverId: '__local__',
      userId: 'me',
    });
    setMode('recipients');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-recipients')).toHaveAttribute('data-channel', 'chan-1');
  });

  it('renders nothing for recipients outside a group DM', () => {
    useChannelStore.getState().addChannel(makeChannel(), { serverId: '__local__', userId: 'me' });
    setMode('recipients');
    const { container } = render(<ContextPanel {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no member-list mode at all', () => {
    // The type no longer admits one; this pins the DOM consequence too.
    setMode('economy');
    render(<ContextPanel {...baseProps} />);
    expect(screen.queryByRole('complementary', { name: 'Members' })).not.toBeInTheDocument();
  });

  it('renders the economy surface and forwards the guild id', () => {
    setMode('economy');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-economy')).toHaveAttribute('data-guild', 'guild-1');
  });

  it('renders the threads surface when an active thread is present', () => {
    setMode('threads');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-threads')).toBeInTheDocument();
  });

  it('renders the pins surface', () => {
    setMode('pins');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-pins')).toHaveAttribute('data-presentation', 'panel');
  });

  it('renders the search surface', () => {
    setMode('search');
    render(<ContextPanel {...baseProps} />);
    const surface = screen.getByTestId('surface-search');
    expect(surface).toHaveAttribute('data-guild', baseProps.guildId ?? '');
    expect(surface).toHaveAttribute('data-channel', baseProps.channelId ?? '');
  });

  it('renders nothing for economy without a guild', () => {
    setMode('economy');
    const { container } = render(<ContextPanel {...baseProps} guildId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an empty thread list for a text channel without threads', async () => {
    setMode('threads');
    useChannelStore.getState().addChannel(makeChannel(), { serverId: '__local__', userId: 'me' });
    render(<ContextPanel {...baseProps} activeThread={null} />);
    expect(await screen.findByText('No threads yet')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Threads' })).toBeInTheDocument();
  });

  it('opens a listed thread from a text channel', async () => {
    setMode('threads');
    useChannelStore.getState().addChannel(makeChannel(), { serverId: '__local__', userId: 'me' });
    useChannelStore.getState().addChannel(
      makeChannel({
        id: 'thread-1',
        type: 6,
        channel_type: 6,
        name: 'Release plan',
        parent_id: 'chan-1',
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          locked: false,
        },
      }),
      { serverId: '__local__', userId: 'me' },
    );
    render(<ContextPanel {...baseProps} activeThread={null} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Release plan/ }));
    expect(useChannelStore.getState().selectedChannel?.id).toBe('thread-1');
    expect(navigateMock).toHaveBeenCalledWith('/app/guilds/guild-1/channels/thread-1');
  });

  it('close control clears contextPanelMode (panel-chrome header)', () => {
    setMode('economy');
    render(<ContextPanel {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Server economy panel' }));
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('close control clears contextPanelMode (overlay surface)', () => {
    setMode('pins');
    render(<ContextPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId('surface-pins'));
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('Escape clears contextPanelMode when the panel owns focus', () => {
    setMode('economy');
    render(<ContextPanel {...baseProps} />);
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Server economy' }), { key: 'Escape' });
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });
});
