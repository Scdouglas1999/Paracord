import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteApi } from '../../api/invites';
import { writeClipboardText } from '../../lib/clipboard';
import { InviteModal, isPrivateNetworkOrigin } from './InviteModal';

vi.mock('../../api/invites', () => ({
  inviteApi: {
    create: vi.fn(),
    delete: vi.fn(),
    shareAddress: vi.fn(),
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
    // jsdom lives at http://localhost, which is exactly the owner-on-the-server
    // case: the address bar is no use to a friend, so the server is asked.
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: 'https://203.0.113.7:8443', reach: 'internet' },
    } as never);
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  });

  it('shows an alert and disables copy actions when invite generation fails', async () => {
    vi.mocked(inviteApi.create).mockRejectedValue(new Error('Invite service unavailable.'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to generate invite: Invite service unavailable.',
    );
    expect(screen.getByLabelText('Copy invite link')).toBeDisabled();
    expect(screen.getByLabelText('Copy invite code')).toBeDisabled();
    expect(screen.queryByDisplayValue('Failed to generate invite')).not.toBeInTheDocument();
  });

  it('shows an alert when copying the portable invite link fails', async () => {
    const user = userEvent.setup();
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    await waitFor(() => expect(inviteApi.create).toHaveBeenCalled());
    await user.click(screen.getByLabelText('Copy invite link'));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to copy the invite link: Clipboard permission denied.',
      );
    });
  });

  it('builds the link from what the server says it is reachable as, never from localhost', async () => {
    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue('https://203.0.113.7:8443/invite/abc123')).toBeInTheDocument();
    expect(screen.getByText(/opens in any browser/)).toBeInTheDocument();
  });

  it('says so plainly when only people on the same network can use the link', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: 'https://192.168.1.50:8443', reach: 'local_network' },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue('https://192.168.1.50:8443/invite/abc123')).toBeInTheDocument();
    expect(screen.getByText(/same network \(the same Wi-Fi\)/)).toBeInTheDocument();
  });

  it('points at the setting when the server was installed for the home network only', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: 'https://192.168.1.50:8443', reach: 'local_network', asks_router: false },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(
      await screen.findByText(/turn on “Let friends outside your home network connect” in Admin → Settings/),
    ).toBeInTheDocument();
  });

  it('points at the router when the server asked it and the router said no', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: 'https://192.168.1.50:8443', reach: 'local_network', asks_router: true },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/the router needs a port opened/)).toBeInTheDocument();
    expect(screen.queryByText(/Admin → Settings/)).not.toBeInTheDocument();
  });

  it('offers no link at all rather than one that points at localhost', async () => {
    vi.mocked(inviteApi.shareAddress).mockRejectedValue(new Error('404'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/only be reached from this computer/)).toBeInTheDocument();
    expect(screen.getByLabelText('Copy invite link')).toBeDisabled();
    expect(screen.queryByDisplayValue(/localhost/)).not.toBeInTheDocument();
  });

  it('does not mint a new invite when options change; only on explicit regenerate', async () => {
    const user = userEvent.setup();

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    await waitFor(() => expect(inviteApi.create).toHaveBeenCalledTimes(1));

    // Toggling options must NOT auto-regenerate — that would orphan live invites.
    await user.selectOptions(screen.getByLabelText('Expire after'), 'never');
    await user.selectOptions(screen.getByLabelText('Max uses'), 'unlimited');
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

describe('isPrivateNetworkOrigin', () => {
  it('recognises home-network addresses and nothing else', () => {
    for (const origin of [
      'https://192.168.1.5:8443',
      'https://10.0.0.2',
      'http://172.16.4.1:8090',
      'https://172.31.255.255',
      'https://169.254.1.1',
    ]) {
      expect(isPrivateNetworkOrigin(origin)).toBe(true);
    }
    for (const origin of [
      'https://203.0.113.7:8443',
      'https://172.32.0.1',
      'https://chat.example.com',
      'https://localhost:8443',
      'not a url',
    ]) {
      expect(isPrivateNetworkOrigin(origin)).toBe(false);
    }
  });
});
