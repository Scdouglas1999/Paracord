import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteApi } from '../../api/invites';
import { writeClipboardText } from '../../lib/clipboard';
import { InviteModal } from './InviteModal';

vi.mock('../../api/invites', () => ({
  inviteApi: {
    create: vi.fn(),
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

  it('sends explicit zero values for never-expiring unlimited invites', async () => {
    const user = userEvent.setup();

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    await waitFor(() => expect(inviteApi.create).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Expire After'), 'never');
    await user.selectOptions(screen.getByLabelText('Max Uses'), 'unlimited');

    await waitFor(() => {
      expect(inviteApi.create).toHaveBeenLastCalledWith('channel-1', {
        max_age: 0,
        max_uses: 0,
      });
    });
  });
});
