import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextPanel } from './ContextPanel';
import { useUIStore, type ContextPanelMode } from '../../stores/uiStore';

// Isolate ContextPanel from the (heavy, store/router-bound) wrapped surfaces:
// every mode should resolve to exactly one of these stand-ins.
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
  PinnedMessagesOverlay: (props: { open: boolean; onClose: () => void }) =>
    props.open ? (
      <button type="button" data-testid="surface-pins" onClick={props.onClose}>
        pins
      </button>
    ) : null,
}));
vi.mock('./overlays/SearchOverlay', () => ({
  SearchOverlay: (props: { open: boolean; onClose: () => void }) =>
    props.open ? (
      <button type="button" data-testid="surface-search" onClick={props.onClose}>
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

describe('ContextPanel', () => {
  beforeEach(() => {
    setMode(null);
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
    expect(screen.getByTestId('surface-pins')).toBeInTheDocument();
  });

  it('renders the search surface', () => {
    setMode('search');
    render(<ContextPanel {...baseProps} />);
    expect(screen.getByTestId('surface-search')).toBeInTheDocument();
  });

  it('renders nothing for economy without a guild', () => {
    setMode('economy');
    const { container } = render(<ContextPanel {...baseProps} guildId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for threads without an active thread', () => {
    setMode('threads');
    const { container } = render(<ContextPanel {...baseProps} activeThread={null} />);
    expect(container).toBeEmptyDOMElement();
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
