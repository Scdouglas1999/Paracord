/**
 * Which speaking signal to believe for a voice channel.
 *
 * Inside the call you are in, the local media engine's flags
 * (`voiceStore.speakingUsers`) are faster and exact. Everywhere else — the
 * server home's Live now card, the sidebar's voice rows — only the
 * server-relayed signal (`remoteSpeakingStore`) exists.
 */

/** Remote speakers are keyed by guild and channel. */
export function speakingKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

/** The call this client is in, as far as speaking is concerned. */
export interface LocalCall {
  serverId: string;
  guildId: string;
  channelId: string;
  /** `voiceStore.speakingUsers`: the engine's own speaking flags. */
  speakingUsers: ReadonlySet<string>;
}

const NOBODY: ReadonlySet<string> = new Set();

type Speakers = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Who is talking in one voice channel: the local engine's flags when you are
 * in that call (faster and exact), otherwise the server-relayed signal.
 */
export function channelSpeakers(
  serverId: string,
  guildId: string,
  channelId: string,
  localCall: LocalCall | null,
  remote: Speakers,
): ReadonlySet<string> {
  if (
    localCall
    && localCall.serverId === serverId
    && localCall.guildId === guildId
    && localCall.channelId === channelId
  ) {
    return localCall.speakingUsers;
  }
  return remote.get(speakingKey(guildId, channelId)) ?? NOBODY;
}
