/**
 * The mutable world behind the mocked Index scene: `scene.ts` is what exists
 * when the clock starts; this is what exists NOW. Steps (`steps/`) change it
 * (Jeremy posts, Vincent joins the call), `routes.ts` answers every REST call
 * from it, and `gateway.ts` turns each change into the frame a real server
 * would send, so a reload mid-scenario lands in the same place the live page
 * is in.
 *
 * It is plain data and plain functions: no browser, no Playwright. The one
 * piece of server behavior it does reproduce faithfully is message recovery
 * (docs/encryption.md, `lib/messages/messageRecovery.ts`): every channel keeps
 * a revision log, a live message carries `message_revision`, and the recovery
 * endpoint answers exactly the pages the client validates. Without that the
 * client would accept the history and refuse every live message.
 */
import {
  ATTACHMENTS,
  CHANNELS,
  CLOCK,
  EVENTS,
  FILLER_PEOPLE,
  GUILDS,
  HISTORY,
  ME,
  PEOPLE,
  SPEAKING_AT_START,
  STREAM_STARTED_AT,
  UNREAD_AT_START,
  VOICE_AT_START,
  channelSeed,
  userRecord,
  type AttachmentKey,
  type ChannelKey,
  type ChannelSeed,
  type EventKey,
  type EventSeed,
  type GuildKey,
  type GuildSeed,
  type Identity,
  type MessageSeed,
  type PersonKey,
} from './scene';

/** The history epoch the realtime stub announces by default (`realtime-stub.mjs`). */
export const HISTORY_EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Paracord snowflake epoch (2024-01-01). */
const EPOCH_MS = Date.UTC(2024, 0, 1);

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface MessageState {
  id: string;
  channel: ChannelKey;
  author: PersonKey;
  content: string;
  created_at: string;
  attachments: AttachmentKey[];
  event?: EventKey;
  reactions: Reaction[];
  /** The channel revision of this message's last change (`message_revision`). */
  revision: number;
  nonce?: string | null;
  reference_id?: string;
}

interface LogEntry {
  revision: number;
  kind: 'create' | 'update' | 'delete';
  messageId: string;
}

interface ChannelState {
  seed: ChannelSeed;
  messages: MessageState[];
  log: LogEntry[];
}

export interface VoiceRow {
  who: PersonKey;
  room: ChannelKey;
  /** RFC 3339: when this person came into the room (`voice_states.joined_at`, index-spec §11). */
  joined_at: string;
  self_stream: boolean;
  self_video: boolean;
  self_mute: boolean;
  /** When this person's stream began; non-null exactly while `self_stream`. */
  stream_started_at: string | null;
  speaking: boolean;
}

/** The call this client holds. Never part of READY: a reload drops the call, as it does for real. */
export interface MyCall {
  room: ChannelKey;
  mode: 'joined' | 'listen';
  joined_at: string;
}

export interface ReadStateRecord {
  channel_id: string;
  last_message_id: string;
  mention_count: number;
}

export interface PostOptions {
  /** RFC 3339; defaults to the world's clock. */
  at?: string;
  attachments?: AttachmentKey[];
  event?: EventKey;
  nonce?: string | null;
  reference_id?: string;
  reactions?: Reaction[];
}

export class IndexWorld {
  /** The scene clock, epoch milliseconds. `harness.setClock` keeps the page's Date in step. */
  nowMs = Date.parse(CLOCK.start);
  readonly channels = new Map<ChannelKey, ChannelState>();
  readonly members = new Map<GuildKey, PersonKey[]>();
  readonly online = new Map<GuildKey, Set<PersonKey>>();
  readonly memberCounts = new Map<GuildKey, number>();
  readonly voice: VoiceRow[] = [];
  readonly reads = new Map<string, ReadStateRecord>();
  /** The scheduled events that exist now. The scene starts with none; `busy` creates Movie night. */
  readonly events: EventSeed[] = [];
  myCall: MyCall | null = null;

  private sequence = 0n;

