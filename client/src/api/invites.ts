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

export type ShareReach = 'internet' | 'local_network' | 'this_computer' | 'unknown';

/** What the server says it can be reached as. `url` is an origin, no trailing slash. */
export interface ShareAddress {
  url: string | null;
  reach: ShareReach;
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
