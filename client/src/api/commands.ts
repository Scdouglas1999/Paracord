import { apiClient } from './client';
import type { ApplicationCommand } from '../types/commands';
import type { ApplicationCommandType, CommandOption } from '../types/commands';

export interface CreateCommandRequest {
  name: string;
  description: string;
  options?: CommandOption[];
  type?: ApplicationCommandType;
  default_member_permissions?: string;
  dm_permission?: boolean;
  nsfw?: boolean;
}

export interface UpdateCommandRequest {
  name?: string;
  description?: string;
  options?: CommandOption[];
  default_member_permissions?: string;
  dm_permission?: boolean;
  nsfw?: boolean;
}

export const commandApi = {
  // Global commands
  listGlobalCommands: (appId: string) =>
    apiClient.get<ApplicationCommand[]>(`/applications/${appId}/commands`),
  createGlobalCommand: (appId: string, data: CreateCommandRequest) =>
    apiClient.post<ApplicationCommand>(`/applications/${appId}/commands`, data),
  getGlobalCommand: (appId: string, cmdId: string) =>
    apiClient.get<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`),
  updateGlobalCommand: (appId: string, cmdId: string, data: UpdateCommandRequest) =>
    apiClient.patch<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`, data),
  deleteGlobalCommand: (appId: string, cmdId: string) =>
    apiClient.delete(`/applications/${appId}/commands/${cmdId}`),
  bulkOverwriteGlobalCommands: (appId: string, commands: CreateCommandRequest[]) =>
    apiClient.put<ApplicationCommand[]>(`/applications/${appId}/commands`, commands),

  // Guild commands
  listGuildCommands: (appId: string, guildId: string) =>
    apiClient.get<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`),
  createGuildCommand: (appId: string, guildId: string, data: CreateCommandRequest) =>
    apiClient.post<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands`, data),
  getGuildCommand: (appId: string, guildId: string, cmdId: string) =>
    apiClient.get<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  updateGuildCommand: (appId: string, guildId: string, cmdId: string, data: UpdateCommandRequest) =>
    apiClient.patch<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`, data),
  deleteGuildCommand: (appId: string, guildId: string, cmdId: string) =>
    apiClient.delete(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  bulkOverwriteGuildCommands: (appId: string, guildId: string, commands: CreateCommandRequest[]) =>
    apiClient.put<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`, commands),

  // All commands available in a guild (global + guild-specific)
  listGuildAvailableCommands: (guildId: string) =>
    apiClient.get<ApplicationCommand[]>(`/guilds/${guildId}/commands`),
};
