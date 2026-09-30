import { useState } from 'react';
import { useVoice } from '../../../hooks/useVoice';
import { useVoiceStore } from '../../../stores/voiceStore';
import { toast } from '../../../stores/toastStore';

/**
 * Start or end a direct message call from the conversation header.
 *
 * INTERIM (WP-G11 → WP-G12): the call pill (spec §5) carries calls once it
 * exists; until then a DM's header keeps the one control the Lantern header had
 * for it. The behavior is unchanged: 'dm' is the sentinel that selects the DM
 * voice endpoint, and a failed start offers the guided connection check right
 * where the failure appeared.
 */
export function useDmCall(dmChannelId: string | undefined, allowed: boolean, denialReason: string | null) {
  const { connected, channelId: voiceChannelId, joinChannel, leaveChannel } = useVoice();
  const [loading, setLoading] = useState(false);
  const [showCheck, setShowCheck] = useState(false);

  const inCall = Boolean(dmChannelId && connected && voiceChannelId === dmChannelId);

  const toggle = async () => {
    if (!dmChannelId || (!inCall && !allowed)) return;
    if (inCall) {
      await leaveChannel();
      return;
    }
    setLoading(true);
    try {
      await joinChannel(dmChannelId, 'dm');
      const voiceState = useVoiceStore.getState();
      if (voiceState.connectionError && voiceState.connectionErrorChannelId === dmChannelId) {
        toast.error(`Could not start voice call: ${voiceState.connectionError}`, undefined, {
          label: 'Run connection check',
          onClick: () => setShowCheck(true),
        });
      }
    } catch {
      toast.error('Could not start voice call.', undefined, {
        label: 'Run connection check',
        onClick: () => setShowCheck(true),
      });
    } finally {
      setLoading(false);
    }
  };

  return {
    inCall,
    loading,
    disabled: loading || (!inCall && !allowed),
    reason: inCall ? null : denialReason,
    toggle: () => void toggle(),
    showCheck,
    closeCheck: () => setShowCheck(false),
  };
}
