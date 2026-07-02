import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emojiApi } from '../../api/emojis';
import { EmojiPicker } from './EmojiPicker';

vi.mock('../../api/emojis', () => ({
  emojiApi: {
    listGuild: vi.fn(),
  },
}));

vi.mock('../../lib/apiBaseUrl', () => ({
  resolveApiBaseUrl: () => '/api/v1',
  resolveResourceUrl: (path: string, token?: string | null) =>
    token ? `/api/v1/${path}?token=${encodeURIComponent(token)}` : `/api/v1/${path}`,
}));

const listGuild = vi.mocked(emojiApi.listGuild);
const emojiResponse = (data: Awaited<ReturnType<typeof emojiApi.listGuild>>['data']) =>
  ({ data }) as Awaited<ReturnType<typeof emojiApi.listGuild>>;

describe('EmojiPicker server emojis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('loads, filters, and inserts animated custom emoji tokens', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    listGuild.mockResolvedValue(
      emojiResponse([
        {
          id: '2001',
          guild_id: 'g1',
          name: 'party_parrot',
          animated: true,
          creator_id: null,
          created_at: '2026-05-17T00:00:00Z',
        },
        {
          id: '2002',
          guild_id: 'g1',
          name: 'ship_it',
          animated: false,
          creator_id: null,
          created_at: '2026-05-17T00:00:00Z',
        },
      ]),
    );

    render(<EmojiPicker guildId="g1" onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByText('Server Emojis'));
    expect(await screen.findByRole('button', { name: /party_parrot/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ship_it/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search server emojis...'), {
      target: { value: 'party' },
    });

    expect(screen.queryByRole('button', { name: /ship_it/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /party_parrot/ }));

    expect(onSelect).toHaveBeenCalledWith('<a:party_parrot:2001>');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refreshes server emojis after a matching gateway emoji-change event', async () => {
    listGuild
      .mockResolvedValueOnce(emojiResponse([]))
      .mockResolvedValueOnce(
        emojiResponse([
          {
            id: '2003',
            guild_id: 'g1',
            name: 'new_static',
            animated: false,
            creator_id: null,
            created_at: '2026-05-17T00:00:00Z',
          },
        ]),
      );

    render(<EmojiPicker guildId="g1" onSelect={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(listGuild).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new CustomEvent('paracord:emojis-changed', { detail: { guild_id: 'g1' } }));
    });

    await waitFor(() => expect(listGuild).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText('Server Emojis'));

    expect(await screen.findByRole('button', { name: /new_static/ })).toBeInTheDocument();
  });
});
