import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Headphones, MessageSquare, Pencil, Trash2 } from 'lucide-react';

import { extractApiError } from '../../../api/client';
import { copyChannelLink, useRoomMenu } from '../../../hooks/useRoomMenu';
import { usePermissions } from '../../../hooks/usePermissions';
import { LOCAL_SERVER_ID, type AccountScope } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { confirm } from '../../../stores/confirmStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { hasPermission, Permissions } from '../../../types';
import {
  joinCall,
  listenBlockReason,
  toggleListen,
  useListenBlockStore,
  type PillActionTarget,
} from '../../glass/pill/pillActions';
import type { SidebarRoom } from '../../glass/places/rows';
import type { ContextMenuItem } from '../../ui/ContextMenu';

/**
 * What the sidebar's rows do and what their right-click menus hold (docs/index-
 * spec.md §4.5, §4.6).
 *
 * A channel: the notification levels (the four radio rows, which are also how a
 * channel is muted), mark as read, copy the link; and, with Manage Channels, Edit
 * channel (server settings, at that channel) and Delete channel (confirms).
 *
 * A room: Listen in (a voice room; where the server allows it, with the server's
 * own sentence when it does not), Open chat (the room's text chat in main), copy
 * the link; the same two management rows.
 *
 * A click on a room row joins it (the prototype's behavior, defaults §13.5).
 */

export interface SidebarMenusInput {
  guildId: string;
  scope: AccountScope;
}

const divider = (): ContextMenuItem => ({ divider: true, label: '', action: () => {} });

export function useSidebarMenus({ guildId, scope }: SidebarMenusInput) {
  const navigate = useNavigate();
  const roomMenu = useRoomMenu();
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManage = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);
  const blocked = useListenBlockStore((state) => state.blocked);

  const targetOf = useCallback(
    (room: Pick<SidebarRoom, 'channelId' | 'name'>): PillActionTarget => ({
      serverId: useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID,
      guildId,
      channelId: room.channelId,
      title: room.name,
    }),
    [guildId],
  );

  const manage = useCallback(
    (channelId: string, name: string): ContextMenuItem[] =>
      canManage
        ? [
            divider(),
            {
              label: 'Edit channel',
              icon: <Pencil size={16} />,
              action: () => useUIStore.getState().openGuildSettings(guildId, 'channels', channelId),
            },
            {
              label: 'Delete channel',
              icon: <Trash2 size={16} />,
              danger: true,
              action: () => {
                void (async () => {
                  const ok = await confirm({
                    title: `Delete ${name}?`,
                    description: 'This permanently deletes the channel and its history.',
                    confirmLabel: 'Delete channel',
                    variant: 'danger',
                  });
                  if (!ok) return;
                  try {
                    await useChannelStore.getState().deleteChannel(channelId, scope);
                    toast.info('Channel deleted.');
                  } catch (error) {
                    toast.error(`Failed to delete ${name}: ${extractApiError(error)}`);
                  }
                })();
              },
            },
          ]
        : [],
    [canManage, guildId, scope],
  );

  const channelMenu = useCallback(
    (channelId: string, name: string): ContextMenuItem[] => {
      return [...roomMenu({ channelId, scope, guildId, name }), ...manage(channelId, name)];
    },
    [roomMenu, scope, guildId, manage],
  );

  const joinRoom = useCallback((room: SidebarRoom) => void joinCall(targetOf(room)), [targetOf]);

  const roomRowMenu = useCallback(
    (room: SidebarRoom): ContextMenuItem[] => {
      const target = targetOf(room);
      const items: ContextMenuItem[] = [];
      if (!room.stage) {
        const reason = listenBlockReason(blocked, target);
        items.push({
          label: 'Listen in',
          description: reason ?? undefined,
          icon: <Headphones size={16} />,
          disabled: reason !== null,
          action: () => void toggleListen(target, false),
        });
      }
      items.push(
        {
          label: 'Open chat',
          icon: <MessageSquare size={16} />,
          action: () => navigate(`/app/guilds/${guildId}/channels/${room.channelId}`),
        },
        divider(),
        { label: 'Copy link to channel', action: () => copyChannelLink({ guildId, channelId: room.channelId }) },
        ...manage(room.channelId, room.name),
      );
      return items;
    },
    [targetOf, blocked, navigate, guildId, manage],
  );

  return useMemo(() => ({ canManage, channelMenu, roomRowMenu, joinRoom }), [canManage, channelMenu, roomRowMenu, joinRoom]);
}

