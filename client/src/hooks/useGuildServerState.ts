import { readPlaceMemory } from '../components/ix/people/lastPlace';
import { useGuildStore } from '../stores/guildStore';
import { useServerConnectionPhase, type ServerConnectionState } from '../stores/serverConnectionStore';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';

/**
 * The saved server a server place (a guild) is on, and where its connection stands.
 *
 * For a place you cannot see yet: the server's own record when its list has arrived,
 * else the last-place memory (a launch, before any list has), else the server you were
 * last active on. Null when none of those names a saved server (the home session's own
 * places, in the browser).
 */
export function useGuildServerState(guildId: string | undefined): { server: ServerEntry; state: ServerConnectionState | null } | null {
  const fromList = useGuildStore((store) => (guildId ? store.guilds.find((guild) => guild.id === guildId)?.scope.serverId ?? null : null));
  const activeServerId = useServerListStore((store) => store.activeServerId);
  let serverId = fromList;
  if (!serverId && guildId) {
    const memory = readPlaceMemory();
    serverId = memory && memory.place === guildId && memory.serverId ? memory.serverId : activeServerId;
  }
  const server = useServerListStore((store) => (serverId ? store.servers.find((entry) => entry.id === serverId) : undefined));
  const state = useServerConnectionPhase(server?.id);
  return server ? { server, state } : null;
}
