import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { displayName } from '../../../lib/displayName';
import { channelSpeakers } from '../../../lib/voice/speakingSource';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { Channel } from '../../../types';
import {
  DM_GUILD,
  pickPillTarget,
  type HeldCall,
  type PillChannel,
  type PillTarget,
} from './model';

/**
 * The pill's data: which channel it shows and who is in it, read from the
 * stores it belongs to and handed to `model.ts`. It subscribes to slices, not to
 * whole stores, so a message arriving somewhere never re-renders the header.
 */

const asPillChannel = (channel: Channel): PillChannel => ({
  id: channel.id,
  name: channel.name ?? '',
  guildId: channel.guild_id ?? null,
  type: channel.type,
  position: channel.position ?? 0,
});

const sameAccount = (a: AccountScope | null, b: AccountScope | null) =>
  Boolean(a && b) && accountScopeKey(a as AccountScope) === accountScopeKey(b as AccountScope);

export function useCallPillTarget(routeGuildId: string | null): PillTarget | null {
  const scope = useCurrentAccountScope();

  // The call this client holds.
  const callId = useVoiceStore((state) => state.callId);
  const callScope = useVoiceStore((state) => state.callScope);
  const callPhase = useVoiceStore((state) => state.callPhase);
  const callMode = useVoiceStore((state) => state.callMode);
  const callChannelId = useVoiceStore((state) => state.channelId);
  const callGuildId = useVoiceStore((state) => state.guildId);
  const callConnected = useVoiceStore((state) => state.connected);
  const localSpeaking = useVoiceStore((state) => state.speakingUsers);
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const remoteSpeaking = useRemoteSpeakingStore((state) => state.byChannel);

  const held = useMemo<HeldCall | null>(() => {
    if (!callId || !callScope || !callChannelId) return null;
    return {
      scope: callScope,
      channelId: callChannelId,
      guildId: callGuildId ?? null,
      phase: callPhase,
      mode: callMode,
    };
  }, [callId, callScope, callChannelId, callGuildId, callPhase, callMode]);

  // Only the channels somebody has joined can be candidates, so only those (and
  // the held call's) are looked up. `useShallow` keeps the header still while
  // any other channel changes.
  const wanted = useMemo(() => {
    const ids = new Set<string>();
    for (const [channelId, states] of channelParticipants) {
      if (states.some((state) => state.mode !== 'listen')) ids.add(channelId);
    }
    if (callChannelId) ids.add(callChannelId);
    return [...ids].sort();
  }, [channelParticipants, callChannelId]);

  const heldInOtherAccount = Boolean(held && scope && !sameAccount(held.scope, scope));

  const found = useChannelStore(
    useShallow((state) => {
      if (!scope) return [] as Array<Channel | undefined>;
      return wanted.map((id) => state.channelsById[entityScopeKey(scope, id)] as Channel | undefined);
    }),
  );
  const heldElsewhere = useChannelStore((state) =>
    heldInOtherAccount && held ? (state.channelsById[entityScopeKey(held.scope, held.channelId)] as Channel | undefined) : undefined,
  );

  const guilds = useGuildStore((state) => state.guilds);
  const memberRosters = useMemberStore((state) => state.members);

  return useMemo(() => {
    if (!scope) return null;
    const channels = new Map<string, PillChannel>();
    for (const channel of found) if (channel) channels.set(channel.id, asPillChannel(channel));

    const prefix = `${accountScopeKey(scope).slice(0, -1)},`;
    const guildNames = new Map<string, string>();
    for (const guild of guilds) {
      if (guild.key.startsWith(prefix)) guildNames.set(guild.id, guild.name);
    }
    const heldGuild = held && heldInOtherAccount && held.guildId && held.guildId !== DM_GUILD
      ? guilds.find((guild) => guild.key === entityScopeKey(held.scope, held.guildId as string))
      : undefined;

    // Who people are, as the client knows them: a voice state carries a username,
    // not the name people use, so the server's member roster comes first; and a
    // DM's voice states carry neither, so the conversation says who is in it.
    const people = new Map<string, { name: string; avatar: string | null }>();
    const voiceGuilds = new Set<string>();
    for (const [channelId, states] of channelParticipants) {
      if (!wanted.includes(channelId)) continue;
      for (const state of states) if (state.guild_id) voiceGuilds.add(state.guild_id);
    }
    if (held?.guildId && held.guildId !== DM_GUILD) voiceGuilds.add(held.guildId);
    for (const guildId of voiceGuilds) {
      const roster = memberRosters.get(entityScopeKey(held && heldInOtherAccount && held.guildId === guildId ? held.scope : scope, guildId));
      for (const member of roster ?? []) {
        people.set(member.user.id, { name: displayName(member.user, member.nick), avatar: member.user.avatar_hash ?? null });
      }
    }
    let dmTitle: string | null = null;
    if (held?.guildId === DM_GUILD) {
      const channel = heldInOtherAccount ? heldElsewhere : found[wanted.indexOf(held.channelId)];
      const recipients = channel?.recipients ?? (channel?.recipient ? [channel.recipient] : []);
      for (const person of recipients) {
        people.set(person.id, { name: displayName(person), avatar: person.avatar_hash ?? null });
      }
      dmTitle = channel?.name?.trim()
        || recipients.filter((person) => person.id !== scope.userId).map((person) => displayName(person)).join(', ')
        || null;
    }

    return pickPillTarget({
      scope,
      routeGuildId,
      held,
      channelParticipants,
      channels,
      heldChannel: heldElsewhere ? asPillChannel(heldElsewhere) : null,
      guildNames,
      heldGuildName: heldGuild?.name ?? null,
      people,
      dmTitle,
      speakers: (guildId, channelId) => {
        const local = callConnected && callScope && callChannelId && callGuildId
          ? { serverId: callScope.serverId, guildId: callGuildId, channelId: callChannelId, speakingUsers: localSpeaking }
          : null;
        // The engine's own flags are only for the call this client is in.
        const serverId = local && local.guildId === guildId && local.channelId === channelId ? local.serverId : scope.serverId;
        return channelSpeakers(serverId, guildId, channelId, local, remoteSpeaking);
      },
      selfUserId: scope.userId,
    });
  }, [
    scope, routeGuildId, held, heldInOtherAccount, heldElsewhere, found, wanted, guilds, memberRosters, channelParticipants,
    callScope, callConnected, callChannelId, callGuildId, localSpeaking, remoteSpeaking,
  ]);
}
