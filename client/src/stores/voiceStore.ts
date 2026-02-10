import { create } from 'zustand';
import type { VoiceState } from '../types';
import { voiceApi } from '../api/voice';
import { Room, RoomEvent, DisconnectReason, type Participant } from 'livekit-client';
import { useAuthStore } from './authStore';

const INTERNAL_LIVEKIT_HOSTS = new Set([
  'host.docker.internal',
  'livekit',
  'docker-livekit-1',
]);

function resolveClientRtcHostname(): string {
  if (typeof window === 'undefined') {
    return 'localhost';
  }
  const host = window.location.hostname;
  if (!host) {
    return 'localhost';
  }
  // Tauri and local dev hosts should map to loopback for local LiveKit.
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) {
    return 'localhost';
  }
  return host;
}

function normalizeLivekitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (INTERNAL_LIVEKIT_HOSTS.has(parsed.hostname)) {
      parsed.hostname = resolveClientRtcHostname();
    }
    // livekit-client can fail on URLs normalized to "...//rtc" when base path is "/".
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url
      .replace('host.docker.internal', 'localhost')
      .replace('livekit', 'localhost')
      .replace(/\/+$/, '');
  }
}

interface VoiceStoreState {
  connected: boolean;
  joining: boolean;
  joiningChannelId: string | null;
  connectionError: string | null;
  connectionErrorChannelId: string | null;
  channelId: string | null;
  guildId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  selfStream: boolean;
  selfVideo: boolean;
  // Voice states for all users in current channel, keyed by user ID
  participants: Map<string, VoiceState>;
  // Global voice participants across all channels, keyed by channel ID
  channelParticipants: Map<string, VoiceState[]>;
  // Set of user IDs currently speaking (from LiveKit)
  speakingUsers: Set<string>;
  // LiveKit connection info
  livekitToken: string | null;
  livekitUrl: string | null;
  roomName: string | null;
  room: Room | null;

  joinChannel: (channelId: string, guildId?: string) => Promise<void>;
  leaveChannel: () => Promise<void>;
  toggleMute: () => void;
  toggleDeaf: () => void;
  startStream: (qualityPreset?: string) => Promise<void>;
  stopStream: () => void;
  toggleVideo: () => void;
  clearConnectionError: () => void;

  // Gateway event handlers
  handleVoiceStateUpdate: (state: VoiceState) => void;
  // Load initial voice states from READY payload
  loadVoiceStates: (states: VoiceState[]) => void;
  // Speaking state from LiveKit
  setSpeakingUsers: (userIds: string[]) => void;
}

