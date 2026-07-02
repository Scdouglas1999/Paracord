import { apiClient } from './client';
import type { Invite, Guild, CreateInviteRequest, InviteAcceptResponse } from '../types';

export const inviteApi = {
  get: (code: string) => apiClient.get<Invite>(`/invites/${code}`),
  accept: (
    code: string,
    data?: {
      verification_ack?: boolean;
      verification_answers?: string[];
    },
  ) => apiClient.post<InviteAcceptResponse | Guild>(`/invites/${code}`, data ?? {}),
  create: (channelId: string, data?: CreateInviteRequest) =>
    apiClient.post<Invite>(`/channels/${channelId}/invites`, data),
  delete: (code: string) => apiClient.delete(`/invites/${code}`),
};
