import { getApi } from './activeClient';
import type {
  ResolvedCommandOption,
  Interaction,
  InteractionResponse,
  InteractionCallbackData,
  InteractionType,
} from '../types/interactions';

export interface InvokeCommandRequest {
  command_name: string;
  guild_id: string;
  channel_id: string;
  options?: ResolvedCommandOption[];
  /** Defaults to ApplicationCommand (2). Use 4 for autocomplete. */
  type?: InteractionType;
}

export const interactionApi = {
  invokeCommand: async (data: InvokeCommandRequest) =>
    getApi().post<Interaction>('/interactions', data),
  respondToInteraction: async (interactionId: string, token: string, response: InteractionResponse) =>
    getApi().post(`/interactions/${interactionId}/${token}/callback`, response),
  editOriginalResponse: async (appId: string, token: string, data: Partial<InteractionCallbackData>) =>
    getApi().patch(`/interactions/${appId}/${token}/messages/@original`, data),
  deleteOriginalResponse: async (appId: string, token: string) =>
    getApi().delete(`/interactions/${appId}/${token}/messages/@original`),
  createFollowup: async (appId: string, token: string, data: InteractionCallbackData) =>
    getApi().post(`/interactions/${appId}/${token}/followup`, data),
};
