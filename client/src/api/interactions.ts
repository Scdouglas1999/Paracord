import { apiClient } from './client';
import type { ResolvedCommandOption, Interaction, InteractionResponse, InteractionCallbackData } from '../types/interactions';

export interface InvokeCommandRequest {
  command_name: string;
  guild_id: string;
  channel_id: string;
  options?: ResolvedCommandOption[];
}

export const interactionApi = {
  invokeCommand: (data: InvokeCommandRequest) =>
    apiClient.post<Interaction>('/interactions', data),
  respondToInteraction: (interactionId: string, token: string, response: InteractionResponse) =>
    apiClient.post(`/interactions/${interactionId}/${token}/callback`, response),
  editOriginalResponse: (appId: string, token: string, data: Partial<InteractionCallbackData>) =>
    apiClient.patch(`/interactions/${appId}/${token}/messages/@original`, data),
  deleteOriginalResponse: (appId: string, token: string) =>
    apiClient.delete(`/interactions/${appId}/${token}/messages/@original`),
  createFollowup: (appId: string, token: string, data: InteractionCallbackData) =>
    apiClient.post(`/interactions/${appId}/${token}/followup`, data),
};
