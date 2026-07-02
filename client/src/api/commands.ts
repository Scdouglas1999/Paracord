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
  listGlobalCommands: (appId: string) =>
    getApi().get<ApplicationCommand[]>(`/applications/${appId}/commands`),
  createGlobalCommand: (appId: string, data: CreateCommandRequest) =>
    getApi().post<ApplicationCommand>(`/applications/${appId}/commands`, data),
  getGlobalCommand: (appId: string, cmdId: string) =>
    getApi().get<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`),
  updateGlobalCommand: (appId: string, cmdId: string, data: UpdateCommandRequest) =>
    getApi().patch<ApplicationCommand>(`/applications/${appId}/commands/${cmdId}`, data),
  deleteGlobalCommand: (appId: string, cmdId: string) =>
    getApi().delete(`/applications/${appId}/commands/${cmdId}`),
  bulkOverwriteGlobalCommands: (appId: string, commands: CreateCommandRequest[]) =>
    getApi().put<ApplicationCommand[]>(`/applications/${appId}/commands`, commands),

  // Guild commands
  listGuildCommands: (appId: string, guildId: string) =>
    getApi().get<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`),
  createGuildCommand: (appId: string, guildId: string, data: CreateCommandRequest) =>
    getApi().post<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands`, data),
  getGuildCommand: (appId: string, guildId: string, cmdId: string) =>
    getApi().get<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  updateGuildCommand: (appId: string, guildId: string, cmdId: string, data: UpdateCommandRequest) =>
    getApi().patch<ApplicationCommand>(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`, data),
  deleteGuildCommand: (appId: string, guildId: string, cmdId: string) =>
    getApi().delete(`/applications/${appId}/guilds/${guildId}/commands/${cmdId}`),
  bulkOverwriteGuildCommands: (appId: string, guildId: string, commands: CreateCommandRequest[]) =>
    getApi().put<ApplicationCommand[]>(`/applications/${appId}/guilds/${guildId}/commands`, commands),

  // All commands available in a guild (global + guild-specific)
  listGuildAvailableCommands: (guildId: string) =>
    getApi().get<ApplicationCommand[]>(`/guilds/${guildId}/commands`),
};
