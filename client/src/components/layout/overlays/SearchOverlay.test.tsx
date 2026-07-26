import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../../api/channels';
import { SearchOverlay } from './SearchOverlay';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        ),
      ),
    },
  };
});

vi.mock('../../../api/channels', () => ({
  channelApi: {
    searchMessages: vi.fn(),
    getMessages: vi.fn(),
  },
}));

function renderSearchOverlay(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <SearchOverlay
        open
        onClose={onClose}
        channelId="channel-1"
        channelName="general"
        allChannels={[{ id: 'channel-1', guild_id: 'guild-1', name: 'general' }]}
      />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('SearchOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.searchMessages).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.getMessages).mockResolvedValue({ data: [] } as never);
  });

  it('opens as a named dialog with a labeled search field and close action', async () => {
    const { onClose } = renderSearchOverlay();

    expect(screen.getByRole('dialog', { name: 'Search Messages' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search messages' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('announces search progress and failure when server and fallback search fail', async () => {
    const user = userEvent.setup();
    let rejectSearch: (error: Error) => void = () => {};
    let rejectFallback: (error: Error) => void = () => {};
    vi.mocked(channelApi.searchMessages).mockImplementation(
      () => new Promise((_, reject) => {
        rejectSearch = reject;
      }) as never,
    );
    vi.mocked(channelApi.getMessages).mockImplementation(
      () => new Promise((_, reject) => {
        rejectFallback = reject;
      }) as never,
    );
    renderSearchOverlay();

    await user.type(screen.getByRole('textbox', { name: 'Search messages' }), 'release');

    expect(await screen.findByRole('status')).toHaveTextContent('Searching messages...');
    await waitFor(() => {
      expect(channelApi.searchMessages).toHaveBeenCalledWith('channel-1', 'release', 25);
    });
    await act(async () => {
      rejectSearch(new Error('search down'));
    });
    await waitFor(() => {
      expect(channelApi.getMessages).toHaveBeenCalledWith('channel-1', { limit: 100 });
    });
    await act(async () => {
      rejectFallback(new Error('fallback down'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Search is temporarily unavailable for this server.',
    );
  });
});
