import { getApi } from './activeClient';

export interface BotApplication {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  bot_user_id: string;
  redirect_uri: string | null;
  permissions: string;
  intents: number;
  created_at: string;
  updated_at: string;
  token?: string;
}

export interface BotGuildInstall {
  bot_app_id: string;
  guild_id: string;
  added_by: string | null;
  permissions: string;
  created_at: string;
}

export interface GuildBotEntry {
  application: BotApplication;
  install: BotGuildInstall;
}

export interface PublicBotApplication {
  id: string;
  name: string;
  description: string | null;
  bot_user_id: string;
  permissions: string;
  redirect_uri: string | null;
  created_at: string;
  updated_at: string;
  bot_user: {
    id: string;
    username: string;
    discriminator: string | number;
    avatar_hash: string | null;
    bot: boolean;
  } | null;
}

interface CreateBotRequest {
  name: string;
  description?: string;
  redirect_uri?: string;
  permissions?: string;
}

interface UpdateBotRequest {
  name?: string;
  description?: string;
  redirect_uri?: string;
  permissions?: string;
  intents?: number;
}

export const botApi = {
  list: () => getApi().get<BotApplication[]>('/bots/applications'),
  create: (data: CreateBotRequest) =>
    getApi().post<BotApplication>('/bots/applications', data),
  get: (appId: string) =>
    getApi().get<BotApplication>(`/bots/applications/${appId}`),
  getPublic: (appId: string) =>
    getApi().get<PublicBotApplication>(`/bots/applications/${appId}/public`),
  update: (appId: string, data: UpdateBotRequest) =>
    getApi().patch<BotApplication>(`/bots/applications/${appId}`, data),
  delete: (appId: string) =>
    getApi().delete(`/bots/applications/${appId}`),
  regenerateToken: (appId: string) =>
    getApi().post<BotApplication>(`/bots/applications/${appId}/token`),
  listInstalls: (appId: string) =>
    getApi().get<BotGuildInstall[]>(`/bots/applications/${appId}/installs`),

  // Guild bot management
  listGuildBots: (guildId: string) =>
    getApi().get<GuildBotEntry[]>(`/guilds/${guildId}/bots`),
  addBotToGuild: (
    guildId: string,
    data: {
      application_id: string;
      permissions?: string;
      redirect_uri?: string;
      state?: string;
    }
  ) =>
    getApi().post(`/oauth2/authorize`, {
      application_id: data.application_id,
      guild_id: guildId,
      permissions: data.permissions,
      redirect_uri: data.redirect_uri,
      state: data.state,
    }),
  removeBotFromGuild: (guildId: string, botAppId: string) =>
    getApi().delete(`/guilds/${guildId}/bots/${botAppId}`),
};
