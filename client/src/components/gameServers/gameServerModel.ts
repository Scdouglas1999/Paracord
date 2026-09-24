import type { GameServer, GameServerKind, GameServerState, GameServerStatus } from '../../api/gameServers';

export interface GameKindMeta {
  label: string;
  /** In rows, after the address. */
  short: string;
  /** One line on the type picker. */
  blurb: string;
  /** The port a bare host means; null when there is none. */
  defaultPort: number | null;
  hostPlaceholder: string;
  hint: string;
}

export const GAME_KIND_META: Record<GameServerKind, GameKindMeta> = {
  minecraft_java: {
    label: 'Minecraft: Java Edition',
    short: 'Minecraft Java',
    blurb: 'Players, version and message of the day.',
    defaultPort: 25565,
    hostPlaceholder: 'play.example.com',
    hint: 'The address players type in Multiplayer. SRV-only addresses need the real host and port.',
  },
  minecraft_bedrock: {
    label: 'Minecraft: Bedrock Edition',
    short: 'Minecraft Bedrock',
    blurb: 'Player count, world and version.',
    defaultPort: 19132,
    hostPlaceholder: 'bedrock.example.com',
    hint: 'The address and port players add under Servers.',
  },
  source: {
    label: 'Source / Steam games',
    short: 'Steam',
    blurb: "Counter-Strike 2, Team Fortress 2, Garry's Mod, Rust, Valheim, ARK and more.",
    defaultPort: 27015,
    hostPlaceholder: '203.0.113.10',
    hint: "Use the server's query port. For most games it is the game port; Valheim's is one higher.",
  },
  tcp: {
    label: 'Other',
    short: 'Port check',
    blurb: 'Any game: checks that its port accepts connections.',
    defaultPort: null,
    hostPlaceholder: 'game.example.com',
    hint: 'Up means the port accepts a connection. Players and map are not shown.',
  },
};

export function gameKindMeta(kind: string): GameKindMeta {
  return GAME_KIND_META[kind as GameServerKind] ?? GAME_KIND_META.tcp;
}

/**
 * Split what someone typed or pasted into host and port. A pasted
 * `host:port` fills both fields; `[v6]:port` and bare IPv6 work too.
 */
export function splitAddress(raw: string): { host: string; port: string | null } {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d*))?$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ?? null };
  if ((value.match(/:/g) ?? []).length > 1) return { host: value, port: null };
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { host: value, port: null };
  return { host: value.slice(0, colon), port: value.slice(colon + 1) };
}

/** `host:port`, with an IPv6 host in brackets. */
export function joinAddress(host: string, port: string): string {
  const cleanHost = host.trim();
  const cleanPort = port.trim();
  if (!cleanPort) return cleanHost;
  return cleanHost.includes(':') ? `[${cleanHost}]:${cleanPort}` : `${cleanHost}:${cleanPort}`;
}

/** A quick check before asking the instance. A sentence, or null when it looks right. */
export function addressProblem(host: string, port: string, kind: GameServerKind): string | null {
  const cleanHost = host.trim();
  const cleanPort = port.trim();
  if (!cleanHost) return null;
  if (/:\/\/|\//.test(cleanHost)) return 'Type just the host, like play.example.com.';
  if (/\s/.test(cleanHost)) return 'Remove the gaps from the address.';
  if (!cleanPort) {
    return GAME_KIND_META[kind].defaultPort === null ? 'This type needs a port.' : null;
  }
  const number = Number(cleanPort);
  if (!/^\d+$/.test(cleanPort) || number < 1 || number > 65535) return 'A port is a number from 1 to 65535.';
  return null;
}

/** `steam://connect/…` for a Steam game; Minecraft and others are copy-only. */
export function connectUrl(server: Pick<GameServer, 'kind' | 'address'>): string | null {
  return server.kind === 'source' ? `steam://connect/${server.address}` : null;
}

/** "5/20 online", or what is known of it. */
export function playersLabel(status: GameServerStatus): string | null {
  if (status.state !== 'up') return null;
  const online = status.players_online;
  const max = status.players_max;
  if (online == null) return null;
  return max != null ? `${online}/${max} online` : `${online} online`;
}

const STATE_WORDS: Record<GameServerState, string> = {
  up: 'Up',
  down: 'Down',
  checking: 'Checking…',
};

export function stateLabel(state: GameServerState): string {
  return STATE_WORDS[state] ?? 'Checking…';
}

/** The one line under a server's name: players and map, or why it is down. */
export function summaryLine(status: GameServerStatus): string {
  if (status.state === 'checking') return 'Checking…';
  if (status.state === 'down') return 'Down';
  const parts = [playersLabel(status) ?? 'Up', status.map].filter(Boolean);
  return parts.join(' · ');
}

/** How many are up. */
export function upCount(servers: readonly GameServer[]): number {
  return servers.filter((server) => server.status.state === 'up').length;
}

/** "Down since 2 h ago" style ages, for the settings rows. */
export function ageLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The detail line in Server settings. */
export function detailLine(status: GameServerStatus, now: number = Date.now()): { text: string; tone: 'ok' | 'error' | 'muted' } {
  if (status.state === 'checking') return { text: 'Waiting for the first check', tone: 'muted' };
  if (status.state === 'down') {
    const seen = ageLabel(status.last_seen_online, now);
    const reason = status.error ?? 'Not answering.';
    return { text: seen ? `${reason} Last up ${seen}.` : reason, tone: 'error' };
  }
  const parts = [
    playersLabel(status),
    status.map,
    status.version,
    status.latency_ms != null ? `${status.latency_ms} ms` : null,
  ].filter(Boolean);
  const checked = ageLabel(status.last_checked_at, now);
  if (checked) parts.push(`checked ${checked}`);
  return { text: parts.join(' · ') || 'Up', tone: 'ok' };
}

/** One or two letters for a player's chip. */
export function playerInitials(name: string): string {
  const clean = name.replace(/^[.*]/, '').trim();
  const words = clean.split(/[\s_\-.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? clean;
  const capitals = word.slice(1).match(/[A-Z]/);
  if (capitals) return (word[0] + capitals[0]).toUpperCase();
  return word.slice(0, 2).toUpperCase() || '?';
}