  constructor() {
    for (const seed of CHANNELS) this.channels.set(seed.key, { seed, messages: [], log: [] });
    for (const guild of GUILDS) {
      this.members.set(guild.key, [...guild.members]);
      this.online.set(guild.key, new Set(guild.online));
      this.memberCounts.set(guild.key, guild.member_count);
    }
    for (const seed of HISTORY) this.append(seed);
    for (const channel of this.channels.values()) {
      const last = channel.messages.at(-1);
      if (!last) continue;
      this.reads.set(channel.seed.id, { channel_id: channel.seed.id, last_message_id: last.id, mention_count: 0 });
    }
    // The unread ones: the read position sits just before the first message.
    for (const key of UNREAD_AT_START) {
      const channel = this.channels.get(key)!;
      const first = channel.messages[0];
      this.reads.set(channel.seed.id, {
        channel_id: channel.seed.id,
        last_message_id: (BigInt(first.id) - 1n).toString(),
        mention_count: 0,
      });
    }
    for (const seed of VOICE_AT_START) {
      this.joinVoice(seed.who, seed.room, {
        joined_at: seed.joined_at,
        self_stream: seed.self_stream,
        self_video: seed.self_video,
        self_mute: seed.self_mute,
        speaking: SPEAKING_AT_START.includes(seed.who),
      });
    }
  }

  /* ----------------------------------------------------------------- ids */

  /** A snowflake minted for a moment, so ids sort like time. */
  snowflakeAt(iso: string): string {
    this.sequence += 1n;
    return ((BigInt(Date.parse(iso) - EPOCH_MS) << 22n) + this.sequence).toString();
  }

  get nowIso(): string {
    return new Date(this.nowMs).toISOString();
  }

  /* ------------------------------------------------------------ lookups */

  channelState(key: ChannelKey): ChannelState {
    return this.channels.get(key)!;
  }

  /** A channel by key or by id; undefined when it is neither. */
  channelByIdOrKey(value: string): ChannelState | undefined {
    for (const channel of this.channels.values()) {
      if (channel.seed.key === value || channel.seed.id === value) return channel;
    }
    return undefined;
  }

  messagesIn(key: ChannelKey): MessageState[] {
    return this.channelState(key).messages;
  }

  lastMessageIn(key: ChannelKey): MessageState | null {
    return this.channelState(key).messages.at(-1) ?? null;
  }

  /** Head revision of a channel: the number of changes its log holds. */
  headOf(key: ChannelKey): number {
    return this.channelState(key).log.length;
  }

  voiceIn(room: ChannelKey): VoiceRow[] {
    return this.voice.filter((row) => row.room === room);
  }

  guildOf(room: ChannelKey): GuildSeed {
    const guild = channelSeed(room).guild;
    if (!guild) throw new Error(`${room} is not in a server`);
    return GUILDS.find((g) => g.key === guild)!;
  }

  guildByIdOrKey(value: string): GuildSeed | undefined {
    return GUILDS.find((g) => g.key === value || g.id === value);
  }

  /* ----------------------------------------------------------- mutation */

  private append(seed: MessageSeed, options: PostOptions = {}): MessageState {
    const channel = this.channelState(seed.channel);
    const created_at = options.at ?? seed.at;
    const message: MessageState = {
      id: this.snowflakeAt(created_at),
      channel: seed.channel,
      author: seed.author,
      content: seed.content,
      created_at,
      attachments: options.attachments ?? seed.attachments ?? [],
      event: options.event ?? seed.event,
      reactions: options.reactions ?? [],
      revision: channel.log.length + 1,
      nonce: options.nonce ?? null,
      reference_id: options.reference_id,
    };
    channel.messages.push(message);
    channel.log.push({ revision: message.revision, kind: 'create', messageId: message.id });
    return message;
  }

