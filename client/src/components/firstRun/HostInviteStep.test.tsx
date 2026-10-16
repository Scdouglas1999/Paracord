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
    localUrl: s.localBase ? `${s.localBase}/invite/${code}` : null,
    lan: s.lan,
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
  it('leads with the outside link, says what is missing, and offers the home link', () => {
    renderStep(
      viewFor({
        url: 'https://198.51.100.4:8443',
        reach: 'internet_unconfirmed',
        local_url: 'https://192.168.1.20:8443',
        note: 'port_not_forwarded',
        port: 8443,
        source: 'stun',
      }),
    );
    expect(screen.getByTestId('fr-invite-link')).toHaveTextContent('https://198.51.100.4:8443/invite/abc123');
    expect(screen.getByTestId('fr-outside-note')).toHaveTextContent(
      'People outside your network may not reach this until port 8443 is forwarded on your router.',
    );
    expect(screen.getByTestId('fr-invite-local-link')).toHaveTextContent('On this network');
    expect(screen.getByTestId('fr-invite-local-link')).toHaveTextContent('https://192.168.1.20:8443/invite/abc123');
    expect(screen.queryByTestId('fr-lan-note')).not.toBeInTheDocument();
  });

  it('home-only links keep their note and name the reason when it is known', () => {
    renderStep(viewFor({ url: 'https://192.168.1.20:8443', reach: 'local_network', note: 'outer_router', port: 8443 }));
    expect(screen.getByTestId('fr-lan-note')).toHaveTextContent(
      "Works on your home network for now. Another router sits in front of yours, so people outside can't reach this until port 8443 is forwarded on both routers.",
    );
    expect(screen.queryByTestId('fr-invite-local-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fr-outside-note')).not.toBeInTheDocument();
  });

  it('a confirmed outside link has no warning', () => {
    renderStep(viewFor({ url: 'https://203.0.113.9:8443', reach: 'internet', local_url: 'https://192.168.1.20:8443', port: 8443 }));
    expect(screen.queryByTestId('fr-outside-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fr-lan-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('fr-invite-local-link')).toBeInTheDocument();
  });
});
