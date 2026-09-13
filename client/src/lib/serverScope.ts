/** The home server is an explicit scope, never an alias for a missing remote. */
export const LOCAL_SERVER_ID = '__local__';

export interface AccountScope {
  readonly serverId: string;
  readonly userId: string;
}

/** JSON tuple encoding avoids delimiter and snowflake collisions. */
export function accountScopeKey(scope: AccountScope): string {
  return JSON.stringify([scope.serverId, scope.userId]);
}

export function entityScopeKey(scope: AccountScope, entityId: string): string {
  return JSON.stringify([scope.serverId, scope.userId, entityId]);
}

export function entityKeyBelongsToScope(key: string, scope: AccountScope): boolean {
  return key.startsWith(`${accountScopeKey(scope).slice(0, -1)},`);
}
