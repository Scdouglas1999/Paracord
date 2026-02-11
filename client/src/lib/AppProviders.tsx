import { useEffect, type ReactNode } from 'react';
import { useGateway } from '../hooks/useGateway';
import { useTheme } from '../hooks/useTheme';
import { useVoiceKeybinds } from '../hooks/useVoiceKeybinds';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useVoiceStore } from '../stores/voiceStore';

function AppInitializer({ children }: { children: ReactNode }) {
  // Initialize gateway connection when authenticated
  useGateway();
  // Apply theme CSS variables on mount and when theme changes
  useTheme();
  // Register global voice keybind handlers from user settings
  useVoiceKeybinds();
  const token = useAuthStore((s) => s.token);
  const fetchUser = useAuthStore((s) => s.fetchUser);
  const fetchSettings = useAuthStore((s) => s.fetchSettings);
  const settings = useAuthStore((s) => s.settings);
  const fetchGuilds = useGuildStore((s) => s.fetchGuilds);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const applyAudioInputDevice = useVoiceStore((s) => s.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((s) => s.applyAudioOutputDevice);

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

  return <>{children}</>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return <AppInitializer>{children}</AppInitializer>;
}
