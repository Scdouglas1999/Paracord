import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { useGuildStore } from '../../stores/guildStore';
import { useToastStore } from '../../stores/toastStore';
import { writeClipboardText } from '../../lib/clipboard';
import { MemberList, resolveMemberStatus } from './MemberList';

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getRoles: vi.fn(),
  },
}));

vi.mock('../../lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => count * 80,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 80,
        size: estimateSize(index),
      })),
  }),
}));

describe('resolveMemberStatus', () => {
  it('prefers explicit presence status when available', () => {
    expect(resolveMemberStatus('idle', false, false)).toBe('idle');
  });

  it('marks authenticated self member as online when presence is missing', () => {
    expect(resolveMemberStatus(undefined, false, true)).toBe('online');
  });

  it('marks in-voice members as online when presence is missing', () => {
    expect(resolveMemberStatus(undefined, true, false)).toBe('online');
  });

  it('falls back to offline when no signals indicate online', () => {
    expect(resolveMemberStatus(undefined, false, false)).toBe('offline');
  });
});

describe('MemberList context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: 'user-1', username: 'Owner' } as never, token: 'token' });
    useGuildStore.setState({ selectedGuildId: null });
    useToastStore.setState({ toasts: [] });
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  });

  it('shows a toast when copying a member ID fails', async () => {
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));
    render(React.createElement(MemberList, {
      members: [
        {
          user_id: 'member-1',
          username: 'Ada',
          avatar_hash: null,
          nick: null,
          roles: [],
          status: 'online',
        },
      ],
      roles: [],
    }));

    fireEvent.contextMenu(screen.getByRole('button', { name: /Ada/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy ID' }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('member-1');
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to copy member ID: Clipboard permission denied.',
          }),
        ]),
      );
    });
  });
});
