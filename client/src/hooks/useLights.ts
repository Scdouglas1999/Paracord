/**
 * The light selectors (docs/lantern-stage-spec.md §1.2, §1.5, §7).
 *
 * This is the ONLY place the stores are read for light. The models and every
 * rule live as pure functions in `src/lib/attention/light.ts` and
 * `src/lib/attention/guildLight.ts`; these hooks just hand them store slices,
 * memoized and account-scoped.
 *
 * Three rules this file exists to keep:
 *
 *  1. **Account-scoped, always.** Every id here is a per-server snowflake, so
 *     every key is `entityScopeKey(scope, id)` and every presence lookup passes
 *     the owning `serverId` as the presence scope. Two servers minting the same
 *     channel id can never bleed light into each other.
 *  2. **Memoized on the narrowest slice.** A guild-scoped hook subscribes to
 *     that guild's slices only. `useBuildingLights` exists because §7.5 needs
 *     the cross-server sweep, and it is the one place that pays for it.
 *  3. **No store shape changes.** Everything is derived. The only new mutable
 *     state in WP1 is `roomLitHistory` — this client's own observation log of
 *     when a room lit up — which is a module record, not a store field.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { registerSessionReset } from '../stores/sessionReset';
import { useTypingStore } from '../stores/typingStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useRemoteSpeakingStore } from '../stores/remoteSpeakingStore';

import { getAccountChannelView } from '../lib/channelView';
import type { LocalCall } from '../lib/voice/speakingSource';
import { accountScopeKey, entityScopeKey } from '../lib/serverScope';
import {
  orderBuildingsByBrightness,
  roomLitHistory,
  type BuildingLight,
  type RoomLight,
} from '../lib/attention/light';
import {
  guildLight,
  readsMessages,
  type LightChannel,
  type LightMessage,
} from '../lib/attention/guildLight';
import type { MessageState } from '../stores/messageStore';
import type { Member } from '../types';
import { useAvailableGuilds } from './useGuilds';
import { useCurrentAccountScope } from './useCurrentUser';
import { useCurrentMessageStore } from './useMessageStore';

// The lit history is this client's own observation log, so it belongs to the
// session exactly like a store does.
registerSessionReset('roomLitHistory', () => roomLitHistory.clear());

const CLOCK_INTERVAL_MS = 1_000;
const NO_MEMBERS: Member[] = [];
const NO_CHANNELS: LightChannel[] = [];
const NO_ROOMS: RoomLight[] = [];
const NO_MESSAGES: Record<string, LightMessage[]> = {};

/**
 * One ticker per interval, shared by every clock that asks for it.
 *
 * Each light hook used to keep its own `setInterval`: the sidebar, the header,
 * the timeline and the on-air pill each woke up on their own schedule, so a
 * second of a call cost one React render pass per clock. Subscribers of one
 * ticker are told in the same task, so React renders them together. The timer
 * runs only while somebody is subscribed.
 */
interface LightTicker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const lightTickers = new Map<number, LightTicker>();

function lightTicker(intervalMs: number): LightTicker {
  let ticker = lightTickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: null };
    lightTickers.set(intervalMs, ticker);
  }
  return ticker;
}

function subscribeLightTicker(intervalMs: number, listener: () => void): () => void {
  const ticker = lightTicker(intervalMs);
  ticker.listeners.add(listener);
  if (ticker.timer === null) {
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const notify of ticker.listeners) notify();
    }, intervalMs);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer !== null) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

const idleSubscribe = () => () => {};

/**
 * The ticker's time. While nobody holds the ticker it does not run, so a clock
 * that mounts then would read whenever it last ticked; it is brought forward
 * first, never by less than a whole interval, so two reads in one render agree.
 */
function readLightTicker(intervalMs: number): number {
  const ticker = lightTicker(intervalMs);
  if (ticker.timer === null) {
    const now = Date.now();
    if (now - ticker.now >= intervalMs) ticker.now = now;
  }
  return ticker.now;
}

/**
 * A 1 Hz clock so a call duration counts up without every light selector
 * re-running on an animation frame. Idle when nothing on screen needs it: an
 * inactive clock holds the time it last showed.
 */
export function useLightClock(active: boolean, intervalMs = CLOCK_INTERVAL_MS): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeLightTicker(intervalMs, listener),
    [intervalMs],
  );
  const live = useSyncExternalStore(
    active ? subscribe : idleSubscribe,
    () => readLightTicker(intervalMs),
  );
  // While idle the clock holds the time it last showed: when it mounted, or
  // its last tick before it went idle. It is only written when the clock goes
  // idle, so a tick costs one render, not two.
  const [held, setHeld] = useState(() => Date.now());
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setHeld(live);
  }
  return active ? live : held;
}

