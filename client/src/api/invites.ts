import { getApi } from './activeClient';
import type { Invite, Guild, CreateInviteRequest, InviteAcceptResponse } from '../types';

export const inviteApi = {
  get: (code: string) => getApi().get<Invite>(`/invites/${code}`),
  accept: (
    code: string,
    data?: {
      verification_ack?: boolean;
      verification_answers?: string[];
    },
  ) => getApi().post<InviteAcceptResponse | Guild>(`/invites/${code}`, data ?? {}),
  create: (channelId: string, data?: CreateInviteRequest) =>
    getApi().post<Invite>(`/channels/${channelId}/invites`, data),
  delete: (code: string) => getApi().delete(`/invites/${code}`),
};