  /** Someone posts. Returns the message; `gateway.messageCreate` is its frame. */
  post(channel: ChannelKey, author: PersonKey, content: string, options: PostOptions = {}): MessageState {
    const message = this.append(
      { channel, author, content, at: options.at ?? this.nowIso, attachments: options.attachments, event: options.event },
      options,
    );
    // The server counts a mention for everyone it names but the author.
    if (author !== 'you' && content.includes(`<@${ME.id}>`)) {
      const read = this.reads.get(this.channelState(channel).seed.id);
      if (read) read.mention_count += 1;
    }
    return message;
  }

  markRead(channelId: string, lastMessageId: string): void {
    this.reads.set(channelId, { channel_id: channelId, last_message_id: lastMessageId, mention_count: 0 });
  }

  addMember(guild: GuildKey, who: PersonKey, online = true): void {
    const members = this.members.get(guild)!;
    if (!members.includes(who)) {
      members.push(who);
      this.memberCounts.set(guild, (this.memberCounts.get(guild) ?? 0) + 1);
    }
    if (online) this.online.get(guild)!.add(who);
  }

  /** Online or offline in every server they are in. */
  setOnline(who: PersonKey, online: boolean): void {
    for (const [guild, members] of this.members) {
      if (!members.includes(who)) continue;
      const set = this.online.get(guild)!;
      if (online) set.add(who);
      else set.delete(who);
    }
  }

  joinVoice(
    who: PersonKey,
    room: ChannelKey,
    options: Partial<Pick<VoiceRow, 'joined_at' | 'self_stream' | 'self_video' | 'self_mute' | 'speaking'>> = {},
  ): VoiceRow {
    this.leaveVoice(who);
    const self_stream = options.self_stream ?? false;
    const row: VoiceRow = {
      who,
      room,
      joined_at: options.joined_at ?? this.nowIso,
      self_stream,
      self_video: options.self_video ?? false,
      self_mute: options.self_mute ?? false,
      stream_started_at: self_stream ? (who === 'vincent' ? STREAM_STARTED_AT : (options.joined_at ?? this.nowIso)) : null,
      speaking: options.speaking ?? false,
    };
    this.voice.push(row);
    return row;
  }

  leaveVoice(who: PersonKey): VoiceRow | null {
    const index = this.voice.findIndex((row) => row.who === who);
    if (index < 0) return null;
    return this.voice.splice(index, 1)[0];
  }

  setSpeaking(who: PersonKey, speaking: boolean): VoiceRow | null {
    const row = this.voice.find((r) => r.who === who) ?? null;
    if (row) row.speaking = speaking;
    return row;
  }

  /* ----------------------------------------------------------- payloads */

  identity(who: PersonKey): Identity {
    return PEOPLE[who];
  }

  userRecord(who: PersonKey) {
    return userRecord(PEOPLE[who]);
  }

  /** Members as `GET /guilds/{id}/members` lists them: the scene's people, then the head-count filler. */
  memberRecords(guild: GuildKey) {
    const people = this.members.get(guild)!.map((who) => this.memberRecord(PEOPLE[who]));
    const target = this.memberCounts.get(guild) ?? people.length;
    const filler = target > people.length ? FILLER_PEOPLE.slice(0, target - people.length) : [];
    return [...people, ...filler.map((who) => this.memberRecord(who))];
  }

  memberRecord(who: Identity) {
    return {
      user: userRecord(who),
      user_id: who.id,
      nick: null,
      roles: [],
      joined_at: this.nowIso,
      deaf: false,
      mute: false,
    };
  }

  guildSummary(guild: GuildSeed) {
    return {
      id: guild.id,
      name: guild.name,
      owner_id: ME.id,
      icon_hash: null,
      member_count: this.memberCounts.get(guild.key) ?? guild.member_count,
      created_at: guild.created_at,
      // docs/index-spec.md §11: the admin's server color; null lets the id decide.
      hue: guild.hue,
    };
  }

