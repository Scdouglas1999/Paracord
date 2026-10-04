import { getAccountChannelView } from '../lib/channelView';
import { useSelectedGuildId } from './useGuilds';
import { useCurrentAccountScope } from './useCurrentUser';
import { nthServer, placeKeyAction, stepPlace } from '../components/ix/dock/dockModel';
import { useGoToPlace } from '../components/ix/dock/usePlaceNavigation';
import { placeKey } from '../components/ix/shell/place';
import { useCurrentPlace, usePlaceOrder } from '../components/ix/shell/usePlace';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useUIStore } from '../stores/uiStore';
import { isTauri } from '../lib/tauriEnv';
import { isMacOS } from '../lib/keyboardShortcuts';

/**
 * Global keyboard shortcuts for the app shell:
 * - Alt+Up / Alt+Down: navigate to previous/next channel
 * - Ctrl+Alt+Up / Ctrl+Alt+Down (⌥⌘↑/↓ on macOS): the previous/next place in the
 *   dock (People, then the servers; docs/index-spec.md §4.8)
 * - Ctrl+1…9 (⌘1…9): the nth server in the dock
 * - Ctrl+, : open user settings
 * - Ctrl+Shift+, : open current guild settings
 * - Mod+F: open channel message search (ContextPanel search mode)
 * - Ctrl+B: the old sidebar toggle; on a phone it brings places back (usePhoneNavigation)
 * - Escape: Command palette → ContextPanel → narrow sidebar overlay (§5 precedence)
 *
 * Mute/deafen keybinds are owned by useVoiceKeybinds (not duplicated here).
 */
export function useKeyboardNavigation() {
  const navigate = useNavigate();
  const { guildId } = useParams();
  const selectedGuildId = useSelectedGuildId();
  const scope = useCurrentAccountScope();
  const order = usePlaceOrder();
  const place = useCurrentPlace();
  const goToPlace = useGoToPlace();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Block browser shortcuts in Tauri desktop app (except Mod+F → search below)
      if (isTauri()) {
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
      // Command palette → ContextPanel (contextPanelMode) → narrow sidebar overlay.
      // Settings overlays keep their own Esc handler (useFocusTrap), so we defer to
      // them by not swallowing Escape here.
      if (e.key === 'Escape') {
        const ui = useUIStore.getState();
        if (ui.commandPaletteOpen) {
          ui.setCommandPaletteOpen(false);
          e.preventDefault();
          return;
        }
        // Modal dialogs and transient menus own the top layer of the Escape
        // stack. Their own handler closes exactly that surface; do not also
        // collapse the ContextPanel behind it on the same keypress.
        if (
          typeof document !== 'undefined'
          && document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')
        ) {
          return;
        }
        if (ui.contextPanelMode !== null) {
          ui.setContextPanelMode(null);
          e.preventDefault();
          return;
        }
        if (
          typeof window !== 'undefined'
          && window.matchMedia('(width < 768px)').matches
          && !ui.sidebarCollapsed
        ) {
          ui.setSidebarCollapsed(true);
          e.preventDefault();
          return;
        }
        // Don't override escape in UserSettings (it has its own handler)
        return;
      }

      // -- Mod+F: open message search for this channel or this server --
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (!isEditing) {
          const channelId = getAccountChannelView(scope).selectedChannelId;
          const currentGuildId = guildId || selectedGuildId;
          if (channelId || currentGuildId) {
            e.preventDefault();
            useUIStore.getState().setContextPanelMode('search');
          }
          return;
        }
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
        const currentGuildId = guildId || selectedGuildId;
        if (currentGuildId) {
          e.preventDefault();
          useUIStore.getState().setGuildSettingsId(currentGuildId);
        }
        return;
      }

      // -- Places (§4.8): Ctrl+Alt+Up/Down steps through the dock, Ctrl+1…9 jumps
      // to the nth server. Their modifiers never insert text, so they work while
      // typing; a modal dialog (focus trapped) keeps them from moving the app
      // behind it.
      const placeAction = placeKeyAction(e, isMacOS());
      if (placeAction) {
        if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-sheet])')) return;
        const target = placeAction.kind === 'step'
          ? stepPlace(order, placeKey(place), placeAction.delta)
          : nthServer(order, placeAction.n);
        if (!target) return;
        e.preventDefault();
        void goToPlace(target);
        return;
      }

      // The remaining shortcuts should not fire when editing text
      if (isEditing) return;

      // -- Alt+Up / Alt+Down: channel navigation --
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();

        const currentGuildId = guildId || selectedGuildId;
        if (!currentGuildId) return;

        const channelState = getAccountChannelView(scope);
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

      // Mute/deafen keybinds live exclusively in useVoiceKeybinds so a single
      // handler owns them (avoids double-toggle when both hooks are mounted).
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, guildId, selectedGuildId, scope, order, place, goToPlace]);
}


