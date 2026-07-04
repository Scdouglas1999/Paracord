import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { toggleVoiceMute, toggleVoiceDeaf } from './useVoice';
import { isTauri } from '../lib/tauriEnv';

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
 * - Ctrl+Alt+Up / Ctrl+Alt+Down: switch previous/next guild
 * - Ctrl+, : open user settings
 * - Ctrl+Shift+, : open current guild settings
 * - Ctrl+B: toggle Unified Sidebar collapse
 * - ArrowUp/Down + Home/End: roving-tabindex nav within the sidebar row list
 * - Escape: Command Palette → ContextPanel → narrow sidebar overlay (§5 precedence)
 * - Configurable voice keybinds (default: Ctrl+Shift+M = mute, Ctrl+Shift+D = deafen)
 */
export function useKeyboardNavigation() {
  const navigate = useNavigate();
  const { guildId } = useParams();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Block browser shortcuts in Tauri desktop app
      if (isTauri()) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); return; }
        if (e.key === 'F12') { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i')) { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'J' || e.key === 'j')) { e.preventDefault(); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) { e.preventDefault(); return; }
      }

      // Ignore events inside input/textarea/contenteditable to avoid conflicts
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // -- Escape: close panels regardless of focus (layout-spec §5 precedence) --
      // Command Palette → ContextPanel (contextPanelMode) → narrow sidebar overlay.
      // Settings overlays keep their own Esc handler (useFocusTrap), so we defer to
      // them by not swallowing Escape here.
      if (e.key === 'Escape') {
        const ui = useUIStore.getState();
        if (ui.commandPaletteOpen) {
          ui.setCommandPaletteOpen(false);
          e.preventDefault();
          return;
        }
        if (ui.contextPanelMode !== null) {
          ui.setContextPanelMode(null);
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

      // -- Ctrl+B: toggle sidebar collapse (layout-spec §5) --
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toUpperCase() === 'B') {
        e.preventDefault();
        useUIStore.getState().toggleSidebarCollapsed();
        return;
      }

      // -- Ctrl+, : open user settings --
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ',') {
        e.preventDefault();
        useUIStore.getState().setUserSettingsOpen(true);
        return;
      }

      // -- Ctrl+Shift+, : open current guild settings --
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === ',') {
        const currentGuildId = guildId || useGuildStore.getState().selectedGuildId;
        if (currentGuildId) {
          e.preventDefault();
          useUIStore.getState().setGuildSettingsId(currentGuildId);
        }
        return;
      }

      // -- Sidebar roving-tabindex navigation (layout-spec §5) --
      // When focus is inside the Unified Sidebar's flat row list (Needs-you →
      // Pinned → Recent → Spaces, exposed via [data-nav-index] rows inside the
      // [data-roving-container]), ArrowUp/Down move between rows, Home/End jump to
      // the ends. Enter/Space fall through to the row's native <button> activation.
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End')
        && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && typeof document !== 'undefined'
      ) {
        const container = document.querySelector('[data-roving-container]');
        const active = document.activeElement as HTMLElement | null;
        if (container && active && container.contains(active)) {
          const rows = Array.from(
            container.querySelectorAll<HTMLElement>('[data-nav-index]'),
          );
          if (rows.length === 0) return;
          const currentIndex = rows.findIndex((r) => r === active || r.contains(active));
          let nextIndex: number;
          if (e.key === 'Home') {
            nextIndex = 0;
          } else if (e.key === 'End') {
            nextIndex = rows.length - 1;
          } else if (e.key === 'ArrowUp') {
            nextIndex = currentIndex <= 0 ? rows.length - 1 : currentIndex - 1;
          } else {
            nextIndex = currentIndex >= rows.length - 1 ? 0 : currentIndex + 1;
          }
          e.preventDefault();
          rows[nextIndex]?.focus();
          return;
        }
      }

      // The remaining shortcuts should not fire when editing text
      if (isEditing) return;

      // -- Ctrl+Alt+Up / Ctrl+Alt+Down: guild navigation --
      if (e.ctrlKey && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const guilds = useGuildStore.getState().guilds;
        if (guilds.length === 0) return;

        const currentGuildId = guildId || useGuildStore.getState().selectedGuildId;
        const currentIndex = guilds.findIndex((guild) => guild.id === currentGuildId);
        const startIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex =
          e.key === 'ArrowUp'
            ? (startIndex - 1 + guilds.length) % guilds.length
            : (startIndex + 1) % guilds.length;

        const nextGuild = guilds[nextIndex];
        if (!nextGuild) return;
        useGuildStore.getState().selectGuild(nextGuild.id);
        useChannelStore.getState().selectGuild(nextGuild.id);
        navigate(`/app/guilds/${nextGuild.id}`);
        return;
      }

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
        if (useVoiceStore.getState().connected) {
          void toggleVoiceMute();
        }
        return;
      }

      // -- Toggle deafen (configurable) --
      if (matchesKeybind(e, keybinds.toggleDeafen)) {
        e.preventDefault();
        if (useVoiceStore.getState().connected) {
          void toggleVoiceDeaf();
        }
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, guildId]);
}


