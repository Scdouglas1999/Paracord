import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostInviteShare } from '../../lib/shareAddress';
import { HostInviteStep, type HostInviteView } from './HostInviteStep';

vi.mock('../../lib/clipboard', () => ({ writeClipboardText: vi.fn() }));

afterEach(cleanup);

/** What FirstRunPage's `useHostInvite` builds from the share address and the code. */
function viewFor(share: Parameters<typeof hostInviteShare>[0], code = 'abc123'): HostInviteView {
  const s = hostInviteShare(share);
  return {
    url: s.base ? `${s.base}/invite/${code}` : null,
    noPublicAddress: s.noPublicAddress,
    onlyHere: s.onlyHere,
    addressChanged: s.addressChanged,
    note: s.note,
    maxAge: 604_800,
    maxUses: 25,
    error: null,
  };
}

function renderStep(view: HostInviteView) {
  render(
    <HostInviteStep state="on" serverName="Lantern" view={view} busy={false} onChange={() => {}} onContinue={() => {}} onBack={() => {}} />,
  );
}

describe('Host › Invite', () => {
  it('leads with the public link and says the port is the host\'s to forward', () => {
    renderStep(
      viewFor({
        url: 'https://198.51.100.4:8443',
        reach: 'internet_unconfirmed',
        note: 'port_not_forwarded',
        port: 8443,
        source: 'stun',
      }),
    );
    expect(screen.getByTestId('fr-invite-link')).toHaveTextContent('https://198.51.100.4:8443/invite/abc123');
    expect(screen.getByTestId('fr-outside-note')).toHaveTextContent(
      'People outside your network may not reach this until port 8443 is forwarded on your router.',
    );
    expect(screen.queryByTestId('fr-no-public-note')).not.toBeInTheDocument();
  });

  it('never offers a home-network link: with no public address there is no link, and it says why', () => {
    renderStep(viewFor({ url: null, reach: 'unknown', note: 'outer_router', port: 8443 }));
    expect(screen.getByTestId('fr-invite-link')).toHaveTextContent('No public address yet');
    expect(screen.getByTestId('fr-no-public-note')).toHaveTextContent(
      "Paracord hasn't found this network's public address yet, so there's no link to share. It keeps checking. Another router sits in front of yours",
    );
    expect(screen.queryByText(/192\.168\./)).not.toBeInTheDocument();
    expect(screen.queryByTestId('fr-outside-note')).not.toBeInTheDocument();
  });

  it('a confirmed public link has no warning', () => {
    renderStep(viewFor({ url: 'https://203.0.113.9:8443', reach: 'internet', port: 8443 }));
    expect(screen.queryByTestId('fr-outside-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fr-no-public-note')).not.toBeInTheDocument();
  });
});
