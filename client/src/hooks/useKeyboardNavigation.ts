import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { gateway } from '../gateway/manager';

const DEFAULT_KEYBINDS: Record<string, string> = {
  toggleMute: 'Ctrl+Shift+M',
  toggleDeafen: 'Ctrl+Shift+D',
};

/**
 * Parse a keybind string like "Ctrl+Shift+M" and check if a KeyboardEvent
 * matches it.
 */
function matchesKeybind(e: KeyboardEvent, keybind: string | undefined): boolean {
  if (!keybind || keybind === 'Not set') return false;

  const parts = keybind.split('+').map((p) => p.trim());
  const requireCtrl = parts.includes('Ctrl');
  const requireShift = parts.includes('Shift');
  const requireAlt = parts.includes('Alt');
  const requireMeta = parts.includes('Meta');
  const key = parts.filter(
    (p) => !['Ctrl', 'Shift', 'Alt', 'Meta'].includes(p),
  )[0];

  if (!key) return false;

  if (e.ctrlKey !== requireCtrl) return false;
  if (e.shiftKey !== requireShift) return false;
  if (e.altKey !== requireAlt) return false;
  if (e.metaKey !== requireMeta) return false;

  // Compare key case-insensitively for single chars
  const eventKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return eventKey === key;
}

/**
 * Global keyboard shortcuts for the app shell:
 * - Alt+Up / Alt+Down: navigate to previous/next channel
 * - Ctrl+B: toggle server dock
 * - Escape: close open panels (command palette)
 * - Configurable voice keybinds (default: Ctrl+Shift+M = mute, Ctrl+Shift+D = deafen)
 */
export function useKeyboardNavigation() {
  const navigate = useNavigate();
  const { guildId } = useParams();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore events inside input/textarea/contenteditable to avoid conflicts
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // -- Escape: close panels regardless of focus --
      if (e.key === 'Escape') {
        const ui = useUIStore.getState();
        if (ui.commandPaletteOpen) {
          ui.setCommandPaletteOpen(false);
          e.preventDefault();
          return;
        }
        if (ui.searchPanelOpen) {
          ui.setSearchPanelOpen(false);
          e.preventDefault();
          return;
        }
        if (ui.memberPanelOpen) {
          ui.setMemberPanelOpen(false);
          e.preventDefault();
          return;
        }
        if (
          typeof window !== 'undefined'
          && window.matchMedia('(max-width: 768px)').matches
          && !ui.sidebarCollapsed
        ) {
          ui.setSidebarCollapsed(true);
          e.preventDefault();
          return;
        }
        // Don't override escape in UserSettings (it has its own handler)
        return;
      }

      // -- Ctrl+B: toggle dock --
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toUpperCase() === 'B') {
        e.preventDefault();
        useUIStore.getState().toggleDockPinned();
        return;
      }

      // The remaining shortcuts should not fire when editing text
      if (isEditing) return;

      // -- Alt+Up / Alt+Down: channel navigation --
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();

        const currentGuildId = guildId || useGuildStore.getState().selectedGuildId;
        if (!currentGuildId) return;

        const channelState = useChannelStore.getState();
        const guildChannels = (channelState.channelsByGuild[currentGuildId] || [])
          .filter((c) => c.type !== 4) // exclude categories
          .sort((a, b) => a.position - b.position);

        if (guildChannels.length === 0) return;

        const currentChannelId = channelState.selectedChannelId;
        const currentIndex = guildChannels.findIndex((c) => c.id === currentChannelId);

        let nextIndex: number;
        if (e.key === 'ArrowUp') {
          nextIndex = currentIndex <= 0 ? guildChannels.length - 1 : currentIndex - 1;
        } else {
          nextIndex = currentIndex >= guildChannels.length - 1 ? 0 : currentIndex + 1;
        }

        const nextChannel = guildChannels[nextIndex];
        if (nextChannel) {
          channelState.selectChannel(nextChannel.id);
          navigate(`/app/guilds/${currentGuildId}/channels/${nextChannel.id}`);
        }
        return;
      }

      // Read user-configured keybinds (fall back to defaults)
      const settings = useAuthStore.getState().settings;
      const keybinds: Record<string, string> = {
        ...DEFAULT_KEYBINDS,
        ...((settings?.keybinds as Record<string, string> | undefined) || {}),
      };

      // -- Toggle mute (configurable) --
      if (matchesKeybind(e, keybinds.toggleMute)) {
        e.preventDefault();
        const voiceState = useVoiceStore.getState();
        if (voiceState.connected) {
          void voiceState.toggleMute().then(() => {
            const s = useVoiceStore.getState();
            gateway.updateVoiceStateAll(s.guildId, s.channelId, s.selfMute, s.selfDeaf);
          });
        }
        return;
      }

      // -- Toggle deafen (configurable) --
      if (matchesKeybind(e, keybinds.toggleDeafen)) {
        e.preventDefault();
        const voiceState = useVoiceStore.getState();
        if (voiceState.connected) {
          void voiceState.toggleDeaf().then(() => {
            const s = useVoiceStore.getState();
            gateway.updateVoiceStateAll(s.guildId, s.channelId, s.selfMute, s.selfDeaf);
          });
        }
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, guildId]);
}


