import { useEffect, useMemo, useState } from 'react';

import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { displayName } from '../../../lib/displayName';
import { entityScopeKey } from '../../../lib/serverScope';
import { channelSpeakers } from '../../../lib/voice/speakingSource';
import type { StageTarget } from '../../../stores/glassStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { selectWatcherCount, useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import type { PillRelation } from '../pill/model';
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
    selectWatcherCount(state, scope && scope.serverId === target.serverId ? scope : null, target.channelId, target.streamerId),
  );

  const channelName = useChannelStore((state) =>
    scope ? state.channelsById[entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.channelId)]?.name ?? null : null,
  );
  const guildName = useGuildStore((state) =>
    scope
      ? state.guilds.find((guild) => guild.key === entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.guildId))?.name ?? null
      : null,
  );
  const roster = useMemberStore((state) =>
    scope ? state.members.get(entityScopeKey({ serverId: target.serverId, userId: scope.userId }, target.guildId)) : undefined,
  );

  // How this client stands to the watched channel: the call it holds, if that is this one.
  const relation: PillRelation = useMemo(() => {
    if (!callId || !callScope || callChannelId !== target.channelId || callScope.serverId !== target.serverId) return 'idle';
    if (callPhase === 'joining') return 'joining';
    if (callPhase === 'closed' || callPhase === 'closing' || callPhase === 'failed' || callPhase === 'idle') return 'idle';
    return callMode === 'listen' ? 'listening' : 'joined';
  }, [callId, callScope, callChannelId, callPhase, callMode, target.channelId, target.serverId]);

  const people = useMemo(() => {
    const map = new Map<string, { name: string; avatar: string | null }>();
    for (const member of roster ?? []) {
      map.set(member.user.id, { name: displayName(member.user, member.nick), avatar: member.user.avatar_hash ?? null });
    }
    return map;
  }, [roster]);

  const speaking = useMemo(() => {
    const local = callConnected && callScope && callChannelId && callGuildId
      ? { serverId: callScope.serverId, guildId: callGuildId, channelId: callChannelId, speakingUsers: localSpeaking }
      : null;
    return channelSpeakers(target.serverId, target.guildId, target.channelId, local, remoteSpeaking);
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
      }),
    [target, states, people, speaking, scope?.userId, channelName, guildName, relation, callMode, nowMs],
  );

  return { model, watchers };
}
