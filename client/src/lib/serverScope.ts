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

/**
 * Canonical form of a server base URL, for deciding whether two spellings name
 * the same host: lower-cased host, `localhost` folded onto `127.0.0.1`, no
 * trailing slash. Ports and paths are significant — two Paracord instances on
 * one machine are two servers.
 */
export function canonicalServerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase() === 'localhost'
      ? '127.0.0.1'
      : parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${hostname}${port}${pathname}`;
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export function sameServerUrl(left: string, right: string): boolean {
  return canonicalServerUrl(left) === canonicalServerUrl(right);
}