export const useVoiceStore = create<VoiceStoreState>()((set, get) => ({
  connected: false,
  joining: false,
  joiningChannelId: null,
  connectionError: null,
  connectionErrorChannelId: null,
  channelId: null,
  guildId: null,
  selfMute: false,
  selfDeaf: false,
  selfStream: false,
  selfVideo: false,
  participants: new Map(),
  channelParticipants: new Map(),
  speakingUsers: new Set(),
  livekitToken: null,
  livekitUrl: null,
  roomName: null,
  room: null,

  joinChannel: async (channelId, guildId) => {
    const existingRoom = get().room;
    if (existingRoom) {
      existingRoom.removeAllListeners();
      existingRoom.disconnect();
    }
    let room: Room | null = null;
    set({
      joining: true,
      joiningChannelId: channelId,
      connectionError: null,
      connectionErrorChannelId: null,
    });
    try {
      const { data } = await voiceApi.joinChannel(channelId);
      room = new Room();
      const normalizedUrl = normalizeLivekitUrl(data.url);

      // Read saved audio device preferences from user settings.
      const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
      const savedInputId = typeof notif['audioInputDeviceId'] === 'string' ? notif['audioInputDeviceId'] as string : undefined;
      const savedOutputId = typeof notif['audioOutputDeviceId'] === 'string' ? notif['audioOutputDeviceId'] as string : undefined;

      // Prevent long client retries from making voice joins feel stuck.
      await Promise.race([
        room.connect(normalizedUrl, data.token),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Voice connection timed out.')), 12000);
        }),
      ]);

      // Apply saved audio output device before publishing so remote audio
      // plays through the correct speakers/headphones.
      if (savedOutputId) {
        await room.switchActiveDevice('audiooutput', savedOutputId).catch(() => { });
      }

      // Enable microphone with the saved input device (or default if unset).
      await room.localParticipant.setMicrophoneEnabled(true, savedInputId ? { deviceId: savedInputId } : undefined).catch(() => { });

      // Listen for active speaker changes to power the speaking indicator
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const speakingIds = speakers.map((s) => s.identity);
        get().setSpeakingUsers(speakingIds);
      });

      // Clean up store state when LiveKit disconnects unexpectedly (e.g.
      // signaling timeout, server-side room deletion). Without this the
      // store stays in connected=true while the room is dead.
      // Capture `room` in closure so we can check it's still the active room.
      const thisRoom = room;
      room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // Ignore disconnect events from stale rooms (e.g. when joinChannel
        // was called again, the old room fires Disconnected asynchronously).
        if (get().room !== thisRoom) return;
        console.warn('[voice] LiveKit room disconnected, reason:', reason);
        const cId = get().channelId;
        if (cId) {
          voiceApi.leaveChannel(cId).catch(() => { });
        }
        const auth = useAuthStore.getState().user;
        set((prev) => {
          const channelParticipants = new Map(prev.channelParticipants);
          if (cId && auth) {
            const members = channelParticipants.get(cId);
            if (members) {
              const filtered = members.filter((p) => p.user_id !== auth.id);
              if (filtered.length === 0) channelParticipants.delete(cId);
              else channelParticipants.set(cId, filtered);
            }
          }
          return {
            connected: false,
            channelId: null,
            guildId: null,
            selfMute: false,
            selfDeaf: false,
            selfStream: false,
            selfVideo: false,
            participants: new Map(),
            channelParticipants,
            speakingUsers: new Set<string>(),
            livekitToken: null,
            livekitUrl: null,
            roomName: null,
            room: null,
            joining: false,
            joiningChannelId: null,
          };
        });
      });

      // Add local user to channelParticipants immediately so the sidebar
      // shows them without waiting for the gateway VOICE_STATE_UPDATE event.
      const authUser = useAuthStore.getState().user;
      set((prev) => {
        const channelParticipants = new Map(prev.channelParticipants);
        if (authUser) {
          const localVoiceState: VoiceState = {
            user_id: authUser.id,
            channel_id: channelId,
            guild_id: guildId,
            session_id: '',
            deaf: false,
            mute: false,
            self_deaf: false,
            self_mute: false,
            self_stream: false,
            self_video: false,
            suppress: false,
            username: authUser.username,
            avatar_hash: authUser.avatar_hash,
          };
          const existing = (channelParticipants.get(channelId) || []).filter(
            (p) => p.user_id !== authUser.id
          );
          existing.push(localVoiceState);
          channelParticipants.set(channelId, existing);
        }
        return {
          connected: true,
          joining: false,
          joiningChannelId: null,
          channelId,
          guildId: guildId || null,
          livekitToken: data.token,
          livekitUrl: normalizedUrl,
          roomName: data.room_name,
          room,
          participants: new Map(),
          channelParticipants,
        };
      });
    } catch (error) {
      room?.disconnect();
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Unable to connect to voice right now.';
      set({
        connected: false,
        joining: false,
        joiningChannelId: null,
        channelId: null,
        guildId: null,
        room: null,
        selfStream: false,
        livekitToken: null,
        livekitUrl: null,
        roomName: null,
        connectionError: message,
        connectionErrorChannelId: channelId,
      });
      throw error;
    }
  },

  leaveChannel: async () => {
    const { channelId } = get();
    if (channelId) {
      await voiceApi.leaveChannel(channelId).catch((err) => {
        console.warn('[voice] leave channel API error (continuing disconnect):', err);
      });
    }
    const authUser = useAuthStore.getState().user;
    const currentRoom = get().room;
    if (currentRoom) {
      currentRoom.removeAllListeners();
      currentRoom.disconnect();
    }
    set((state) => {
      // Remove local user from channelParticipants
      const channelParticipants = new Map(state.channelParticipants);
      if (channelId && authUser) {
        const members = channelParticipants.get(channelId);
        if (members) {
          const filtered = members.filter((p) => p.user_id !== authUser.id);
          if (filtered.length === 0) {
            channelParticipants.delete(channelId);
          } else {
            channelParticipants.set(channelId, filtered);
          }
        }
      }
      return {
        connected: false,
        channelId: null,
        guildId: null,
        selfMute: false,
        selfDeaf: false,
        selfStream: false,
        selfVideo: false,
        participants: new Map(),
        channelParticipants,
        speakingUsers: new Set<string>(),
        livekitToken: null,
        livekitUrl: null,
        roomName: null,
        room: null,
        joining: false,
        joiningChannelId: null,
        connectionError: null,
        connectionErrorChannelId: null,
      };
    });
  },

  toggleMute: () =>
    set((state) => {
      const nextSelfMute = !state.selfMute;
      state.room?.localParticipant.setMicrophoneEnabled(!nextSelfMute).catch(() => { });
      return {
        selfMute: nextSelfMute,
        selfDeaf: nextSelfMute ? state.selfDeaf : false,
      };
    }),

  toggleDeaf: () =>
    set((state) => ({
      selfDeaf: !state.selfDeaf,
      selfMute: !state.selfDeaf ? true : state.selfMute,
    })),

  startStream: async (qualityPreset = '1080p60') => {
    const { channelId, room } = get();
    if (!channelId || !room) {
      throw new Error('Voice connection is not ready');
    }
    try {
      // 1. Register stream on server and get an upgraded token with
      //    screen-share publish permissions.
      const { data } = await voiceApi.startStream(channelId, { quality_preset: qualityPreset });

      // 2. Reconnect to the LiveKit room with the upgraded stream token so
      //    LiveKit grants us permission to publish screen-share tracks.
      //    Remove listeners before disconnect so the Disconnected event
      //    from this intentional disconnect doesn't reset the store.
      const normalizedUrl = normalizeLivekitUrl(data.url);
      room.removeAllListeners();
      await room.disconnect();
      await room.connect(normalizedUrl, data.token);

      // Restore saved audio devices after reconnect.
      const streamNotif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
      const streamOutputId = typeof streamNotif['audioOutputDeviceId'] === 'string' ? streamNotif['audioOutputDeviceId'] as string : undefined;
      const streamInputId = typeof streamNotif['audioInputDeviceId'] === 'string' ? streamNotif['audioInputDeviceId'] as string : undefined;
      if (streamOutputId) {
        await room.switchActiveDevice('audiooutput', streamOutputId).catch(() => { });
      }

      // Re-enable microphone after reconnect with saved input device
      await room.localParticipant.setMicrophoneEnabled(!get().selfMute, streamInputId ? { deviceId: streamInputId } : undefined).catch(() => { });

      // Re-attach event listeners after reconnect
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const speakingIds = speakers.map((s) => s.identity);
        get().setSpeakingUsers(speakingIds);
      });
      const streamRoom = room;
      room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (get().room !== streamRoom) return;
        console.warn('[voice] LiveKit room disconnected (stream), reason:', reason);
        const cId = get().channelId;
        if (cId) voiceApi.leaveChannel(cId).catch(() => { });
        const auth = useAuthStore.getState().user;
        set((prev) => {
          const channelParticipants = new Map(prev.channelParticipants);
          if (cId && auth) {
            const members = channelParticipants.get(cId);
            if (members) {
              const filtered = members.filter((p) => p.user_id !== auth.id);
              if (filtered.length === 0) channelParticipants.delete(cId);
              else channelParticipants.set(cId, filtered);
            }
          }
          return {
            connected: false, channelId: null, guildId: null,
            selfMute: false, selfDeaf: false, selfStream: false, selfVideo: false,
            participants: new Map(), channelParticipants,
            speakingUsers: new Set<string>(),
            livekitToken: null, livekitUrl: null, roomName: null,
            room: null, joining: false, joiningChannelId: null,
          };
        });
      });

      // 3. Now that we have the right permissions, start screen share
      //    with resolution/framerate constraints matching the preset.
      const presetMap: Record<string, { width: number; height: number; frameRate: number }> = {
        '720p30': { width: 1280, height: 720, frameRate: 30 },
        '1080p60': { width: 1920, height: 1080, frameRate: 60 },
        '1440p60': { width: 2560, height: 1440, frameRate: 60 },
        '4k60': { width: 3840, height: 2160, frameRate: 60 },
      };
      const capture = presetMap[qualityPreset] ?? presetMap['1080p60'];

      await room.localParticipant.setScreenShareEnabled(true, {
        audio: false,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
        resolution: { width: capture.width, height: capture.height, frameRate: capture.frameRate },
        contentHint: 'motion',
      });
      set({
        selfStream: true,
        livekitToken: data.token,
        livekitUrl: normalizedUrl,
        roomName: data.room_name,
      });
    } catch (error) {
      await room.localParticipant.setScreenShareEnabled(false).catch(() => { });
      set({ selfStream: false });
      throw error;
    }
  },

  stopStream: () =>
    set((state) => {
      state.room?.localParticipant.setScreenShareEnabled(false).catch(() => { });
      return { selfStream: false };
    }),

  toggleVideo: () => set((state) => ({ selfVideo: !state.selfVideo })),
  clearConnectionError: () => set({ connectionError: null, connectionErrorChannelId: null }),

  handleVoiceStateUpdate: (voiceState) => {
    set((state) => {
      const participants = new Map(state.participants);
      if (voiceState.channel_id) {
        participants.set(voiceState.user_id, voiceState);
      } else {
        participants.delete(voiceState.user_id);
      }

      // Update global channel participants
      const channelParticipants = new Map(state.channelParticipants);
      if (voiceState.channel_id) {
        const existing = channelParticipants.get(voiceState.channel_id) || [];
        const filtered = existing.filter((p) => p.user_id !== voiceState.user_id);
        filtered.push(voiceState);
        channelParticipants.set(voiceState.channel_id, filtered);
      } else {
        // User left — remove from all channels
        for (const [chId, members] of channelParticipants) {
          const filtered = members.filter((p) => p.user_id !== voiceState.user_id);
          if (filtered.length === 0) {
            channelParticipants.delete(chId);
          } else if (filtered.length !== members.length) {
            channelParticipants.set(chId, filtered);
          }
        }
      }

      return { participants, channelParticipants };
    });
  },

  loadVoiceStates: (states) =>
    set((prev) => {
      const channelParticipants = new Map(prev.channelParticipants);
      for (const vs of states) {
        if (!vs.channel_id) continue;
        const existing = channelParticipants.get(vs.channel_id) || [];
        existing.push(vs);
        channelParticipants.set(vs.channel_id, existing);
      }
      return { channelParticipants };
    }),

  setSpeakingUsers: (userIds) =>
    set(() => ({
      speakingUsers: new Set(userIds),
    })),
}));
