import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../api/guilds';
import { StickerPicker } from './StickerPicker';

vi.mock('../../api/guilds', () => ({
  guildApi: {
    listStickers: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  extractApiError: vi.fn((err: { response?: { data?: { error?: string; message?: string } }; message?: string }) =>
    err?.response?.data?.message || err?.response?.data?.error || err?.message || 'request failed',
  ),
}));

vi.mock('../../lib/config/apiBaseUrl', () => ({
  resolveResourceUrl: (url: string) => `/resolved${url}`,
}));

vi.mock('../../lib/authToken', () => ({
  getAccessToken: () => 'test-token',
}));

const listStickers = vi.mocked(guildApi.listStickers);
const stickerResponse = (data: Awaited<ReturnType<typeof guildApi.listStickers>>['data']) =>
  ({ data }) as Awaited<ReturnType<typeof guildApi.listStickers>>;

describe('StickerPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads server stickers, filters by name, and selects a sticker', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    listStickers.mockResolvedValue(
      stickerResponse([
        {
          id: '1001',
          guild_id: 'g1',
          name: 'party_blob',
          description: null,
          format_type: 1,
          creator_id: null,
          image_url: '/api/v1/guilds/g1/stickers/1001/image',
          created_at: '2026-05-17T00:00:00Z',
        },
        {
          id: '1002',
          guild_id: 'g1',
          name: 'ship_it',
          description: null,
          format_type: 1,
          creator_id: null,
          image_url: null,
          created_at: '2026-05-17T00:00:00Z',
        },
      ]),
    );

    render(<StickerPicker guildId="g1" onSelect={onSelect} onClose={onClose} />);

    expect(await screen.findByRole('button', { name: 'Select sticker party_blob' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select sticker ship_it' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search stickers...'), 'ship');

    expect(screen.queryByRole('button', { name: 'Select sticker party_blob' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select sticker ship_it' }));

    expect(onSelect).toHaveBeenCalledWith('1002');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an empty state when the selected server has no stickers', async () => {
    listStickers.mockResolvedValue(stickerResponse([]));

    render(<StickerPicker guildId="g1" onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText('This server has no stickers yet.')).toBeInTheDocument();
  });

  it('falls back to the sticker name for unsafe image URLs', async () => {
    listStickers.mockResolvedValue(
      stickerResponse([
        {
          id: '1001',
          guild_id: 'g1',
          name: 'unsafe_sticker',
          description: null,
          format_type: 1,
          creator_id: null,
          image_url: 'javascript:alert(1)',
          created_at: '2026-05-17T00:00:00Z',
        },
      ]),
    );

    const { container } = render(<StickerPicker guildId="g1" onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Select sticker unsafe_sticker' })).toBeInTheDocument();
    expect(screen.getByText('unsafe_sticker')).toBeInTheDocument();
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('shows a retryable load failure with API details and closes on outside click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    listStickers
      .mockRejectedValueOnce({
        response: { data: { message: 'Sticker service is offline.' } },
      })
      .mockResolvedValue(stickerResponse([]));

    render(
      <div>
        <button type="button">Outside</button>
        <StickerPicker guildId="g1" onSelect={vi.fn()} onClose={onClose} />
      </div>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load stickers: Sticker service is offline.',
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('This server has no stickers yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
