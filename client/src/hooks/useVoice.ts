import { useCallback } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import { gateway } from '../gateway/manager';

export function useVoice() {
  const connected = useVoiceStore((s) => s.connected);
  const joining = useVoiceStore((s) => s.joining);
  const joiningChannelId = useVoiceStore((s) => s.joiningChannelId);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const connectionErrorChannelId = useVoiceStore((s) => s.connectionErrorChannelId);
  const channelId = useVoiceStore((s) => s.channelId);
  const guildId = useVoiceStore((s) => s.guildId);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const selfStream = useVoiceStore((s) => s.selfStream);
  const selfVideo = useVoiceStore((s) => s.selfVideo);
  const participants = useVoiceStore((s) => s.participants);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const micInputActive = useVoiceStore((s) => s.micInputActive);
  const micInputLevel = useVoiceStore((s) => s.micInputLevel);
  const micServerDetected = useVoiceStore((s) => s.micServerDetected);
  const micUplinkState = useVoiceStore((s) => s.micUplinkState);
  const micUplinkBytesSent = useVoiceStore((s) => s.micUplinkBytesSent);
  const micUplinkStalledIntervals = useVoiceStore((s) => s.micUplinkStalledIntervals);
  const startStreamStore = useVoiceStore((s) => s.startStream);
  const stopStreamStore = useVoiceStore((s) => s.stopStream);
  const clearConnectionError = useVoiceStore((s) => s.clearConnectionError);

  const joinChannel = useCallback(
    async (targetChannelId: string, targetGuildId?: string) => {
      try {
        await useVoiceStore.getState().joinChannel(targetChannelId, targetGuildId);
        // The join/leave REST endpoints are authoritative for membership.
        // Only send a gateway update here when we need to sync non-default
        // mute/deafen state immediately after connecting.
        const state = useVoiceStore.getState();
        if (state.selfMute || state.selfDeaf) {
          gateway.updateVoiceStateAll(
            targetGuildId || state.guildId,
            targetChannelId,
            state.selfMute,
            state.selfDeaf
          );
        }
      } catch (err) {
        console.error('[voice] Failed to join channel:', err);
      }
    },
    []
  );

  const leaveChannel = useCallback(async () => {
    await useVoiceStore.getState().leaveChannel();
  }, []);

  const toggleMute = useCallback(async () => {
    await useVoiceStore.getState().toggleMute();
    // Send gateway update after the async mic operation settles so the
    // server always reflects the actual mute outcome (the store reverts
    // selfMute if the mic enable fails).
    const state = useVoiceStore.getState();
    gateway.updateVoiceStateAll(
      state.guildId,
      state.channelId,
      state.selfMute,
      state.selfDeaf
    );
  }, []);

  const toggleDeaf = useCallback(async () => {
    await useVoiceStore.getState().toggleDeaf();
    const state = useVoiceStore.getState();
    gateway.updateVoiceStateAll(
      state.guildId,
      state.channelId,
      state.selfMute,
      state.selfDeaf
    );
  }, []);

  const startStream = useCallback(async (qualityPreset?: string) => {
    await startStreamStore(qualityPreset);
  }, [startStreamStore]);

  const stopStream = useCallback(() => {
    stopStreamStore();
  }, [stopStreamStore]);

  const toggleVideo = useCallback(() => {
    useVoiceStore.getState().toggleVideo();
  }, []);

  return {
    connected,
    joining,
    joiningChannelId,
    connectionError,
    connectionErrorChannelId,
    channelId,
    guildId,
    selfMute,
    selfDeaf,
    selfStream,
    selfVideo,
    participants,
    livekitToken,
    livekitUrl,
    micInputActive,
    micInputLevel,
    micServerDetected,
    micUplinkState,
    micUplinkBytesSent,
    micUplinkStalledIntervals,
    joinChannel,
    leaveChannel,
    toggleMute,
    toggleDeaf,
    startStream,
    stopStream,
    toggleVideo,
    clearConnectionError,
  };
}


