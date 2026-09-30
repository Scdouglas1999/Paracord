/**
 * What lights the room (docs/glass-spec.md §4), as a pure decision.
 *
 *   1. The stage is open: the stream being watched (sampled up to 4 Hz from
 *      the watch view), whatever server it is in.
 *   2. The current server has a live stream: the busiest one, through the
 *      ambient view (layer 0, keyframes, at most one frame a second).
 *   3. Otherwise the server's banner, else its icon.
 *   4. Otherwise (Home, DMs, a server with neither) nothing: the neutral room.
 *
 * "Busiest" is the voice channel with the most people among those with a
 * stream, ties to the channel listed first (the places panel's order). Within a
 * channel, the stream that started first. Your own stream never lights your
 * room: this client does not receive it back.
 */
import type { VoiceState } from '../../types';

export interface RoomStreamPick {
  channelId: string;
  streamerId: string;
  occupants: number;
}

export interface PickRoomStreamInput {
  guildId: string;
  /** The server's voice channel ids, in the order the places panel lists them. */
  voiceChannelIds: readonly string[];
  channelParticipants: ReadonlyMap<string, readonly VoiceState[]>;
  selfUserId: string | null;
}

const startedAt = (state: VoiceState) => {
  const parsed = state.self_stream_started_at ? Date.parse(state.self_stream_started_at) : NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export function pickRoomStream(input: PickRoomStreamInput): RoomStreamPick | null {
  let best: RoomStreamPick | null = null;
  for (const channelId of input.voiceChannelIds) {
    const states = (input.channelParticipants.get(channelId) ?? []).filter(
      (state) => state.guild_id === input.guildId,
    );
    const streamers = states
      .filter((state) => state.self_stream && state.user_id !== input.selfUserId)
      .sort((a, b) => startedAt(a) - startedAt(b));
    const streamer = streamers[0];
    if (!streamer) continue;
    if (!best || states.length > best.occupants) {
      best = { channelId, streamerId: streamer.user_id, occupants: states.length };
    }
  }
  return best;
}

export type RoomSourceSpec =
  | { kind: 'none'; key: null }
  | {
      kind: 'stream';
      view: 'ambient' | 'watch';
      key: string;
      serverId: string;
      guildId: string;
      channelId: string;
      streamerId: string;
    }
  | { kind: 'image'; role: 'banner' | 'icon'; key: string; url: string };

export interface ChooseRoomSourceInput {
  /** The instance (`AccountScope.serverId`) the route's server lives on. */
  serverId: string | null;
  /** The route's server, or null on Home and DMs. */
  guildId: string | null;
  /** The stream on the stage, when one is open. */
  stage: { serverId: string; guildId: string; channelId: string; streamerId: string } | null;
  /** The current server's busiest live stream. */
  stream: RoomStreamPick | null;
  /** Loadable banner and icon URLs (already resolved for `<img>`), or null. */
  bannerUrl: string | null;
  iconUrl: string | null;
  /**
   * The server has a banner, whether or not its URL is loadable yet (a browser
   * waits for its download ticket). While it is not, the room waits for it
   * rather than flashing the icon first.
   */
  bannerDeclared?: boolean;
}

export function chooseRoomSource(input: ChooseRoomSourceInput): RoomSourceSpec {
  if (input.stage) {
    const { serverId, guildId, channelId, streamerId } = input.stage;
    return {
      kind: 'stream',
      view: 'watch',
      key: `watch:${serverId}:${channelId}:${streamerId}`,
      serverId,
      guildId,
      channelId,
      streamerId,
    };
  }
  if (!input.guildId || !input.serverId) return { kind: 'none', key: null };
  if (input.stream) {
    const { channelId, streamerId } = input.stream;
    return {
      kind: 'stream',
      view: 'ambient',
      key: `ambient:${input.serverId}:${input.guildId}:${channelId}:${streamerId}`,
      serverId: input.serverId,
      guildId: input.guildId,
      channelId,
      streamerId,
    };
  }
  if (input.bannerDeclared && !input.bannerUrl) return { kind: 'none', key: null };
  if (input.bannerUrl) {
    return { kind: 'image', role: 'banner', key: `banner:${input.serverId}:${input.guildId}:${input.bannerUrl}`, url: input.bannerUrl };
  }
  if (input.iconUrl) {
    return { kind: 'image', role: 'icon', key: `icon:${input.serverId}:${input.guildId}:${input.iconUrl}`, url: input.iconUrl };
  }
  return { kind: 'none', key: null };
}

/**
 * The ambient view the room needs, if any: the current server's busiest live
 * stream. Kept even while a stage is open (the ambient view then rides the
 * watch or waits, costing nothing), so closing the stage relights the room at
 * once. Null on Home and DMs: the room stops its view there.
 */
export function ambientTargetFor(input: Pick<ChooseRoomSourceInput, 'serverId' | 'guildId' | 'stream'>) {
  if (!input.serverId || !input.guildId || !input.stream) return null;
  return {
    serverId: input.serverId,
    guildId: input.guildId,
    channelId: input.stream.channelId,
    streamerId: input.stream.streamerId,
  };
}
