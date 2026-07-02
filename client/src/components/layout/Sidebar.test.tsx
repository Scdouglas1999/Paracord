import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAuthStore } from '../../stores/authStore';
import { useFolderStore } from '../../stores/folderStore';
import { useGuildStore } from '../../stores/guildStore';
import { useToastStore } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';
import { writeClipboardText } from '../../lib/clipboard';
import type { Guild, User } from '../../types';

vi.mock('../../lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}));

vi.mock('../../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => ({
    guildUnreads: new Map(),
    isChannelUnread: new Set(),
    channelMentionCounts: new Map(),
    readStates: [],
  }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: 0n,
    isOwner: true,
    isAdmin: true,
    isLoading: false,
  }),
}));

const user: User = {
  id: 'user-1',
  username: 'Owner',
  discriminator: '0001',
  bot: false,
  system: false,
  flags: 0,
  created_at: '2026-01-01T00:00:00Z',
};

const guild: Guild = {
  id: 'guild-1',
  name: 'Test Guild',
  icon_hash: null,
  owner_id: user.id,
  member_count: 1,
  features: [],
  created_at: '2026-01-01T00:00:00Z',
};

function renderSidebar() {
  render(
    <MemoryRouter initialEntries={['/app']}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar accessibility', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user, token: 'token' });
    useGuildStore.setState({ guilds: [guild], selectedGuildId: null, isLoading: false });
    useFolderStore.setState({
      folders: [
        {
          id: 'folder-1',
          name: 'Focus Folder',
          guildIds: [],
          collapsed: false,
        },
      ],
    });
    useUIStore.setState({ dockPinned: true, connectionStatus: 'connected' });
    useToastStore.setState({ toasts: [] });
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  });

  it('opens the server folder submenu from the keyboard and keeps focus contained', async () => {
    renderSidebar();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Test Guild' }), {
      key: 'F10',
      shiftKey: true,
    });

    const serverMenu = await screen.findByRole('menu', { name: 'Server actions' });
    expect(serverMenu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark As Read' })).toHaveFocus();

    fireEvent.keyDown(serverMenu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Mute Server' })).toHaveFocus();

    fireEvent.keyDown(serverMenu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Copy ID' })).toHaveFocus();

    fireEvent.keyDown(serverMenu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Mark As Read' })).toHaveFocus();

    const addToFolder = screen.getByRole('menuitem', { name: /Add to Folder/i });
    fireEvent.keyDown(addToFolder, { key: 'ArrowRight' });

    const folderMenu = await screen.findByRole('menu', { name: 'Folder choices' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Focus Folder' })).toHaveFocus());

    fireEvent.keyDown(folderMenu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /New Folder/i })).toHaveFocus();

    fireEvent.keyDown(folderMenu, { key: 'ArrowLeft' });
    await waitFor(() => expect(addToFolder).toHaveFocus());
    expect(screen.queryByRole('menu', { name: 'Folder choices' })).not.toBeInTheDocument();
  });

  it('uses dialog semantics and a focus trap for creating folders', async () => {
    renderSidebar();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Test Guild' }), {
      key: 'ContextMenu',
    });

    await screen.findByRole('menu', { name: 'Server actions' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create Folder' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create Folder' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(screen.getByPlaceholderText('Folder name')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Folder' })).not.toBeInTheDocument());
  });

  it('shows a toast when copying a server ID fails', async () => {
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));
    renderSidebar();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Test Guild' }), {
      key: 'ContextMenu',
    });

    await screen.findByRole('menu', { name: 'Server actions' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy ID' }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(guild.id);
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to copy server ID: Clipboard permission denied.',
          }),
        ]),
      );
    });
  });
});
