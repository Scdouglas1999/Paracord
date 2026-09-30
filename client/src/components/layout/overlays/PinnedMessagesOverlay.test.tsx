import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../../api/channels';
import type { Message } from '../../../types';
import { PinnedMessagesOverlay } from './PinnedMessagesOverlay';

/**
 * Pinned messages, as the page of the channel sheet: solid cards, one press to
 * jump to the message, a quiet unpin, and an empty state that says what to do.
 */

vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => false }));

const unpinMessage = vi.fn();
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (state: { unpinMessage: typeof unpinMessage }) => unknown) => selector({ unpinMessage }),
}));
vi.mock('../../../api/channels', () => ({ channelApi: { getPins: vi.fn() } }));

const pin = (id: string, name: string, content: string): Message =>
  ({
    id,
    channel_id: 'c1',
    author: { id: `u-${id}`, username: name.toLowerCase(), display_name: name, discriminator: '0001', avatar_hash: null },
    content,
    created_at: '2026-10-01T20:41:00.000Z',
    pinned: true,
    type: 0,
    attachments: [],
    reactions: [],
  }) as unknown as Message;

function renderPins(overrides: Partial<React.ComponentProps<typeof PinnedMessagesOverlay>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    channelId: 'c1',
    pins: [pin('p1', 'Brendan', 'Haz 5 runs from 9.'), pin('p2', 'Jeremy', '')],
    onPinsChange: vi.fn(),
    onErrorChange: vi.fn(),
    presentation: 'panel' as const,
    ...overrides,
  };
  render(<PinnedMessagesOverlay {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  vi.mocked(channelApi.getPins).mockResolvedValue({ data: [] } as never);
});

describe('PinnedMessagesOverlay as a page', () => {
  it('shows who pinned what, and says so when a message is only an attachment', () => {
    renderPins();
    expect(screen.getByText('Haz 5 runs from 9.')).toBeInTheDocument();
    expect(screen.getByText('Brendan')).toBeInTheDocument();
    expect(screen.getByText('Attachment only')).toBeInTheDocument();
  });

  it('jumps to the message, then closes the sheet', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPins();
    await user.click(screen.getByRole('button', { name: 'Jump to pinned message from Brendan' }));
    expect(window.location.hash).toBe('#msg-p1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unpins, then reads the pins again', async () => {
    const user = userEvent.setup();
    const remaining = [pin('p2', 'Jeremy', 'Left')];
    vi.mocked(channelApi.getPins).mockResolvedValue({ data: remaining } as never);
    unpinMessage.mockResolvedValue(undefined);
    const { onPinsChange } = renderPins();
    const unpin = screen.getAllByRole('button', { name: 'Unpin this message' })[0];
    await user.click(unpin);
    await waitFor(() => expect(unpinMessage).toHaveBeenCalledWith('c1', 'p1'));
    await waitFor(() => expect(onPinsChange).toHaveBeenCalledWith(remaining));
  });

  it('says why an unpin failed', async () => {
    const user = userEvent.setup();
    unpinMessage.mockRejectedValue(new Error('Not allowed'));
    const { onErrorChange } = renderPins();
    await user.click(screen.getAllByRole('button', { name: 'Unpin this message' })[0]);
    await waitFor(() => expect(onErrorChange).toHaveBeenLastCalledWith(expect.stringContaining('Failed to unpin message')));
  });

  it('shows an error where the list would be', () => {
    renderPins({ pins: [], error: 'Failed to load pinned messages: nope' });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load pinned messages: nope');
    expect(screen.queryByText('No pinned messages yet')).not.toBeInTheDocument();
  });

  it('says what to do when nothing is pinned', () => {
    renderPins({ pins: [] });
    expect(screen.getByText('No pinned messages yet')).toBeInTheDocument();
    expect(screen.getByText(/Pin a message from its more menu/)).toBeInTheDocument();
  });

  it('offers no unpin without a channel to unpin from', () => {
    renderPins({ channelId: undefined });
    expect(screen.queryByRole('button', { name: 'Unpin this message' })).not.toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    renderPins({ open: false });
    expect(screen.queryByText('Haz 5 runs from 9.')).not.toBeInTheDocument();
  });
});

describe('PinnedMessagesOverlay as a sheet of its own', () => {
  it('is a named dialog with the same list', () => {
    renderPins({ presentation: 'overlay' });
    expect(screen.getByRole('dialog', { name: 'Pinned messages' })).toBeInTheDocument();
    expect(screen.getByText('Haz 5 runs from 9.')).toBeInTheDocument();
  });
});
