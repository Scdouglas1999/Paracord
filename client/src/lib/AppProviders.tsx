import { useEffect, type ReactNode } from 'react';
import { useGateway } from '../hooks/useGateway';
import { useTheme } from '../hooks/useTheme';
import { useVoiceKeybinds } from '../hooks/useVoiceKeybinds';
import { useActivityPresence } from '../hooks/useActivityPresence';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useServerListStore } from '../stores/serverListStore';
import { RestartBanner } from '../components/RestartBanner';
import { ConnectionStatusBar } from '../components/ConnectionStatusBar';
import { UpdateNotification } from '../components/UpdateNotification';
import { ToastContainer } from '../components/ui/Toast';
import { ImageLightbox } from '../components/ui/ImageLightbox';

function AppInitializer({ children }: { children: ReactNode }) {
  // Initialize gateway connection when authenticated
  useGateway();
  // Apply theme CSS variables on mount and when theme changes
  useTheme();
  // Register global voice keybind handlers from user settings
  useVoiceKeybinds();
  // Detect foreground desktop app and publish "Playing ..." presence.
  useActivityPresence();
  const token = useAuthStore((s) => s.token);
  const initializeSession = useAuthStore((s) => s.initializeSession);
  const hydrateServerTokens = useServerListStore((s) => s.hydrateTokens);
  const fetchUser = useAuthStore((s) => s.fetchUser);
  const fetchSettings = useAuthStore((s) => s.fetchSettings);
  const settings = useAuthStore((s) => s.settings);
  const fetchGuilds = useGuildStore((s) => s.fetchGuilds);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const applyAudioInputDevice = useVoiceStore((s) => s.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((s) => s.applyAudioOutputDevice);

  useEffect(() => {
    void hydrateServerTokens();
  }, [hydrateServerTokens]);

  useEffect(() => {
    void initializeSession();
  }, [initializeSession]);

  useEffect(() => {
    if (token) {
      void fetchUser();
      void fetchSettings();
      void fetchGuilds();
    }
  }, [token, fetchUser, fetchSettings, fetchGuilds]);

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

  return (
    <>
      <ConnectionStatusBar />
      <RestartBanner />
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