  channelRecord(key: ChannelKey) {
    const channel = this.channelState(key);
    const { seed } = channel;
    const last = channel.messages.at(-1);
    const type = seed.kind === 'text' ? 0 : seed.kind === 'dm' ? 1 : 2;
    return {
      id: seed.id,
      guild_id: seed.guild ? this.guildId(seed.guild) : null,
      name: seed.name,
      type,
      channel_type: type,
      position: seed.position,
      nsfw: false,
      parent_id: null,
      required_role_ids: [],
      ...(seed.topic ? { topic: seed.topic } : {}),
      last_message_id: seed.kind === 'voice' ? null : (last?.id ?? null),
      message_revision: String(channel.log.length),
      created_at: seed.guild ? this.guildOf(key as ChannelKey).created_at : '2026-01-01T00:00:00-05:00',
      ...(seed.recipient
        ? {
            recipient: {
              id: PEOPLE[seed.recipient].id,
              username: PEOPLE[seed.recipient].username,
              // Not on today's wire type (it names the person by username); the Index titles want it.
              display_name: PEOPLE[seed.recipient].display_name,
              discriminator: '0001',
              avatar_hash: null,
            },
          }
        : {}),
    };
  }

  guildId(key: GuildKey): string {
    return GUILDS.find((g) => g.key === key)!.id;
  }

  channelsOf(guild: GuildKey): ChannelKey[] {
    return CHANNELS.filter((c) => c.guild === guild).map((c) => c.key);
  }

  messageRecord(message: MessageState) {
    const channel = this.channelState(message.channel).seed;
    const attachments = message.attachments.map((key) => {
      const a = ATTACHMENTS[key];
      return {
        id: a.id,
        filename: a.filename,
        size: 100_000,
        content_type: a.content_type,
        url: `/attachments/${a.id}`,
        width: a.width,
        height: a.height,
      };
    });
    const content = message.event ? `<event:${this.eventId(message.event)}>` : message.content;
    return {
      id: message.id,
      channel_id: channel.id,
      author: userRecord(PEOPLE[message.author]),
      content,
      created_at: message.created_at,
      timestamp: message.created_at,
      tts: false,
      mention_everyone: false,
      pinned: false,
      type: 0,
      attachments,
      reactions: message.reactions,
      ...(message.nonce ? { nonce: message.nonce } : {}),
      ...(message.reference_id ? { reference_id: message.reference_id } : {}),
    };
  }

  /** A message with its revision: what recovery and the live frame carry. */
  revisedMessageRecord(message: MessageState) {
    return { ...this.messageRecord(message), message_revision: String(message.revision) };
  }

  /** An event's id, whether or not it exists yet (the plans post names it before anyone asks for it). */
  eventId(key: EventKey): string {
    return EVENTS.find((e) => e.key === key)!.id;
  }

  /** Someone schedules an event: it exists from now on (`gateway.eventCreate` is its frame). */
  addEvent(key: EventKey): EventSeed {
    const existing = this.events.find((e) => e.key === key);
    if (existing) return existing;
    const seed = { ...EVENTS.find((e) => e.key === key)! };
    this.events.push(seed);
    return seed;
  }

  eventRecord(seed: EventSeed) {
    return {
      id: seed.id,
      guild_id: this.guildId(seed.guild),
      channel_id: seed.room ? channelSeed(seed.room).id : null,
      creator_id: PEOPLE[seed.creator].id,
      name: seed.name,
      description: null,
      scheduled_start: seed.scheduled_start,
      scheduled_end: null,
      status: 1,
      entity_type: seed.room ? 1 : 2,
      location: null,
      image_url: null,
      user_count: seed.user_count,
      user_rsvp: false,
      created_at: CLOCK.start,
    };
  }

  /**
   * What `GET /guilds/{id}/channel-previews` answers: the newest message of
   * every channel that has one, as the server describes it: whitespace
   * collapsed, at most 140 characters, the first attachment as `media`.
   */
  previewRecord(key: ChannelKey) {
    const channel = this.channelState(key);
    const last = channel.messages.at(-1);
    if (!last) return null;
    const first = last.attachments[0] ? ATTACHMENTS[last.attachments[0]] : null;
    const text = (last.event ? `<event:${this.eventId(last.event)}>` : last.content).replace(/\s+/g, ' ').trim();
    return {
      channel_id: channel.seed.id,
      message_id: last.id,
      message_type: 0,
      author_id: PEOPLE[last.author].id,
      author_kind: 'user',
      author_name: PEOPLE[last.author].display_name,
      content: text || null,
      truncated: false,
      encrypted: false,
      created_at: last.created_at,
      media: first
        ? {
            attachment_id: first.id,
            content_type: first.content_type,
            filename: first.filename,
            width: first.width,
            height: first.height,
          }
        : null,
      attachment_count: last.attachments.length,
      has_sticker: false,
    };
  }

