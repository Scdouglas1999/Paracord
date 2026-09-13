import type { Channel } from '../types';
import { entityScopeKey, type AccountScope } from './serverScope';

export interface ChannelReference { id: string; scope: AccountScope }
export interface ScopedChannel extends Channel, ChannelReference { key: string }
export const EMPTY_CHANNELS: ScopedChannel[] = [];
export function scopeChannel(channel: Channel, scope: AccountScope): ScopedChannel {
  return { ...channel, scope: { ...scope }, key: entityScopeKey(scope, channel.id) };
}
export function findScopedChannel(channels: Record<string, ScopedChannel>, scope: AccountScope | null, id: string | null | undefined) {
  return scope && id ? channels[entityScopeKey(scope, id)] : undefined;
}
