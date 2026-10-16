import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('is a dialog of the card size, titled for the server, with Copy as the one primary button', async () => {
    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Invite people to Launch Guild' });
    // Max 440 wide (§6.12), at the confirm's size.
    expect(dialog).toHaveClass('max-w-[440px]', 'pc-dialog');
    await screen.findByDisplayValue('https://203.0.113.7:8443/invite/abc123');
    const primary = within(dialog).getAllByRole('button').filter((button) => button.className.includes('bg-accent-primary'));
    expect(primary.map((button) => button.getAttribute('aria-label'))).toEqual(['Copy invite link']);
  });

  describe('copy feedback (§5.16)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('crossfades the label to "Link copied" and back after two seconds', async () => {
      render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);
      await screen.findByDisplayValue('https://203.0.113.7:8443/invite/abc123');
      const button = screen.getByRole('button', { name: 'Copy invite link' });
      const words = () => Array.from(button.querySelectorAll('.ix-copy > span'));
      // Both words are in the button at all times; one is lit.
      expect(words().map((word) => word.textContent?.trim())).toEqual(['Copy link', 'Link copied']);
      expect(words().map((word) => word.getAttribute('data-on'))).toEqual(['true', 'false']);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(button);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Invite link copied' })).toBeInTheDocument();
      expect(words().map((word) => word.getAttribute('data-on'))).toEqual(['false', 'true']);
      expect(writeClipboardText).toHaveBeenCalledWith('https://203.0.113.7:8443/invite/abc123');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
      expect(words().map((word) => word.getAttribute('data-on'))).toEqual(['true', 'false']);
    });
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

  it('never offers a home-network address as the link', async () => {
    // An older server answers with its home-network address: that reaches
    // nobody an invite is for, so there is no link, and the note says why.
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: 'https://192.168.1.50:8443', reach: 'local_network' },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/hasn't found this network's public address yet/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/192\.168\./)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Copy invite link')).toBeDisabled();
  });

  it('uses the public address before the router confirms it and says what is missing', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: {
        url: 'https://198.51.100.4:8443',
        reach: 'internet_unconfirmed',
        source: 'stun',
        note: 'port_not_forwarded',
        port: 8443,
        asks_router: true,
      },
    } as never);
    const user = userEvent.setup();

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue('https://198.51.100.4:8443/invite/abc123')).toBeInTheDocument();
    expect(screen.getByTestId('invite-reach-note')).toHaveTextContent(
      'People outside your network may not reach this until port 8443 is forwarded on your router.',
    );
    expect(screen.queryByLabelText('Link on this network')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(writeClipboardText).toHaveBeenCalledWith('https://198.51.100.4:8443/invite/abc123');
  });

  it('says plainly when the provider shares the public address', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: {
        url: 'https://198.51.100.4:8443',
        reach: 'internet_unconfirmed',
        note: 'carrier_nat',
        port: 8443,
      },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/Your internet provider shares this public address with other customers/)).toBeInTheDocument();
  });

  it('points at the setting when the server was installed for the home network only', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: null, reach: 'unknown', asks_router: false },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(
      await screen.findByText(/turn on “Let friends outside your home network connect” in Admin → Settings/),
    ).toBeInTheDocument();
  });

  it('names what is in the way when there is no public address yet', async () => {
    vi.mocked(inviteApi.shareAddress).mockResolvedValue({
      data: { url: null, reach: 'unknown', asks_router: true, note: 'outer_router', port: 8443 },
    } as never);

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/Another router sits in front of yours/)).toBeInTheDocument();
    expect(screen.queryByText(/Admin → Settings/)).not.toBeInTheDocument();
  });

  it('offers no link at all rather than one that points at localhost', async () => {
    vi.mocked(inviteApi.shareAddress).mockRejectedValue(new Error('404'));

    render(<InviteModal guildName="Launch Guild" channelId="channel-1" onClose={vi.fn()} />);

    // An older server cannot say what its public address is.
    expect(await screen.findByText(/hasn't found this network's public address yet/)).toBeInTheDocument();
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
  it('recognizes home-network addresses and nothing else', () => {
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