  voiceState(row: VoiceRow) {
    const guild = channelSeed(row.room).guild;
    const who = PEOPLE[row.who];
    return {
      user_id: who.id,
      channel_id: channelSeed(row.room).id,
      guild_id: guild ? this.guildId(guild) : undefined,
      session_id: `session-${who.id}`,
      username: who.username,
      display_name: who.display_name,
      avatar_hash: null,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: row.self_mute,
      self_stream: row.self_stream,
      self_video: row.self_video,
      suppress: false,
      speaking: row.speaking,
      mode: 'joined',
      // docs/index-spec.md §11. Absent until the backend package lands, ignored by today's client.
      joined_at: row.joined_at,
      self_stream_started_at: row.stream_started_at,
    };
  }

  voiceStatesIn(guild: GuildKey) {
    const rooms = new Set(this.channelsOf(guild));
    return this.voice.filter((row) => rooms.has(row.room)).map((row) => this.voiceState(row));
  }

  presences(guild: GuildKey) {
    return [...this.online.get(guild)!].map((who) => ({ user_id: PEOPLE[who].id, status: 'online', activities: [] }));
  }

  readStateRecords(): ReadStateRecord[] {
    return [...this.reads.values()];
  }

  /**
   * What the realtime stub merges into every READY (`POST /__standing`'s
   * `world`): the guilds with their channels, voice states and presences. Your
   * own call is not here: READY never carries it, a reload drops the call.
   */
  readyWorld() {
    return {
      database_history_epoch: HISTORY_EPOCH,
      user: { id: ME.id, username: ME.username, display_name: ME.display_name },
      guilds: GUILDS.map((guild) => ({
        ...this.guildSummary(guild),
        channels: this.channelsOf(guild.key).map((key) => this.channelRecord(key)),
        voice_states: this.voiceStatesIn(guild.key),
        presences: this.presences(guild.key),
      })),
      dm_voice_states: [],
    };
  }

  /* ----------------------------------------------------------- recovery */

  /**
   * One page of `GET /channels/{id}/messages/recovery`, as the server answers
   * and `readRecoveryPage` validates it: the changes after `after` up to
   * `through` (at most `limit`), and the authoritative state of every message
   * those changes touch plus every id the client says it knows.
   */
  recoveryPage(key: ChannelKey, query: { after: string; through?: string; known_ids: string[]; limit?: number }) {
    const channel = this.channelState(key);
    const head = channel.log.length;
    const after = Number(query.after);
    const through = query.through === undefined ? head : Number(query.through);
    const next = Math.min(through, after + (query.limit ?? 100));
    const changes = channel.log
      .filter((entry) => entry.revision > after && entry.revision <= next)
      .map((entry) => ({ revision: String(entry.revision), kind: entry.kind, message_id: entry.messageId, archived_message: null }));
    const wanted = [...new Set([...query.known_ids, ...changes.map((c) => c.message_id)])];
    const states = wanted.map((id) => {
      const message = channel.messages.find((m) => m.id === id);
      if (!message) return { message_id: id, state: 'deleted', revision: String(head) };
      return { message_id: id, state: 'present', revision: String(message.revision), message: this.revisedMessageRecord(message) };
    });
    return {
      database_history_epoch: HISTORY_EPOCH,
      channel_id: channel.seed.id,
      after: String(after),
      through: String(through),
      floor: '0',
      next: String(next),
      complete: next === through,
      projection_head: String(head),
      changes,
      states,
    };
  }
}
