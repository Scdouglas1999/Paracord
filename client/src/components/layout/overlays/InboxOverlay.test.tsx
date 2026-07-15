import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../../api/channels';
import { savedMessagesApi } from '../../../api/savedMessages';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useSavedMessageStore } from '../../../stores/savedMessageStore';
import { InboxOverlay } from './InboxOverlay';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>,
      ),
    },
  };
});

vi.mock('../../../api/channels', () => ({
  channelApi: {
    getMessages: vi.fn(),
    updateReadState: vi.fn(),
  },
}));

vi.mock('../../../api/savedMessages', () => ({
  savedMessagesApi: {
    list: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  },
}));

const message = {
  id: 'message-3',
  channel_id: 'channel-2',
  author: { id: 'user-2', username: 'Grace', display_name: 'Grace H.', discriminator: '0002' },
  content: 'Can you review the launch checklist?',
  tts: false,
  mention_everyone: false,
  pinned: false,
  type: 0,
  attachments: [],
  reactions: [],
};

const channels = [{ id: 'channel-2', guild_id: 'guild-1', last_message_id: 'message-3' }];
const unreadItems = [{
  state: { channel_id: 'channel-2', last_message_id: 'message-1', mention_count: 2 },
  channelName: 'launch',
}];

function renderInbox() {
  render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <InboxOverlay open onClose={vi.fn()} unreadItems={unreadItems} allChannels={channels} />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

describe('InboxOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReadStateStore.getState().reset();
    useSavedMessageStore.getState().reset();
    vi.mocked(channelApi.getMessages).mockResolvedValue({ data: [message] } as never);
    vi.mocked(channelApi.updateReadState).mockResolvedValue({ data: {} } as never);
    vi.mocked(savedMessagesApi.list).mockResolvedValue({ data: { items: [], total: 0 } } as never);
    vi.mocked(savedMessagesApi.remove).mockResolvedValue({ data: {} } as never);
  });

  it('opens on mentions and gives unread channels real message context', async () => {
    renderInbox();

    expect(screen.getByRole('tab', { name: /Mentions/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Grace H.')).toBeInTheDocument();
    expect(screen.getByText('Can you review the launch checklist?')).toBeInTheDocument();
    expect(screen.getAllByText('2')).toHaveLength(2);
  });

  it('marks every unread channel read from one action', async () => {
    renderInbox();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(channelApi.updateReadState).toHaveBeenCalledWith('channel-2', 'message-3'));
    expect(useReadStateStore.getState().readStates['channel-2']).toMatchObject({
      last_message_id: 'message-3',
      mention_count: 0,
    });
  });

  it('lists saved messages and removes them without leaving the inbox', async () => {
    vi.mocked(savedMessagesApi.list).mockResolvedValue({
      data: {
        items: [{ message, saved_at: '2026-07-11T12:00:00Z', channel: { id: 'channel-2', name: 'launch', guild_id: 'guild-1' } }],
        total: 1,
      },
    } as never);
    renderInbox();

    fireEvent.click(screen.getByRole('tab', { name: /Saved/ }));
    const savedContent = await screen.findByText('Can you review the launch checklist?');
    fireEvent.click(savedContent);
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/app/guilds/guild-1/channels/channel-2?message=message-3',
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove message from Grace H\./ }));

    await waitFor(() => expect(savedMessagesApi.remove).toHaveBeenCalledWith('message-3'));
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
  });
});
