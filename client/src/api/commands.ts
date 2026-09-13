import { getApi } from './activeClient';
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
  listGlobalCommands: async (appId: string) =>
    getApi().get<ApplicationCommand[]>(`/applications/${appId}/commands`),
  createGlobalCommand: async (appId: string, data: CreateCommandRequest) =>
    getApi().post<ApplicationCommand>(`/applications/${appId}/commands`, data),
  getGlobalCommand: async (appId: string, cmdId: string) =>
    getApi().get<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`),
  updateGlobalCommand: async (appId: string, cmdId: string, data: UpdateCommandRequest) =>
    getApi().patch<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`, data),
  deleteGlobalCommand: async (appId: string, cmdId: string) =>
    getApi().delete(`/applications/${appId}/commands/${cmdId}`),
  bulkOverwriteGlobalCommands: async (appId: string, commands: CreateCommandRequest[]) =>
    getApi().put<ApplicationCommand[]>(`/applications/${appId}/commands`, commands),

  // Guild commands
  listGuildCommands: async (appId: string, guildId: string) =>
    getApi().get<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`),
  createGuildCommand: async (appId: string, guildId: string, data: CreateCommandRequest) =>
    getApi().post<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands`, data),
  getGuildCommand: async (appId: string, guildId: string, cmdId: string) =>
    getApi().get<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  updateGuildCommand: async (appId: string, guildId: string, cmdId: string, data: UpdateCommandRequest) =>
    getApi().patch<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`, data),
  deleteGuildCommand: async (appId: string, guildId: string, cmdId: string) =>
    getApi().delete(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  bulkOverwriteGuildCommands: async (appId: string, guildId: string, commands: CreateCommandRequest[]) =>
    getApi().put<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`, commands),

  // All commands available in a guild (global + guild-specific)
  listGuildAvailableCommands: async (guildId: string) =>
    getApi().get<ApplicationCommand[]>(`/guilds/${guildId}/commands`),
};
