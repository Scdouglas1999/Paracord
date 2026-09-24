import { findHomeServerEntry } from './serverIdentity';
import { LOCAL_SERVER_ID } from './serverScope';
import { useEffect, type ReactNode } from 'react';
import { useGateway } from '../hooks/useGateway';
import { useTheme } from '../hooks/useTheme';
import { useVoiceKeybinds } from '../hooks/useVoiceKeybinds';
import { useActivityPresence } from '../hooks/useActivityPresence';
import { useNowPlayingPresence } from '../hooks/useNowPlayingPresence';
import { useVoiceSpeakingReporter } from '../hooks/useVoiceSpeakingReporter';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { startAccountMessagingLifecycle, reconcileAccountMessaging } from './messages/accountMessagingRuntime';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { BannerStack } from '../components/BannerStack';
import { RestartBanner } from '../components/RestartBanner';
import { ConnectionStatusBar } from '../components/ConnectionStatusBar';
import { IncomingCallBanner } from '../components/dm/IncomingCallBanner';
import { UpdateNotification } from '../components/UpdateNotification';
import { ToastContainer } from '../components/ui/Toast';
import { ImageLightbox } from '../components/ui/ImageLightbox';
import { logVoiceDiagnostic } from './desktopDiagnostics';
import { startDownloadTicketLifecycle } from './downloadTicket';

function AppInitializer({ children }: { children: ReactNode }) {
  // Initialize gateway connection when authenticated
  const gwToken = useAuthStore((s) => s.token);
  const gwHydrated = useServerListStore((s) => s.hydrated);
  const gwTokensHydrated = useServerListStore((s) => s.tokensHydrated);
  const gwServerCount = useServerListStore((s) => s.servers.length);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    logVoiceDiagnostic('[diag] AppInitializer state', {
      hasToken: !!gwToken,
      hydrated: gwHydrated,
      tokensHydrated: gwTokensHydrated,
      serverCount: gwServerCount,
    });
  }, [gwToken, gwHydrated, gwTokensHydrated, gwServerCount]);

  useGateway();
  // Apply theme CSS variables on mount and when theme changes
  useTheme();
  // Register global voice keybind handlers from user settings
  useVoiceKeybinds();
  // Detect foreground desktop app and publish "Playing ..." presence.
  useActivityPresence();
  // "Share what I'm listening to" (desktop app): a "Listening to ..." activity.
  useNowPlayingPresence();
  // Tell people outside your voice channel when you are talking.
  useVoiceSpeakingReporter();
  const token = useAuthStore((s) => s.token);
  const homeUserId = useAuthStore(s => s.user?.id);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const servers = useServerListStore((s) => s.servers);
  // The one scope that names this account on the home server. On the desktop
  // the server the user added IS the home server, so the entry's id is that
  // scope; `__local__` is only the answer while no entry covers it.
  const homeEntry = findHomeServerEntry(servers, token);
  const homeScopeServerId = homeEntry?.id ?? LOCAL_SERVER_ID;
  const homeScopeUserId = homeEntry
    ? (homeEntry.token && homeEntry.user?.id === homeEntry.userId ? homeEntry.user?.id : undefined)
    : homeUserId;
  const initializeSession = useAuthStore((s) => s.initializeSession);
  const hydrateServerTokens = useServerListStore((s) => s.hydrateTokens);
  const fetchUser = useAuthStore((s) => s.fetchUser);
  const fetchSettings = useAuthStore((s) => s.fetchSettings);
  const settings = useAuthStore((s) => s.settings);
  const fetchGuilds = useGuildStore((s) => s.fetchGuilds);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const applyAudioInputDevice = useVoiceStore((s) => s.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((s) => s.applyAudioOutputDevice);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const flushOfflineQueue = reconcileAccountMessaging;

  useEffect(() => startAccountMessagingLifecycle(), []);

  useEffect(() => {
    void hydrateServerTokens();
  }, [hydrateServerTokens]);

  useEffect(() => {
    void initializeSession();
  }, [initializeSession]);

  useEffect(() => {
    if (token) {
      startDownloadTicketLifecycle();
    }
  }, [token, activeServerId]);

  useEffect(() => {
    if (token) {
      void fetchUser();
      void fetchSettings();

    }
  }, [token, fetchUser, fetchSettings, fetchGuilds]);

  // One server is one account. Fetching the home session's buildings under
  // `__local__` while the gateway filed the same buildings under the added
  // entry's scope is what listed every building twice on a fresh desktop
  // install — and counted every person in them twice. Ask once, under the id
  // that actually names this account.
  useEffect(() => {
    if (token && homeScopeUserId) void fetchGuilds({ serverId: homeScopeServerId, userId: homeScopeUserId });
  }, [token, homeScopeServerId, homeScopeUserId, fetchGuilds]);

  useEffect(() => {
    if (!voiceConnected || !settings) return;
    const notif = settings.notifications as Record<string, unknown> | undefined;
    const inputId = typeof notif?.['audioInputDeviceId'] === 'string' ? notif['audioInputDeviceId'] : null;
    const outputId =
      typeof notif?.['audioOutputDeviceId'] === 'string' ? notif['audioOutputDeviceId'] : null;
    void applyAudioInputDevice(inputId);
    void applyAudioOutputDevice(outputId);
  }, [
    voiceConnected,
    settings,
    applyAudioInputDevice,
    applyAudioOutputDevice,
  ]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    void flushOfflineQueue();
  }, [connectionStatus, flushOfflineQueue]);

  useEffect(() => {
    const handleOnline = () => {
      void flushOfflineQueue();
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [flushOfflineQueue]);

  return (
    <>
      {/* One stacked column, and the shell reserves its height — a banner
          must not land on top of the app's own top row. */}
      <BannerStack>
        <ConnectionStatusBar />
        <IncomingCallBanner />
        <RestartBanner />
      </BannerStack>
      <UpdateNotification />
      <ToastContainer />
      <ImageLightbox />
      {children}
    </>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return <AppInitializer>{children}</AppInitializer>;
}
