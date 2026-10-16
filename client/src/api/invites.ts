import { getApi as getActiveApi } from './activeClient';
import { responseContract } from './responseContracts';
import {
  isGuildInvite,
  isGuildInviteList,
  isInviteAcceptResponse,
  isInvitePreview,
} from './contractValidators';
import type { AcceptInviteRequest } from './generated/AcceptInviteRequest';
import type { CreateInviteRequest } from './generated/CreateInviteRequest';
import type { RestClient } from './restClient';

/**
 * How far a link carries. `internet_unconfirmed`: the network's public
 * address, but nothing has shown people outside get through yet (the router
 * refused or did not answer); `note` says what is in the way. `unknown` with
 * no `url`: no public address is known yet. `local_network` only comes from
 * servers before 4.0, and its home-network `url` is never used as a link.
 */
export type ShareReach = 'internet' | 'internet_unconfirmed' | 'local_network' | 'this_computer' | 'unknown';

/** What may stop people outside from reaching the link. */
export type ShareNote = 'port_not_forwarded' | 'firewall_blocked' | 'carrier_nat' | 'outer_router';

/** Where the address came from: `[server] public_url`, the router, this computer, or a STUN server. */
export type ShareSource = 'configured' | 'router' | 'this_computer' | 'stun';

/** What the server says it can be reached as. `url` is an origin, no trailing slash. */
export interface ShareAddress {
  url: string | null;
  reach: ShareReach;
  /**
   * Whether the server asks the home router to let people outside the network
   * in. Absent on servers before 3.2.
   */
  asks_router?: boolean;
  /** The origin links pointed at before the public address changed. */
  previous_url?: string | null;
  source?: ShareSource;
  note?: ShareNote;
  /** The TCP port that has to reach the server (the one to forward). */
  port?: number;
}

export function createInviteApi(getApi: () => RestClient) {
  return {
  get: async (code: string) =>
    responseContract(getApi().get(`/invites/${code}`), isInvitePreview, 'InvitePreview'),
  accept: async (code: string, data?: AcceptInviteRequest) =>
    responseContract(
      getApi().post(`/invites/${code}`, data ?? {}),
      isInviteAcceptResponse,
      'InviteAcceptResponse',
    ),
  create: async (channelId: string, data?: CreateInviteRequest) =>
    responseContract(
      getApi().post(`/channels/${channelId}/invites`, data),
      isGuildInvite,
      'GuildInvite',
    ),
  delete: async (code: string) => getApi().delete(`/invites/${code}`),
  /** Where an invite link should point, when the address bar is no use. */
  shareAddress: async () => getApi().get<ShareAddress>('/instance/share-address'),
  listGuild: async (guildId: string) =>
    responseContract(
      getApi().get(`/guilds/${guildId}/invites`),
      isGuildInviteList,
      'GuildInviteList',
    ),
  };
}

export const inviteApi = createInviteApi(getActiveApi);
