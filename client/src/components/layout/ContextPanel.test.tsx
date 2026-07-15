import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextPanel } from './ContextPanel';
import { useUIStore, type ContextPanelMode } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import type { Channel } from '../../types';

const navigateMock = vi.fn();

// Isolate ContextPanel from the (heavy, store/router-bound) wrapped surfaces:
// every mode should resolve to exactly one of these stand-ins.
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    getPins: vi.fn().mockResolvedValue({ data: [] }),
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock('./MemberList', () => ({
  MemberList: () => <div data-testid="surface-members" />,
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
  SearchOverlay: (props: { open: boolean; onClose: () => void; presentation?: string }) =>
    props.open ? (
      <button type="button" data-testid="surface-search" data-presentation={props.presentation} onClick={props.onClose}>
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
  allChannels: [{ id: 'chan-1', guild_id: 'guild-1', name: 'general' }],
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
    useChannelStore.setState({
      channelsByGuild: {},
      dmChannelsByServer: {},
      channelsById: {},
      channels: [],
      guildChannelsLoaded: {},
      selectedChannelId: null,
      selectedGuildId: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    setMode(null);
    vi.clearAllMocks();
  });

  it('renders nothing when contextPanelMode is null', () => {
    const { container } = render(<ContextPanel {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the members surface with panel chrome', () => {
    setMode('members');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-members')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Members' })).toBeInTheDocument();
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
    expect(screen.getByTestId('surface-search')).toHaveAttribute('data-presentation', 'panel');
  });

  it('renders nothing for economy without a guild', () => {
    setMode('economy');
    const { container } = render(<ContextPanel {...baseProps} guildId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an empty thread list for a text channel without threads', async () => {
    setMode('threads');
    useChannelStore.getState().addChannel(makeChannel());
    render(<ContextPanel {...baseProps} activeThread={null} />);
    expect(await screen.findByText('No threads yet')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Threads' })).toBeInTheDocument();
  });

  it('opens a listed thread from a text channel', async () => {
    setMode('threads');
    useChannelStore.getState().addChannel(makeChannel());
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
    );
    render(<ContextPanel {...baseProps} activeThread={null} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Release plan/ }));
    expect(useChannelStore.getState().selectedChannelId).toBe('thread-1');
    expect(navigateMock).toHaveBeenCalledWith('/app/guilds/guild-1/channels/thread-1');
  });

  it('close control clears contextPanelMode (panel-chrome header)', () => {
    setMode('members');
    render(<ContextPanel {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Members panel' }));
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('close control clears contextPanelMode (overlay surface)', () => {
    setMode('pins');
    render(<ContextPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId('surface-pins'));
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('Escape clears contextPanelMode when the panel owns focus', () => {
    setMode('members');
    render(<ContextPanel {...baseProps} />);
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Members' }), { key: 'Escape' });
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });
});
