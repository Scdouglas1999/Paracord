import type { Activity } from '../types';
import { gateway } from './manager';

export class GatewayClient {
  constructor(private readonly serverId: string) {}

  connect(): Promise<void> {
    return gateway.connectServer(this.serverId);
  }

  disconnect(): void {
    gateway.disconnectServer(this.serverId);
  }

  updatePresence(
    status: string,
    activities: Activity[] = [],
    customStatus: string | null = null,
  ): void {
    gateway.updatePresence(this.serverId, status, activities, customStatus);
  }

  updateVoiceState(
    guildId: string | null,
    channelId: string | null,
    selfMute: boolean,
    selfDeaf: boolean,
  ): void {
    gateway.updateVoiceState(this.serverId, guildId, channelId, selfMute, selfDeaf);
  }
}

