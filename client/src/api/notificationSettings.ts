import { getApi } from './activeClient';

/** 0 = every message, 1 = only mentions, 2 = nothing. */
export type NotificationLevel = 0 | 1 | 2;

export interface NotificationSetting {
  level: NotificationLevel;
  muted: boolean;
  /** ISO timestamp the mute lapses at, or null when muted indefinitely. */
  muted_until: string | null;
  /**
   * Whether the mute is in force *now*, resolved server-side so a client never
   * has to re-derive whether a timed mute has already lapsed.
   */
  muted_now: boolean;
  suppress_everyone: boolean;
}

export interface SpaceNotificationSetting extends NotificationSetting {
  space_id: string;
}

export interface ChannelNotificationSetting extends NotificationSetting {
  channel_id: string;
}

export interface NotificationSettingsResponse {
  spaces: SpaceNotificationSetting[];
  channels: ChannelNotificationSetting[];
}

export interface UpdateNotificationSettings {
  level?: NotificationLevel;
  muted?: boolean;
  /** Seconds until the mute lapses. Omit for an indefinite mute. */
  mute_duration_seconds?: number;
  suppress_everyone?: boolean;
}

export const notificationSettingsApi = {
  /**
   * Every override the current user holds, both scopes, in one request — the
   * sidebar needs all of it before it can render.
   */
  async list(): Promise<NotificationSettingsResponse> {
    const { data } = await getApi().get<NotificationSettingsResponse>(
      '/users/@me/notification-settings',
    );
    return data;
  },

  async setSpace(
    guildId: string,
    body: UpdateNotificationSettings,
  ): Promise<SpaceNotificationSetting> {
    const { data } = await getApi().put<SpaceNotificationSetting>(
      `/guilds/${guildId}/notification-settings`,
      body,
    );
    return data;
  },

  async clearSpace(guildId: string): Promise<void> {
    await getApi().delete(`/guilds/${guildId}/notification-settings`);
  },

  async setChannel(
    channelId: string,
    body: UpdateNotificationSettings,
  ): Promise<ChannelNotificationSetting> {
    const { data } = await getApi().put<ChannelNotificationSetting>(
      `/channels/${channelId}/notification-settings`,
      body,
    );
    return data;
  },

  async clearChannel(channelId: string): Promise<void> {
    await getApi().delete(`/channels/${channelId}/notification-settings`);
  },
};
