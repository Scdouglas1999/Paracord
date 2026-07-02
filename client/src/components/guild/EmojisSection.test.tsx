import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojisSection } from './GuildSettingsSections';
import type { GuildEmoji } from '../../types';

vi.mock('../../lib/customEmoji', () => ({
  buildGuildEmojiImageUrl: (guildId: string, emojiId: string) => `/guilds/${guildId}/emojis/${emojiId}/image`,
}));

const baseEmoji: GuildEmoji = {
  id: '2001',
  guild_id: 'g1',
  name: 'ship_it',
  animated: false,
  creator_id: null,
  created_at: '2026-05-17T00:00:00Z',
};

function renderSection(overrides: Partial<React.ComponentProps<typeof EmojisSection>> = {}) {
  const props: React.ComponentProps<typeof EmojisSection> = {
    guildId: 'g1',
    emojis: [baseEmoji],
    canManage: true,
    newEmojiName: '',
    newEmojiFile: null,
    editingEmojiId: null,
    editingEmojiName: '',
    onNewEmojiNameChange: vi.fn(),
    onNewEmojiFileChange: vi.fn(),
    onEditingEmojiNameChange: vi.fn(),
    onCreateEmoji: vi.fn(),
    onStartEditingEmoji: vi.fn(),
    onSaveEmojiName: vi.fn(),
    onCancelEditingEmoji: vi.fn(),
    onDeleteEmoji: vi.fn(),
    ...overrides,
  };

  return {
    ...render(<EmojisSection {...props} />),
    props,
  };
}

describe('EmojisSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders read-only emoji state for members without Manage Emojis', () => {
    renderSection({ canManage: false });

    expect(screen.getByText(/Manage Emojis permission is required/)).toBeInTheDocument();
    expect(screen.getByText('ship_it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('validates emoji file type and size before accepting an upload', async () => {
    const { container, props } = renderSection();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const textFile = new File(['hello'], 'emoji.txt', { type: 'text/plain' });
    fireEvent.change(input!, { target: { files: [textFile] } });
    expect(props.onNewEmojiFileChange).toHaveBeenLastCalledWith(
      null,
      'Only PNG and GIF emoji files are supported.',
    );

    const largePng = new File([new Uint8Array(256 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    fireEvent.change(input!, { target: { files: [largePng] } });
    expect(props.onNewEmojiFileChange).toHaveBeenLastCalledWith(null, 'Emoji image must be 256 KB or less.');

    const validGif = new File(['gif'], 'party.gif', { type: 'image/gif' });
    fireEvent.change(input!, { target: { files: [validGif] } });
    expect(props.onNewEmojiFileChange).toHaveBeenLastCalledWith(validGif);
  });

  it('submits upload fields and emoji management actions', async () => {
    const user = userEvent.setup();
    const { props } = renderSection();

    fireEvent.change(screen.getByLabelText('New emoji name'), { target: { value: 'party_blob' } });
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(props.onNewEmojiNameChange).toHaveBeenLastCalledWith('party_blob');
    expect(props.onCreateEmoji).toHaveBeenCalledTimes(1);
    expect(props.onStartEditingEmoji).toHaveBeenCalledWith(baseEmoji);
    expect(props.onDeleteEmoji).toHaveBeenCalledWith('2001');
  });

  it('saves and cancels emoji rename from keyboard', () => {
    const { props } = renderSection({
      editingEmojiId: '2001',
      editingEmojiName: 'ship_it_now',
    });
    const input = screen.getByLabelText('Rename emoji ship_it');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSaveEmojiName).toHaveBeenCalledWith('2001');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onCancelEditingEmoji).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no custom emojis are uploaded', () => {
    renderSection({ emojis: [] });

    expect(screen.getByText('No custom emojis uploaded yet.')).toBeInTheDocument();
  });
});
