import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteApi } from '../../api/invites';
import { writeClipboardText } from '../../lib/clipboard';
import { InviteModal } from './InviteModal';

vi.mock('../../api/invites', () => ({
  inviteApi: {
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}));

describe('InviteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(inviteApi.create).mockResolvedValue({
      data: {
        code: 'abc123',
      },
    } as never);
    vi.mocked(inviteApi.delete).mockResolvedValue(undefined as never);
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  });

  it('shows an alert and disables copy actions when invite generation fails', async () => {
    vi.mocked(inviteApi.create).mockRejectedValue(new Error('Invite service unavailable.'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to generate invite: Invite service unavailable.',
    );
    expect(screen.getByLabelText('Copy portable invite link')).toBeDisabled();
    expect(screen.getByLabelText('Copy invite code')).toBeDisabled();
    expect(screen.queryByDisplayValue('Failed to generate invite')).not.toBeInTheDocument();
  });

  it('shows an alert when copying the portable invite link fails', async () => {
    const user = userEvent.setup();
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    await waitFor(() => expect(inviteApi.create).toHaveBeenCalled());
    await user.click(screen.getByLabelText('Copy portable invite link'));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to copy portable invite link: Clipboard permission denied.',
      );
    });
  });

  it('does not mint a new invite when options change; only on explicit regenerate', async () => {
    const user = userEvent.setup();

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    await waitFor(() => expect(inviteApi.create).toHaveBeenCalledTimes(1));

    // Toggling options must NOT auto-regenerate — that would orphan live invites.
    await user.selectOptions(screen.getByLabelText('Expire After'), 'never');
    await user.selectOptions(screen.getByLabelText('Max Uses'), 'unlimited');
    expect(inviteApi.create).toHaveBeenCalledTimes(1);

    // Explicit regenerate applies the new options to a fresh invite...
    vi.mocked(inviteApi.create).mockResolvedValueOnce({ data: { code: 'def456' } } as never);
    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    await waitFor(() => {
      expect(inviteApi.create).toHaveBeenCalledTimes(2);
      expect(inviteApi.create).toHaveBeenLastCalledWith('channel-1', {
        max_age: 0,
        max_uses: 0,
      });
    });

    // ...and revokes the previously-minted invite so it can't be reused.
    await waitFor(() => expect(inviteApi.delete).toHaveBeenCalledWith('abc123'));
  });
});
