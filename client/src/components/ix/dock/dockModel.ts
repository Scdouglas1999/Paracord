import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { VoiceState } from '../../../types';

/**
 * The dock's rules, as pure functions (docs/index-spec.md §4.8, §5.5). Nothing
 * here reads a store or touches the DOM: `useDockEntries` hands in what the
 * stores hold and the tests hand in fixtures.
 *
 * A dock item is a *place*: People first, then each server in the order the
 * client has them. Its key is `placeKey(place)` (`people`, or the server's id),
 * the same key the shell's slide direction and the e2e drivers use.
 */

export const PEOPLE_KEY = 'people';

/** What a place has to say beyond its mark: a white dot, or a white count. */
export interface DockAttention {
  /** Something unread in an unmuted channel (or an unread direct message). */
  unread: boolean;
  /** Mentions (People: also friend requests). A count replaces the dot. */
  mentions: number;
}

export interface DockEntry extends DockAttention {
  /** `placeKey(place)`: `people`, or the server's id. */
  key: string;
  kind: 'people' | 'server';
  name: string;
  /** Amber dot: somebody is in one of the server's voice channels. */
  live: boolean;
  /** The server's stored icon (`icon_hash`, or `icon`); null draws the monogram. */
  icon: string | null;
  /** `guild.hue` when an admin set one; null falls back to the id's. */
  hue: number | null;
  /** People only: pending incoming friend requests, and mentions in direct messages. */
  requests: number;
  dmMentions: number;
}

/* ---- Live ------------------------------------------------------------------- */

/**
 * The servers somebody is in a voice channel of.
 *
 * `voiceStore.channelParticipants` is one map keyed by the bare channel id and
 * filled from every connected server, so a state counts for the server its own
 * `guild_id` names (the same rule `guildLight` uses). A direct message call has
 * no `guild_id` and lights no server.
 */
export function liveGuildIds(
  channelParticipants: ReadonlyMap<string, ReadonlyArray<Pick<VoiceState, 'guild_id'>>>,
): Set<string> {
  const live = new Set<string>();
  for (const states of channelParticipants.values()) {
    for (const state of states) {
      if (state.guild_id) live.add(state.guild_id);
    }
  }
  return live;
}

/* ---- Unread and mentions ---------------------------------------------------- */

/**
 * Attention per server, and People's, from the unified conversation entries
 * (`useUnifiedConversations`, which already drops the signals of a muted server
 * and of a muted channel: "any unmuted channel has unread messages", §4.8).
 *
 * People shows unread direct messages the same way a server shows unread
 * channels, and a friend request counts like a mention: it is addressed to you.
 */
export function dockAttention(
  entries: readonly ConversationEntry[],
  requests: number,
): { guilds: Map<string, DockAttention>; people: DockAttention & { requests: number; dmMentions: number } } {
  const guilds = new Map<string, DockAttention>();
  let dmUnread = false;
  let dmMentions = 0;
  for (const entry of entries) {
    if (entry.guildId) {
      const unread = entry.unread || entry.isThreadReply;
      if (!unread && entry.mentionCount === 0) continue;
      const before = guilds.get(entry.guildId) ?? { unread: false, mentions: 0 };
      guilds.set(entry.guildId, { unread: before.unread || unread, mentions: before.mentions + entry.mentionCount });
    } else {
      if (entry.isDMUnread) dmUnread = true;
      dmMentions += entry.mentionCount;
    }
  }
  return {
    guilds,
    people: { unread: dmUnread, mentions: requests + dmMentions, requests, dmMentions },
  };
}

/** `99+` past 99, so a count never outgrows its chip. */
export function cappedCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/* ---- Words ------------------------------------------------------------------ */

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

/**
 * The item's accessible name: the place, then what it says ("Game Night, live,
 * 2 mentions"; §10: "State lives in names"). The current place says nothing but
 * its name and live (its own rows carry the rest), like its dots.
 */
export function dockLabel(entry: DockEntry, current: boolean): string {
  const parts = [entry.name];
  if (entry.live) parts.push('live');
  if (current) return parts.join(', ');
  if (entry.kind === 'people') {
    if (entry.requests > 0) parts.push(plural(entry.requests, 'friend request', 'friend requests'));
    if (entry.dmMentions > 0) parts.push(plural(entry.dmMentions, 'mention', 'mentions'));
    else if (entry.unread) parts.push('unread');
  } else if (entry.mentions > 0) {
    parts.push(plural(entry.mentions, 'mention', 'mentions'));
  } else if (entry.unread) {
    parts.push('unread');
  }
  return parts.join(', ');
}

/* ---- The one-time ping (§5.5) ----------------------------------------------- */

export interface LiveSnapshot {
  /** The places that were live. */
  live: ReadonlySet<string>;
  /** Every place the dock held (a server that just joined is not an edge). */
  known: ReadonlySet<string>;
}

/**
 * The places that ping now: they went from not live to live between two
 * snapshots while you are not looking at them.
 *
 * Never for the current place, never for a place that was not in the dock before
 * (a server that arrived already live is a first sight, not an event), and never
 * for one that was already live. Nothing before the first snapshot.
 */
export function pingEdges(before: LiveSnapshot | null, after: LiveSnapshot, current: string | null): string[] {
  if (!before) return [];
  const edges: string[] = [];
  for (const key of after.live) {
    if (key !== current && before.known.has(key) && !before.live.has(key)) edges.push(key);
  }
  return edges;
}

/* ---- Moving through the dock -------------------------------------------------- */

/**
 * The next place in the dock order (People, then the servers), wrapping at both
 * ends. From a place that is not in the order, down goes to the first, up to the last.
 */
export function stepPlace(order: readonly string[], current: string | null, delta: -1 | 1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return delta === 1 ? order[0] : order[order.length - 1];
  return order[(at + delta + order.length) % order.length];
}

/** Ctrl+1 is the first server (People is not numbered). */
export function nthServer(order: readonly string[], n: number): string | null {
  const servers = order.filter((key) => key !== PEOPLE_KEY);
  return servers[n - 1] ?? null;
}

export type PlaceKeyAction = { kind: 'step'; delta: -1 | 1 } | { kind: 'nth'; n: number };

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Which place shortcut a key event is (§4.8, §10): Ctrl+Alt+Up/Down (⌥⌘↑/↓ on
 * macOS) steps through the dock, Ctrl+1…9 (⌘1…9) jumps to the nth server. The
 * digit is read from the physical key, so a layout that needs Shift for digits
 * (AZERTY) still has its shortcut.
 */
export function placeKeyAction(event: KeyLike, mac: boolean): PlaceKeyAction | null {
  if (event.shiftKey) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  if (event.altKey) {
    if (event.key === 'ArrowUp') return { kind: 'step', delta: -1 };
    if (event.key === 'ArrowDown') return { kind: 'step', delta: 1 };
    return null;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? '')?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
  return digit ? { kind: 'nth', n: Number(digit) } : null;
}

/** Where focus goes from `at` for a roving-toolbar key (Left/Right wrap, Home/End), or null for any other key. */
export function rovingTarget(count: number, at: number, key: string): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowLeft':
      return at <= 0 ? last : at - 1;
    case 'ArrowRight':
      return at >= last ? 0 : at + 1;
    default:
      return null;
  }
}
