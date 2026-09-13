/** Explicit operator/account disconnects; transport reconnects do not publish here. */
const listeners = new Set<(serverId: string) => void>();

export function subscribeServerDisconnect(listener: (serverId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyServerDisconnected(serverId: string): void {
  for (const listener of [...listeners]) listener(serverId);
}
