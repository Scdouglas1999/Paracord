import { useEffect, useMemo, useState } from 'react';

import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { displayName } from '../../../lib/displayName';
import { dmTitleFor } from '../../../lib/dmTitle';
import { entityScopeKey } from '../../../lib/serverScope';
import { channelSpeakers } from '../../../lib/voice/speakingSource';
import type { StageTarget } from '../../../stores/glassStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { selectWatcherCount, useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType, type VoiceState } from '../../../types';
import type { PillRelation } from '../pill/model';
import { voiceGuildOf } from '../pill/pillActions';
import { buildStageModel, type StageModel } from './stageModel';

/**
 * The stage's data for its target: the watched channel's people, names and
 * talkers, how this client stands to the channel, and the watcher count. It
 * reads store slices, so a message arriving somewhere never re-renders the
 * stage, and it ticks once a minute for "live for 42 min".
 */

const NOBODY: readonly VoiceState[] = [];

/** One tick a minute, aligned to the minute, for the live duration. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

export interface StageData {
  model: StageModel;
  /** "2 watching", from the server's count for this stream. */
  watchers: number;
}

export function useStageData(target: StageTarget): StageData {
  const scope = useCurrentAccountScope();
  const nowMs = useMinuteClock();

  const states = useVoiceStore((state) => state.channelParticipants.get(target.channelId) ?? NOBODY);
  const callId = useVoiceStore((state) => state.callId);
  const callScope = useVoiceStore((state) => state.callScope);
  const callPhase = useVoiceStore((state) => state.callPhase);
  const callMode = useVoiceStore((state) => state.callMode);
  const callChannelId = useVoiceStore((state) => state.channelId);
  const callGuildId = useVoiceStore((state) => state.guildId);
  const callConnected = useVoiceStore((state) => state.connected);
  const localSpeaking = useVoiceStore((state) => state.speakingUsers);
  const remoteSpeaking = useRemoteSpeakingStore((state) => state.byChannel);
  const watchers = useVoiceStore((state) =>
    target.streamerId === null
      ? 0
      : selectWatcherCount(state, scope && scope.serverId === target.serverId ? scope : null, target.channelId, target.streamerId),
  );

  const channel = useChannelStore((state) =>
    scope ? state.channelsById[entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.channelId)] : undefined,
  );
  const guildName = useGuildStore((state) =>
    scope && target.guildId !== null
      ? state.guilds.find((guild) => guild.key === entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.guildId as string))?.name ?? null
      : null,
  );
  const roster = useMemberStore((state) =>
    scope && target.guildId !== null
      ? state.members.get(entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.guildId))
      : undefined,
  );
  // A DM call has no server: it is named for the people in it, and a DM's voice
  // states carry no names, so the conversation's recipients say who they are.
  const isDm = target.guildId === null;
  const stageChannel = channel?.type === ChannelType.Stage || channel?.channel_type === ChannelType.Stage;
  const channelName = isDm
    ? dmTitleFor(channel, scope?.userId ?? null, 'Voice call')
    : channel?.name ?? null;

  // How this client stands to the watched channel: the call it holds, if that is this one.
  const relation: PillRelation = useMemo(() => {
    if (!callId || !callScope || callChannelId !== target.channelId || callScope.serverId !== target.serverId) return 'idle';
    if (callPhase === 'joining') return 'joining';
    if (callPhase === 'closed' || callPhase === 'closing' || callPhase === 'failed' || callPhase === 'idle') return 'idle';
    return callMode === 'listen' ? 'listening' : 'joined';
  }, [callId, callScope, callChannelId, callPhase, callMode, target.channelId, target.serverId]);

  const recipients = useMemo(
    () => (isDm ? channel?.recipients ?? (channel?.recipient ? [channel.recipient] : undefined) : undefined),
    [isDm, channel],
  );
  const people = useMemo(() => {
    const map = new Map<string, { name: string; avatar: string | null }>();
    for (const member of roster ?? []) {
      map.set(member.user.id, { name: displayName(member.user, member.nick), avatar: member.user.avatar_hash ?? null });
    }
    for (const person of recipients ?? []) {
      map.set(person.id, { name: displayName(person), avatar: person.avatar_hash ?? null });
    }
    return map;
  }, [roster, recipients]);

  const speaking = useMemo(() => {
    const local = callConnected && callScope && callChannelId && callGuildId
      ? { serverId: callScope.serverId, guildId: callGuildId, channelId: callChannelId, speakingUsers: localSpeaking }
      : null;
    return channelSpeakers(target.serverId, voiceGuildOf(target.guildId), target.channelId, local, remoteSpeaking);
  }, [callConnected, callScope, callChannelId, callGuildId, localSpeaking, remoteSpeaking, target.serverId, target.guildId, target.channelId]);

  const model = useMemo(
    () =>
      buildStageModel({
        target,
        states,
        people,
        speaking,
        selfUserId: scope?.userId ?? null,
        channelName,
        guildName,
        relation,
        joiningMode: relation === 'joining' ? callMode : null,
        nowMs,
        stageChannel,
      }),
    [target, states, people, speaking, scope?.userId, channelName, guildName, relation, callMode, nowMs, stageChannel],
  );

  return { model, watchers };
}
