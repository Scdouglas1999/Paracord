import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { UserPanel } from './UserPanel';

describe('UserPanel accessibility', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    useToastStore.setState({ toasts: [] });
  });

  it('copies the username from a named user identity button', () => {
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

    const copyButton = screen.getByRole('button', { name: 'Copy username Ada' });
    copyButton.focus();
    expect(copyButton).toHaveFocus();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('Ada');
  });

  it('shows a toast when username copy fails', async () => {
    writeText.mockRejectedValue(new Error('Clipboard permission denied.'));
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

    fireEvent.click(screen.getByRole('button', { name: 'Copy username Ada' }));

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