/**
 * Is this window actually being looked at? The self-viewing term of the
 * "reading" definition (see `roomLight.ts`) — the one thing a client can know
 * about its own user that it can never know about anybody else.
 */
export function useWindowIsVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
  return visible;
}

/** The text rooms among these channels — the timelines a light reads. */
function messageChannelIds(channelLists: readonly (readonly LightChannel[])[]): string[] {
  const ids: string[] = [];
  for (const channels of channelLists) {
    for (const channel of channels) if (readsMessages(channel)) ids.push(channel.id);
  }
  return ids;
}

/**
 * The store slices every light hook needs, subscribed once.
 *
 * `messageChannels` are the text rooms the caller lights. Only their timelines
 * are subscribed: a message in a DM, a thread or another server's channel
 * cannot change this light, and used to re-render every light on screen.
 */
function useLightSources(messageChannels: readonly string[]) {
  const presences = usePresenceStore((state) => state.presences);
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const speakingUsers = useVoiceStore((state) => state.speakingUsers);
  const remoteSpeaking = useRemoteSpeakingStore((state) => state.byChannel);
  const callConnected = useVoiceStore((state) => state.connected);
  const callScope = useVoiceStore((state) => state.callScope);
  const callGuildId = useVoiceStore((state) => state.guildId);
  const callChannelId = useVoiceStore((state) => state.channelId);
  // The call you are in reads its own engine's speaking flags; every other
  // voice channel reads the server-relayed signal (lib/voice/speakingSource).
  const localCall = useMemo<LocalCall | null>(
    () =>
      callConnected && callScope && callGuildId && callChannelId
        ? { serverId: callScope.serverId, guildId: callGuildId, channelId: callChannelId, speakingUsers }
        : null,
    [callConnected, callScope, callGuildId, callChannelId, speakingUsers],
  );
  const typingByChannel = useTypingStore((state) => state.typingByChannel);
  // Message stores are per account (`getMessageStore`), and hooks cannot be
  // looped over scopes — so the "authored" reading term reads the CURRENT
  // account's loaded timelines only. Background accounts fall back to the
  // typing term, which is exactly what `roomLight.ts` promises: an unloaded
  // channel contributes nothing rather than a guess.
  const selectMessages = useCallback(
    (state: MessageState) => {
      const picked: Record<string, LightMessage[]> = {};
      for (const id of messageChannels) {
        const loaded = state.messages[id];
        if (loaded) picked[id] = loaded as LightMessage[];
      }
      return picked;
    },
    [messageChannels],
  );
  const messages = useCurrentMessageStore(useShallow(selectMessages));
  const messagesScope = useCurrentAccountScope();
  const messagesScopeKey = messagesScope ? accountScopeKey(messagesScope) : null;
  const selectedChannel = useChannelStore((state) => state.selectedChannel);
  const selfUserId = useAuthStore((state) => state.user?.id ?? null);
  const windowVisible = useWindowIsVisible();
  const nowMs = useLightClock(channelParticipants.size > 0);
  // One stable object, so a light memo keyed on `sources` only re-runs when a
  // slice actually changed rather than on every render of its owner.
  return useMemo(
    () => ({
      presences,
      channelParticipants,
      localCall,
      remoteSpeaking,
      typingByChannel,
      messages,
      messagesScopeKey,
      selectedChannel,
      selfUserId,
      windowVisible,
      nowMs,
    }),
    [
      presences,
      channelParticipants,
      localCall,
      remoteSpeaking,
      typingByChannel,
      messages,
      messagesScopeKey,
      selectedChannel,
      selfUserId,
      windowVisible,
      nowMs,
    ],
  );
}

/**
 * `presences` is subscribed for invalidation but read through the store's own
 * per-user index — scanning the whole map per member is what made the old
 * member list O(members × presences).
 */
function statusLookup(serverId: string) {
  const getPresence = usePresenceStore.getState().getPresence;
  return (userId: string) => getPresence(userId, serverId)?.status ?? 'offline';
}

/**
 * Has anybody actually fetched this building's rooms and members?
 *
 * Subscribed as two booleans rather than the whole record, so a fetch for a
 * different building does not re-render this one.
 */
function useRosterKnown(key: string | null): boolean {
  const channels = useChannelStore((state) => (key ? Boolean(state.guildChannelsLoaded[key]) : false));
  const members = useMemberStore((state) => (key ? Boolean(state.membersLoaded[key]) : false));
  return channels && members;
}

