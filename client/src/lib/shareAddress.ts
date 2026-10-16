import type { ShareAddress } from '../api/invites';

/**
 * The words around an invite link, from what the server says it can be
 * reached as (`GET /instance/share-address`). Shared by the invite dialog, the
 * conversation's "Bring your people" card and the first-run Invite screen, so
 * every place that hands out a link says the same true thing about it.
 */

/** The port named in a note: the server's own word, else the link's, else the default. */
function portOf(share: Pick<ShareAddress, 'port' | 'url'>): number {
  if (typeof share.port === 'number' && share.port > 0) return share.port;
  try {
    const port = share.url ? Number(new URL(share.url).port) : 0;
    if (port > 0) return port;
  } catch {
    /* not a URL: the default below */
  }
  return 8443;
}

/**
 * Why people outside the network may not get through, in one plain sentence,
 * or null when nothing is known to be in the way.
 */
export function shareNoteText(share: Pick<ShareAddress, 'note' | 'port' | 'url' | 'reach'>): string | null {
  const port = portOf(share);
  switch (share.note) {
    case 'port_not_forwarded':
      return `People outside your network may not reach this until port ${port} is forwarded on your router.`;
    case 'firewall_blocked':
      return `People outside your network can't reach this until Windows Firewall allows port ${port}.`;
    case 'carrier_nat':
      return share.reach === 'internet_unconfirmed'
        ? `Your internet provider shares this public address with other customers, so people outside can't reach this server unless the provider gives you an address of your own or forwards port ${port} for you.`
        : `Your internet provider shares its public address with other customers, so people outside can't reach this server unless the provider gives you an address of your own.`;
    case 'outer_router':
      return `Another router sits in front of yours, so people outside can't reach this until port ${port} is forwarded on both routers.`;
    default:
      return null;
  }
}

/** The "On this network" origin, when the link itself is an outside address. */
export function onThisNetworkUrl(share: Pick<ShareAddress, 'url' | 'local_url'>): string | null {
  const local = share.local_url?.replace(/\/+$/, '') || null;
  return local && local !== share.url ? local : null;
}

/** First-run Invite screen fields (§1.13) from a share address. */
export interface HostInviteShare {
  /** The origin the invite link is built on, or null when nobody else can reach the server. */
  base: string | null;
  /** The home-network origin, shown as a second link. */
  localBase: string | null;
  /** The link only reaches the home network. */
  lan: boolean;
  /** Only this computer can reach the server. */
  onlyHere: boolean;
  addressChanged: boolean;
  /** What may stop people outside, when the link is the outside address. */
  note: string | null;
}

export function hostInviteShare(share: ShareAddress): HostInviteShare {
  return {
    base: share.url,
    localBase: onThisNetworkUrl(share),
    lan: share.reach === 'local_network',
    onlyHere: !share.url || share.reach === 'this_computer',
    addressChanged: Boolean(share.previous_url),
    note: share.reach === 'internet_unconfirmed' || share.reach === 'local_network' ? shareNoteText(share) : null,
  };
}
