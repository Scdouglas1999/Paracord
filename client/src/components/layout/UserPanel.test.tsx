import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { UserPanel } from './UserPanel';

const mockClipboard = vi.hoisted(() => ({ writeClipboardText: vi.fn() }));

vi.mock('../../lib/clipboard', () => mockClipboard);

describe('UserPanel accessibility', () => {
  beforeEach(() => {
    vi.mocked(mockClipboard.writeClipboardText).mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
  });

  it('copies the username from the status menu', async () => {
    const userEventInstance = userEvent.setup();
    render(
      <UserPanel
        user={{ id: 'user-1234', username: 'Ada' }}
        navigate={vi.fn()}
        muted={false}
        deafened={false}
        onToggleMute={vi.fn()}
        onToggleDeaf={vi.fn()}
        showAdminDashboard={false}
      />,
    );

    await userEventInstance.click(screen.getByRole('button', { name: 'Status: Online. Change status' }));
    const copyButton = screen.getByRole('menuitem', { name: 'Copy username Ada' });
    copyButton.focus();
    expect(copyButton).toHaveFocus();
    await userEventInstance.click(copyButton);

    expect(mockClipboard.writeClipboardText).toHaveBeenCalledWith('Ada');
  });

  it('shows a toast when username copy fails', async () => {
    const userEventInstance = userEvent.setup();
    mockClipboard.writeClipboardText.mockRejectedValue(new Error('Clipboard permission denied.'));
    render(
      <UserPanel
        user={{ id: 'user-1234', username: 'Ada' }}
        navigate={vi.fn()}
        muted={false}
        deafened={false}
        onToggleMute={vi.fn()}
        onToggleDeaf={vi.fn()}
        showAdminDashboard={false}
      />,
    );

    await userEventInstance.click(screen.getByRole('button', { name: 'Status: Online. Change status' }));
    await userEventInstance.click(screen.getByRole('menuitem', { name: 'Copy username Ada' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to copy username: Clipboard permission denied.',
          }),
        ]),
      );
    });
  });

  it('shows a stable admin dashboard control for admins', () => {
    const navigate = vi.fn();
    render(
      <UserPanel
        user={{ id: 'user-1234', username: 'Ada', flags: 1 }}
        navigate={navigate}
        muted={false}
        deafened={false}
        onToggleMute={vi.fn()}
        onToggleDeaf={vi.fn()}
        showAdminDashboard={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open admin dashboard' }));

    expect(navigate).toHaveBeenCalledWith('/app/admin');
  });
});