/** One building's light: window map, counts, rooms, caption. */
export function useBuildingLight(guildId: string | null | undefined): BuildingLight | null {
  const scope = useCurrentAccountScope();
  const guild = useGuildStore((state) =>
    scope && guildId
      ? state.guilds.find((entry) => entry.key === entityScopeKey(scope, guildId))
      : undefined,
  );
  const channels = useChannelStore((state) =>
    scope && guildId ? getAccountChannelView(scope, state).channelsByGuild[guildId] : undefined,
  );
  const members = useMemberStore((state) =>
    scope && guildId ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const rosterKnown = useRosterKnown(scope && guildId ? entityScopeKey(scope, guildId) : null);
  const messageChannels = useMemo(() => messageChannelIds(channels ? [channels] : []), [channels]);
  const sources = useLightSources(messageChannels);

  return useMemo(() => {
    if (!scope || !guildId || !guild) return null;
    void sources.presences;
    const selected =
      sources.selectedChannel &&
      accountScopeKey(sources.selectedChannel.scope) === accountScopeKey(scope)
        ? sources.selectedChannel.id
        : null;
    return guildLight({
      scope,
      guildId,
      guildName: guild.name,
      icon: guild.icon_hash ?? guild.icon ?? null,
      memberCount: guild.member_count ?? undefined,
      channels: channels ?? NO_CHANNELS,
      members: members ?? NO_MEMBERS,
      channelParticipants: sources.channelParticipants,
      localCall: sources.localCall,
      remoteSpeaking: sources.remoteSpeaking,
      typingByChannel: sources.typingByChannel,
      messages:
        sources.messagesScopeKey === accountScopeKey(scope) ? sources.messages : NO_MESSAGES,
      getStatus: statusLookup(scope.serverId),
      selfUserId: sources.selfUserId,
      selectedChannelId: selected,
      windowVisible: sources.windowVisible,
      nowMs: sources.nowMs,
      rosterKnown,
    });
  }, [scope, guildId, guild, channels, members, rosterKnown, sources]);
}

/** Every room in one building. */
export function useRoomLights(guildId: string | null | undefined): RoomLight[] {
  const building = useBuildingLight(guildId);
  return building?.rooms ?? NO_ROOMS;
}

/**
 * Every building on every connected server, brightest first (§7.1, §7.5).
 *
 * Reuses the same pure builder as `useBuildingLight`, so a building can never
 * look different on Home than it does in the sidebar.
 */
export function useBuildingLights(): BuildingLight[] {
  const guilds = useAvailableGuilds();
  const channelsByGuild = useChannelStore((state) => state.channelsByGuild);
  const channelsLoaded = useChannelStore((state) => state.guildChannelsLoaded);
  const members = useMemberStore((state) => state.members);
  const membersLoaded = useMemberStore((state) => state.membersLoaded);
  const messageChannels = useMemo(
    () => messageChannelIds(guilds.map((guild) => channelsByGuild[guild.key] ?? NO_CHANNELS)),
    [guilds, channelsByGuild],
  );
  const sources = useLightSources(messageChannels);

  return useMemo(() => {
    void sources.presences;
    const built = guilds.map((guild) => {
      const key = guild.key;
      const selected =
        sources.selectedChannel &&
        accountScopeKey(sources.selectedChannel.scope) === accountScopeKey(guild.scope)
          ? sources.selectedChannel.id
          : null;
      return guildLight({
        scope: guild.scope,
        guildId: guild.id,
        guildName: guild.name,
        icon: guild.icon_hash ?? guild.icon ?? null,
        memberCount: guild.member_count ?? undefined,
        channels: channelsByGuild[key] ?? NO_CHANNELS,
        members: members.get(key) ?? NO_MEMBERS,
        channelParticipants: sources.channelParticipants,
        localCall: sources.localCall,
        remoteSpeaking: sources.remoteSpeaking,
        typingByChannel: sources.typingByChannel,
        messages:
          sources.messagesScopeKey === accountScopeKey(guild.scope)
            ? sources.messages
            : NO_MESSAGES,
        getStatus: statusLookup(guild.scope.serverId),
        selfUserId: sources.selfUserId,
        selectedChannelId: selected,
        windowVisible: sources.windowVisible,
        nowMs: sources.nowMs,
        rosterKnown: Boolean(channelsLoaded[key]) && Boolean(membersLoaded[key]),
      });
    });
    return orderBuildingsByBrightness(built);
  }, [guilds, channelsByGuild, channelsLoaded, members, membersLoaded, sources]);
}

