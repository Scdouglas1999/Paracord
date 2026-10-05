import type { VoiceState } from '../../../types';
import { liveGuildIds, pingEdges } from '../dock/dockModel';
import { DM_GUILD } from '../card/model';

/**
 * What the polite live region says about the call world (docs/index-spec.md
 * §10: "One polite live region announces events at most every 2s: 'Jeremy
 * joined General', 'Game Night is live', 'Vincent started sharing'").
 *
 * The same moments the eye gets from motion (a row entering the card, the dock's
 * one-time ping, a screen glyph appearing), in words, and only for what the
 * screen itself is showing:
 *
 *   - someone joins a voice channel of the server you are looking at, or your
 *     own call ("Jeremy joined General");
 *   - someone leaves your call ("Jeremy left General"; other rooms' leavers are
 *     not news);
 *   - someone starts sharing their screen in one of those channels ("Vincent
 *     started sharing");
 *   - another server goes live: the dock's ping rule, exactly (`pingEdges`:
 *     never the server you are looking at, never one first seen already live)
 *     ("Game Night is live").
 *
 * Never you, never someone who only listens in (they are not in the room for
 * anyone else), and nothing on the first snapshot (READY is not an event).
 * Pure: `useEventAnnouncements` feeds it and the announcer paces it.
 */

export interface PersonInRoom {
  listening: boolean;
  sharing: boolean;
}

export interface VoiceSnapshot {
  /** Voice states by channel, reduced to what is announced. */
  rooms: ReadonlyMap<string, { guildId: string | null; people: ReadonlyMap<string, PersonInRoom> }>;
  /** Servers with somebody in a voice channel (the dock's live dot). */
  live: ReadonlySet<string>;
  /** Servers the dock holds. */
  known: ReadonlySet<string>;
}

export interface AnnouncementContext {
  /** The signed-in user (never announced). */
  me: string;
  /** The server the sidebar shows, or null in People. */
  currentGuildId: string | null;
  /** The call you hold (joined or listening), or null. */
  callChannelId: string | null;
  /** Names: a person, a channel, a server. Null when not known (then nothing is said). */
  personName: (userId: string, channelId: string) => string | null;
  channelName: (channelId: string) => string | null;
  guildName: (guildId: string) => string | null;
}

export function voiceSnapshot(
  channelParticipants: ReadonlyMap<string, readonly VoiceState[]>,
  guildIds: Iterable<string>,
): VoiceSnapshot {
  const rooms = new Map<string, { guildId: string | null; people: Map<string, PersonInRoom> }>();
  for (const [channelId, states] of channelParticipants) {
    const people = new Map<string, PersonInRoom>();
    let guildId: string | null = null;
    for (const state of states) {
      guildId = state.guild_id ?? guildId;
      people.set(state.user_id, { listening: state.mode === 'listen', sharing: Boolean(state.self_stream) });
    }
    rooms.set(channelId, { guildId, people });
  }
  return { rooms, live: liveGuildIds(channelParticipants), known: new Set(guildIds) };
}

export function announcementsBetween(before: VoiceSnapshot | null, after: VoiceSnapshot, context: AnnouncementContext): string[] {
  if (!before) return [];
  const said: string[] = [];
  const watched = (channelId: string, guildId: string | null) =>
    channelId === context.callChannelId || (guildId !== null && guildId !== DM_GUILD && guildId === context.currentGuildId);

  for (const [channelId, room] of after.rooms) {
    if (!watched(channelId, room.guildId)) continue;
    const was = before.rooms.get(channelId)?.people;
    const channel = context.channelName(channelId);
    for (const [userId, person] of room.people) {
      if (userId === context.me || person.listening) continue;
      const name = context.personName(userId, channelId);
      if (!name) continue;
      const earlier = was?.get(userId);
      if ((!earlier || earlier.listening) && channel) said.push(`${name} joined ${channel}`);
      if (person.sharing && !earlier?.sharing) said.push(`${name} started sharing`);
    }
  }

  // Leaving is news in your own call only.
  const call = context.callChannelId;
  if (call) {
    const was = before.rooms.get(call)?.people;
    const now = after.rooms.get(call)?.people;
    const channel = context.channelName(call);
    // Your own leaving is not announced (you did it), and neither is everyone
    // "leaving" when the call itself ends for you.
    if (was && now?.has(context.me) && channel) {
      for (const [userId, person] of was) {
        if (userId === context.me || person.listening || now.has(userId)) continue;
        const name = context.personName(userId, call);
        if (name) said.push(`${name} left ${channel}`);
      }
    }
  }

  const current = context.currentGuildId;
  for (const guildId of pingEdges({ live: before.live, known: before.known }, { live: after.live, known: after.known }, current)) {
    const name = context.guildName(guildId);
    if (name) said.push(`${name} is live`);
  }
  return said;
}
