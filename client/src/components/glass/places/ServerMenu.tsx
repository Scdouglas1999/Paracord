import { useCallback, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { Bell, BellOff, CheckCheck, LayoutGrid, LogOut, Settings, UserPlus } from 'lucide-react';

import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { activateGuild } from '../../../lib/guildNavigation';
import { markGuildRead } from '../../../lib/guildActions';
import { canAccessGuildSettingsSync } from '../../../lib/guildSettingsAccess';
import { findScopedGuild } from '../../../lib/guildScope';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../../../lib/serverScope';
import { ChannelType } from '../../../types';
import { confirm } from '../../../stores/confirmStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { InviteModal } from '../../guild/InviteModal';

/**
 * The server menu: what the server title opens (docs/glass-spec.md §3.1) and what
 * a right click on a server's circle opens. It is the Lantern sidebar's building
 * menu (mute, mark as read, server settings, leave), re-homed here with the two
 * doors a Glass panel needs that the sidebar had elsewhere: the server's overview
 * (the server home page, which the reference draws no row for) and invite.
 *
 * WP-G18 turns this into the server sheet (`glassStore.openSheet('server')`); the
 * items and their behavior carry over.
 */

export interface ServerRef {
  guildId: string;
  scope: AccountScope;
  name: string;
}

interface OpenMenu {
  server: ServerRef;
  /** Opened from the title (so the title says it is expanded), or from a right click. */
  fromTitle: boolean;
  position: { x: number; y: number };
}

export interface ServerMenuControl {
  /** Render this once, anywhere in the panel. */
  element: ReactNode;
  /** Opens under `anchor`, left-aligned to it (the server title). */
  openFromElement: (server: ServerRef, anchor: RefObject<HTMLElement | null>) => void;
  openAtPoint: (server: ServerRef, position: { x: number; y: number }) => void;
  /** Is the menu open for this server, from the title? (`aria-expanded`.) */
  isOpenFor: (guildId: string | null) => boolean;
}

export function useServerMenu(): ServerMenuControl {
  const navigate = useNavigate();
  const currentScope = useCurrentAccountScope();
  const { mutedGuildKeys, toggleMute, saving } = useMutedGuilds();
  // The menu keeps its last server while it plays its leave: `open` is what was
  // opened last, `visible` is whether it is showing.
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const [visible, setVisible] = useState(false);
  const [invite, setInvite] = useState<{ guildName: string; channelId: string } | null>(null);

  const close = useCallback(() => setVisible(false), []);

  const items = useMemo<ContextMenuItem[]>(() => {
    if (!open) return [];
    const { server } = open;
    const reference = { id: server.guildId, scope: server.scope };
    const key = entityScopeKey(server.scope, server.guildId);
    const muted = mutedGuildKeys.includes(key);
    const guild = findScopedGuild(useGuildStore.getState().guilds, server.scope, server.guildId);
    const isOwner = Boolean(server.scope.userId && guild?.owner_id === server.scope.userId);

    const entries: ContextMenuItem[] = [
      {
        label: 'Overview',
        icon: <LayoutGrid size={16} />,
        action: () => {
          try {
            activateGuild(reference);
            navigate(`/app/guilds/${server.guildId}`);
          } catch (error) {
            toast.error(`Failed to open ${server.name}: ${extractApiError(error)}`);
          }
        },
      },
    ];

    // An invite is minted through the server you are on; only offer it there.
    const onThisServer = Boolean(currentScope) && accountScopeKey(currentScope as AccountScope) === accountScopeKey(server.scope);
    const channels = useChannelStore.getState().channelsByGuild[key] ?? [];
    const inviteChannel = channels.find((channel) => (channel.type ?? channel.channel_type) === ChannelType.Text);
    if (onThisServer && inviteChannel) {
      entries.push({
        label: 'Invite people',
        icon: <UserPlus size={16} />,
        action: () => setInvite({ guildName: server.name, channelId: inviteChannel.id }),
      });
    }

    entries.push(
      { divider: true, label: '', action: () => {} },
      {
        label: muted ? 'Unmute server' : 'Mute server',
        icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
        disabled: saving[key] ?? false,
        action: () => {
          void toggleMute(reference);
        },
      },
      {
        label: 'Mark as read',
        icon: <CheckCheck size={16} />,
        action: () => {
          void markGuildRead(reference).catch((error) =>
            toast.error(`Failed to save read positions: ${extractApiError(error)}`),
          );
        },
      },
    );

    if (canAccessGuildSettingsSync(server.guildId, server.scope)) {
      entries.push({
        label: 'Server settings',
        icon: <Settings size={16} />,
        action: () => {
          activateGuild(reference);
          useUIStore.getState().setGuildSettingsId(server.guildId);
        },
      });
    }

    if (!isOwner) {
      entries.push({
        label: 'Leave server',
        icon: <LogOut size={16} />,
        danger: true,
        action: () => {
          void (async () => {
            const ok = await confirm({
              title: `Leave ${server.name}?`,
              description: 'You will need an invite to come back to this server.',
              confirmLabel: 'Leave server',
              variant: 'danger',
            });
            if (!ok) return;
            try {
              await useGuildStore.getState().leaveGuild(server.guildId, server.scope);
              toast.success(`Left ${server.name}.`);
              if (typeof window !== 'undefined' && window.location.pathname.includes(`/guilds/${server.guildId}`)) {
                navigate('/app');
              }
            } catch (error) {
              toast.error(`Failed to leave server: ${extractApiError(error)}`);
            }
          })();
        },
      });
    }
    return entries;
  }, [open, mutedGuildKeys, saving, toggleMute, navigate, currentScope]);

  const openMenu = useCallback((next: OpenMenu) => {
    setOpen(next);
    setVisible(true);
  }, []);

  const control = useMemo<ServerMenuControl>(
    () => ({
      element: null,
      openFromElement: (server, anchor) => {
        // Left-aligned under the title, where the eye is, not under its far corner.
        const rect = anchor.current?.getBoundingClientRect();
        openMenu({ server, fromTitle: true, position: rect ? { x: rect.left + 10, y: rect.bottom - 2 } : { x: 0, y: 0 } });
      },
      openAtPoint: (server, position) => openMenu({ server, fromTitle: false, position }),
      isOpenFor: (guildId) => visible && open?.fromTitle === true && open.server.guildId === guildId,
    }),
    [openMenu, visible, open],
  );

  const shown = open;
  return {
    ...control,
    element: (
      <>
        <ContextMenu
          label={shown ? `${shown.server.name} menu` : 'Server menu'}
          open={visible}
          items={items}
          position={shown?.position}
          onClose={close}
        />
        {invite && (
          <InviteModal guildName={invite.guildName} channelId={invite.channelId} onClose={() => setInvite(null)} />
        )}
      </>
    ),
  };
}
