/**
 * The gateway side of the harness: the frames a real server would send for
 * each change to the world (`frames`), and the client of the realtime stub that
 * delivers them (`RealtimeStub`).
 *
 * The stub (`e2e/realtime-stub.mjs`) holds one authenticated SSE stream open
 * exactly like the real server, so the page runs its real gateway code,
 * including the durable message pipeline, rather than a replaced EventSource.
 * `POST /__standing` sets the world every READY carries (a reload lands in the
 * current world) and `POST /__emit` writes frames to every open stream.
 */
import { channelSeed, PEOPLE, type ChannelKey, type EventKey, type GuildKey, type PersonKey } from './scene';
import { type IndexWorld, type MessageState } from './world';

export interface GatewayFrame {
  /** 0 is a dispatch; 11 is the heartbeat ack the harness sends after moving the clock. */
  op: number;
  t?: string;
  d: unknown;
}

const frame = (t: string, d: unknown): GatewayFrame => ({ op: 0, t, d });

/**
 * Any frame proves the stream is alive to the client's liveness watchdog, which
 * reconnects after 60 seconds of silence MEASURED ON THE PAGE'S CLOCK. The scene
 * clock jumps minutes at a time, so every jump is followed by one of these.
 */
export const heartbeatAck = (): GatewayFrame => ({ op: 11, d: {} });

/** A presence update for nobody: delivered last, it proves everything before it was processed. */
export const drainMarker = (n: number): GatewayFrame => frame('PRESENCE_UPDATE', { user_id: `ix-drain-${n}`, status: 'offline', activities: [] });

export const frames = {
  /** A new message: the record, its revision (so the client's recovery cursor advances by one) and the channel's activity. */
  messageCreate(world: IndexWorld, message: MessageState): GatewayFrame {
    const seed = channelSeed(message.channel);
    const guildId = seed.guild ? world.guildId(seed.guild) : null;
    return frame('MESSAGE_CREATE', {
      ...world.revisedMessageRecord(message),
      ...(guildId ? { guild_id: guildId } : {}),
      channel_activity: {
        channel_id: seed.id,
        guild_id: guildId,
        last_message_id: message.id,
        revision: String(message.revision),
      },
    });
  },

  presence(who: PersonKey, status: 'online' | 'offline' | 'idle' | 'dnd' = 'online'): GatewayFrame {
    return frame('PRESENCE_UPDATE', { user_id: PEOPLE[who].id, status, activities: [] });
  },

  /** A member joins a server (and the server's head count moves with it). */
  memberAdd(world: IndexWorld, guild: GuildKey, who: PersonKey): GatewayFrame[] {
    const guildId = world.guildId(guild);
    return [
      frame('GUILD_MEMBER_ADD', {
        guild_id: guildId,
        user: world.userRecord(who),
        user_id: PEOPLE[who].id,
        nick: null,
        roles: [],
        joined_at: world.nowIso,
        deaf: false,
        mute: false,
      }),
      frame('GUILD_UPDATE', { id: guildId, member_count: world.memberCounts.get(guild) }),
    ];
  },

  /** A scheduled event is created (Coming up, the event card and the plans preview read it). */
  eventCreate(world: IndexWorld, key: EventKey): GatewayFrame {
    const seed = world.events.find((e) => e.key === key);
    if (!seed) throw new Error(`event ${key} does not exist yet: call world.addEvent first`);
    return frame('GUILD_SCHEDULED_EVENT_CREATE', world.eventRecord(seed));
  },

  /** Someone joins, changes or leaves a room. `room: null` is a leave. */
  voiceState(world: IndexWorld, who: PersonKey, room: ChannelKey | null, leftFrom?: ChannelKey): GatewayFrame {
    const row = room ? world.voice.find((r) => r.who === who && r.room === room) : undefined;
    if (row) return frame('VOICE_STATE_UPDATE', world.voiceState(row));
    const from = leftFrom ? channelSeed(leftFrom) : null;
    return frame('VOICE_STATE_UPDATE', {
      user_id: PEOPLE[who].id,
      channel_id: null,
      guild_id: from?.guild ? world.guildId(from.guild) : undefined,
      session_id: `session-${PEOPLE[who].id}`,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_stream: false,
      self_video: false,
      suppress: false,
    });
  },

  /** Somebody started or stopped talking in a room. */
  speaking(world: IndexWorld, who: PersonKey, room: ChannelKey, speaking: boolean): GatewayFrame {
    const seed = channelSeed(room);
    return frame('VOICE_SPEAKING', {
      guild_id: seed.guild ? world.guildId(seed.guild) : null,
      channel_id: seed.id,
      user_id: PEOPLE[who].id,
      speaking,
    });
  },

  typing(world: IndexWorld, channel: ChannelKey, who: PersonKey): GatewayFrame {
    const seed = channelSeed(channel);
    return frame('TYPING_START', {
      channel_id: seed.id,
      user_id: PEOPLE[who].id,
      ...(seed.guild ? { guild_id: world.guildId(seed.guild) } : {}),
    });
  },

  /** How many people watch each stream in a room (a complete snapshot per room). */
  watchers(world: IndexWorld, room: ChannelKey, streams: Array<{ who: PersonKey; watchers: number }>): GatewayFrame {
    const seed = channelSeed(room);
    return frame('VOICE_WATCHERS_UPDATE', {
      guild_id: seed.guild ? world.guildId(seed.guild) : null,
      channel_id: seed.id,
      streams: streams.map((s) => ({ user_id: PEOPLE[s.who].id, watchers: s.watchers })),
    });
  },
};

/** The realtime stub's back door, as an HTTP client. */
export class RealtimeStub {
  constructor(readonly port: number) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`realtime stub ${path} answered ${response.status}`);
    return response.json();
  }

  /** Set what every READY carries from now on (and the frames replayed right behind it). */
  async setStanding(world: ReturnType<IndexWorld['readyWorld']>, frames: GatewayFrame[] = []): Promise<void> {
    await this.post('/__standing', { world, frames });
  }

  /** Write frames, in order, to every open stream. Resolves with how many streams received them. */
  async emit(batch: GatewayFrame | GatewayFrame[]): Promise<number> {
    const list = Array.isArray(batch) ? batch : [batch];
    if (list.length === 0) return 0;
    const answer = (await this.post('/__emit', list)) as { streams: number };
    return answer.streams;
  }

  /** Cut every open stream (the client reconnects at once and gets a fresh READY). */
  async drop(): Promise<void> {
    await this.post('/__drop', {});
  }

  /** How many streams are open: a harmless presence frame doubles as the probe. */
  async openStreams(): Promise<number> {
    return this.emit(frames.presence('you'));
  }
}
