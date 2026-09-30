import { useEffect } from 'react';

import { toggleVoiceMute, toggleVoiceVideo } from '../../../hooks/useVoice';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType } from '../../../types';

/**
 * A stage channel's audience publishes nothing, on this device as well as at
 * the media server. While you are in a stage channel's call and the server's
 * voice state says you are not a speaker (`suppress`), the microphone is muted
 * and the camera and any screen share are stopped, so a later invitation to
 * speak never resumes them without your own press.
 *
 * Mounted once by the Glass frame, so it holds wherever you are in the app, not
 * only while the channel is on screen (the Lantern voice page did this only
 * while it was open).
 */
export function useStageAudienceGuard(): void {
  const connected = useVoiceStore((state) => state.connected);
  const channelId = useVoiceStore((state) => state.channelId);
  const callScope = useVoiceStore((state) => state.callScope);
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfVideo = useVoiceStore((state) => state.selfVideo);
  const selfStream = useVoiceStore((state) => state.selfStream);
  const suppressed = useVoiceStore((state) => {
    if (!state.channelId || !state.callScope) return null;
    const self = state.channelParticipants.get(state.channelId)?.find((vs) => vs.user_id === state.callScope?.userId);
    return self ? self.suppress !== false : null;
  });
  const isStage = useChannelStore((state) => {
    if (!callScope || !channelId) return false;
    const channel = state.channelsById[entityScopeKey(callScope, channelId)];
    return channel?.type === ChannelType.Stage || channel?.channel_type === ChannelType.Stage;
  });

  // Until the server has said who you are in the call, a stage treats you as its audience.
  const audience = connected && isStage && suppressed !== false;

  useEffect(() => {
    if (!audience) return;
    const voice = useVoiceStore.getState();
    if (!voice.selfMute) void toggleVoiceMute();
    if (voice.selfVideo) void toggleVoiceVideo().catch(() => {});
    if (voice.selfStream) voice.stopStream();
  }, [audience, selfMute, selfVideo, selfStream]);
}
