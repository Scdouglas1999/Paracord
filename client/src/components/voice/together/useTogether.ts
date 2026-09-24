import { useCallback, useMemo } from 'react';

import { createTogetherApi, type TogetherApi } from '../../../api/together';
import { displayName } from '../../../lib/displayName';
import { getServerUser } from '../../../lib/serverIdentity';
import type { TogetherSession } from '../../../lib/together/model';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { useTogetherStore } from '../../../stores/togetherStore';
import { useVoiceStore } from '../../../stores/voiceStore';

export interface TogetherContext {
  channelId: string;
  guildId: string;
  serverId: string;
  api: TogetherApi;
  session: TogetherSession | null;
  selfUserId: string | null;
  /** A person's name, from the call's voice states. */
  nameOf: (userId: string | null | undefined) => string;
}

/** Everything the call's Together UI needs, or null when you are not in a server call. */
export function useTogether(): TogetherContext | null {
  const connected = useVoiceStore((s) => s.connected);
  const channelId = useVoiceStore((s) => s.channelId);
  const guildId = useVoiceStore((s) => s.guildId);
  const callScope = useVoiceStore((s) => s.callScope);
  const serverId = callScope?.serverId ?? null;
  const members = useMemberStore((s) =>
    callScope && guildId && guildId !== 'dm' ? s.members.get(entityScopeKey(callScope, guildId)) : undefined,
  );
  const participants = useVoiceStore((s) => (channelId ? s.channelParticipants.get(channelId) : undefined));
  const session = useTogetherStore((s) => (channelId ? s.calls[channelId]?.session ?? null : null));
  const api = useMemo(() => (serverId ? createTogetherApi(serverId) : null), [serverId]);
  const selfUserId = serverId ? getServerUser(serverId)?.id ?? null : null;

  const nameOf = useCallback(
    (userId: string | null | undefined) => {
      if (!userId) return 'Someone';
      if (userId === selfUserId) return 'You';
      const member = members?.find((entry) => entry.user.id === userId);
      if (member) return displayName(member.user, member.nick);
      const state = participants?.find((entry) => entry.user_id === userId);
      return state?.username || state?.display_name ? displayName(state) : 'Someone';
    },
    [members, participants, selfUserId],
  );

  if (!connected || !channelId || !guildId || guildId === 'dm' || !serverId || !api) return null;
  return { channelId, guildId, serverId, api, session, selfUserId, nameOf };
}
