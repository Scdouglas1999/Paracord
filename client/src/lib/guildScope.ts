import type { Guild } from '../types';
import { entityScopeKey, type AccountScope } from './serverScope';

export interface GuildReference { id: string; scope: AccountScope }
export interface ScopedGuild extends Guild, GuildReference { key: string; originServerId: string }

export function findScopedGuild(guilds: ScopedGuild[], scope: AccountScope | null, id: string | null | undefined) {
  if (!scope || !id) return undefined;
  const key = entityScopeKey(scope, id);
  return guilds.find(guild => guild.key === key);
}
