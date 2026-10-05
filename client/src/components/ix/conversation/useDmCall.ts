import { useCallback, useMemo } from 'react';

import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useVoiceStore } from '../../../stores/voiceStore';
import { DM_GUILD } from '../../glass/pill/model';
import { joinCall, showCall, type PillActionTarget } from '../../glass/pill/pillActions';

export interface DmCall {
  /** You are in this conversation's call. */
  inCall: boolean;
  /** The call is being joined. */
  joining: boolean;
  /** Starting is not possible (the server says why in `reason`), or it is under way. */
  disabled: boolean;
  /** The server's sentence when starting is refused; null otherwise. */
  reason: string | null;
  /** Start the call; while in it, open the call view (docs/index-spec.md §7.5). */
  press: () => void;
}

/**
 * The toolbar's DM call button (docs/index-spec.md §4.9, §4.10, §7.5): starting a
 * direct message or group call, and, while one runs, opening its call view. It is
 * the card's own join (`joinCall`: Settings › Join calls muted applies, a refusal
 * is said out loud with the connection check) and the card's own Open call
 * (`showCall`), so a DM call is one path with a room's. A DM belongs to no server:
 * the call's guild is `voiceStore`'s `'dm'` sentinel (`DM_GUILD`).
 */
export function useDmCall(channelId: string, title: string, allowed: boolean, denialReason: string | null): DmCall {
  const scope = useCurrentAccountScope();
  const inCall = useVoiceStore((state) => state.connected && state.channelId === channelId);
  const joining = useVoiceStore((state) => state.joining && state.joiningChannelId === channelId);
  const target = useMemo<PillActionTarget | null>(
    () => (scope ? { serverId: scope.serverId, guildId: DM_GUILD, channelId, title } : null),
    [scope, channelId, title],
  );
  const press = useCallback(() => {
    if (!target) return;
    if (inCall) showCall(target);
    else void joinCall(target);
  }, [target, inCall]);
  return {
    inCall,
    joining,
    disabled: !target || joining || (!inCall && !allowed),
    reason: inCall ? null : denialReason,
    press,
  };
}
