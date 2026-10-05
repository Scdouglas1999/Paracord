import { useCallback, useMemo, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import {
  Bell,
  BellOff,
  CalendarDays,
  CheckCheck,
  LayoutGrid,
  Link2,
  LogOut,
  Plus,
  Settings,
  UserPlus,
} from 'lucide-react';

import type { NotificationLevel } from '../../../api/notificationSettings';
import { extractApiError } from '../../../api/client';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { writeClipboardText } from '../../../lib/clipboard';
import { activateGuild } from '../../../lib/guildNavigation';
import { markGuildRead } from '../../../lib/guildActions';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import { accountScopeKey, entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { confirm } from '../../../stores/confirmStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useNotificationPreferenceStore } from '../../../stores/notificationPreferenceStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { eventsHref } from '../../guild/eventsRoute';
import { ChannelType, hasPermission, Permissions } from '../../../types';
import { IxGlyph } from '../glyphs';
import type { MenuAnchor } from './anchor';
import { closeMenu, openCreateChannel, openInvite, openServerMenu, useMenuHostStore, useServerMenuOpenFor, type ServerRef } from './hostStore';
import { IxMenu, type IxMenuEntry } from './IxMenu';
import { SERVER_LEVEL_LABEL, serverLevel, setServerLevel } from './serverNotifications';
import { useGuildAccess } from './useGuildPermissions';

/**
 * The server menu (docs/index-spec.md §6.2). Opened by "..." in the sidebar's
 * header, a right click on the header, or a right click on the server's dock
 * mark; a popover 240 wide:
 *
 *   Overview · Invite people · Events · Notifications > (All messages / Only
 *   mentions / Nothing) · Mark as read · Mute server · Create channel · Create
 *   room (both need Manage Channels) · Server settings (permitted) · Copy link ·
 *   Leave server (danger ink, confirms; not for the owner).
 *
 * HOW TO OPEN IT (IX-5's header, IX-6's dock): call `openServerMenu(server,
 * anchor)` from `components/ix/menus` with `server = { guildId, scope, name }`
 * (a `ScopedGuild` from `useAvailableGuilds()` has all three) and an anchor: the
 * "..." button (`{ element, align: 'end' }`) or the pointer (`{ x, y }`, or
 * `anchorFromEvent(event)`). `useServerMenuOpenFor(guildId)` is the button's
 * `aria-expanded`. The menu is mounted once by the sheet slot; nothing renders it
 * at the call site.
 *
 * Rows that depend on who you are are decided by `buildServerMenu` from plain
 * booleans, so what each role sees is a unit test and not a screenshot.
 */

export type { ServerRef } from './hostStore';

const glyph = (Icon: typeof Bell) => <Icon size={16} strokeWidth={1.7} />;

export interface ServerMenuInput {
  name: string;
  muted: boolean;
  /** The server's own level; `serverLevel()` of its setting. */
  level: NotificationLevel;
  isOwner: boolean;
  can: {
    createInvite: boolean;
    manageChannels: boolean;
    settings: boolean;
  };
  /** A text channel exists to mint an invite through. */
  hasInviteChannel: boolean;
  /** Saving the mute is in flight. */
  saving?: boolean;
}

export interface ServerMenuActions {
  overview: () => void;
  invite: () => void;
  events: () => void;
  setLevel: (level: NotificationLevel) => void;
  markRead: () => void;
  toggleMute: () => void;
  createChannel: () => void;
  createRoom: () => void;
  settings: () => void;
  copyLink: () => void;
  leave: () => void;
}

/** The menu's rows, in the spec's order, for this person in this server. */
export function buildServerMenu(input: ServerMenuInput, actions: ServerMenuActions): IxMenuEntry[] {
  const { can } = input;
  const levelItem = (level: NotificationLevel) => ({
    type: 'item' as const,
    id: `level-${level}`,
    label: SERVER_LEVEL_LABEL[level],
    checked: input.level === level,
    onSelect: () => actions.setLevel(level),
    keepOpen: true,
    testId: `ix-menu-level-${level}`,
  });

  const entries: IxMenuEntry[] = [
    { type: 'item', id: 'overview', label: 'Overview', icon: glyph(LayoutGrid), onSelect: actions.overview },
  ];
  if (can.createInvite && input.hasInviteChannel) {
    entries.push({ type: 'item', id: 'invite', label: 'Invite people', icon: glyph(UserPlus), onSelect: actions.invite });
  }
  entries.push(
    { type: 'item', id: 'events', label: 'Events', icon: glyph(CalendarDays), onSelect: actions.events },
    {
      type: 'group',
      id: 'notifications',
      label: 'Notifications',
      icon: glyph(Bell),
      items: [levelItem(0), levelItem(1), levelItem(2)],
      testId: 'ix-menu-notifications',
    },
    { type: 'separator', id: 'sep-read' },
    { type: 'item', id: 'mark-read', label: 'Mark as read', icon: glyph(CheckCheck), onSelect: actions.markRead },
    {
      type: 'item',
      id: 'mute',
      label: input.muted ? 'Unmute server' : 'Mute server',
      icon: input.muted ? glyph(Bell) : glyph(BellOff),
      disabled: input.saving,
      onSelect: actions.toggleMute,
    },
  );

  if (can.manageChannels) {
    entries.push(
      { type: 'separator', id: 'sep-create' },
      { type: 'item', id: 'create-channel', label: 'Create channel', icon: glyph(Plus), onSelect: actions.createChannel },
      { type: 'item', id: 'create-room', label: 'Create voice channel', icon: <IxGlyph name="speaker" size={16} />, onSelect: actions.createRoom },
    );
  }

  entries.push({ type: 'separator', id: 'sep-settings' });
  if (can.settings) {
    entries.push({ type: 'item', id: 'settings', label: 'Server settings', icon: glyph(Settings), onSelect: actions.settings });
  }
  entries.push({ type: 'item', id: 'copy-link', label: 'Copy link', icon: glyph(Link2), onSelect: actions.copyLink });

  if (!input.isOwner) {
    entries.push(
      { type: 'separator', id: 'sep-leave' },
      { type: 'item', id: 'leave', label: 'Leave server', icon: glyph(LogOut), danger: true, onSelect: actions.leave },
    );
  }
  return entries;
}

/** The link "Copy link" puts on the clipboard: the server's Overview. */
export function serverLink(guildId: string): string {
  const path = `/app/guilds/${guildId}`;
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}

export function ServerMenuView({ server, anchor, open = true }: { server: ServerRef; anchor: MenuAnchor; open?: boolean }) {
  const navigate = useNavigate();
  const reference = useMemo(() => ({ id: server.guildId, scope: server.scope }), [server.guildId, server.scope]);
  const key = entityScopeKey(server.scope, server.guildId);
  const { mutedGuildKeys, toggleMute, saving } = useMutedGuilds();
  const setting = useNotificationPreferenceStore((state) => state.byAccount[accountScopeKey(server.scope)]?.[server.guildId]);
  const access = useGuildAccess(server.guildId, server.scope);
  const channels = useChannelStore((state) => state.channelsByGuild[key]);
  const inviteChannel = useMemo(
    () => (channels ?? []).find((channel) => (channel.type ?? channel.channel_type) === ChannelType.Text),
    [channels],
  );

  const input: ServerMenuInput = {
    name: server.name,
    muted: mutedGuildKeys.includes(key),
    level: serverLevel(setting),
    isOwner: access.isOwner,
    can: {
      createInvite: hasPermission(access.permissions, Permissions.CREATE_INSTANT_INVITE),
      manageChannels: hasPermission(access.permissions, Permissions.MANAGE_CHANNELS),
      settings: canAccessGuildSettings(access.permissions, access.isAdmin),
    },
    hasInviteChannel: Boolean(inviteChannel),
    saving: saving[key] ?? false,
  };

  const failure = useCallback((what: string, error: unknown) => toast.error(`${what}: ${extractApiError(error)}`), []);

  const actions: ServerMenuActions = {
    overview: () => {
      try {
        activateGuild(reference);
        navigate(`/app/guilds/${server.guildId}`);
      } catch (error) {
        failure(`Failed to open ${server.name}`, error);
      }
    },
    invite: () => {
      if (inviteChannel) openInvite({ guildName: server.name, channelId: inviteChannel.id });
    },
    events: () => {
      try {
        activateGuild(reference);
        navigate(eventsHref(server.guildId));
      } catch (error) {
        failure(`Failed to open ${server.name}`, error);
      }
    },
    setLevel: (level) => {
      void setServerLevel(reference, level).catch((error) => failure('Failed to update server notifications', error));
    },
    markRead: () => {
      void markGuildRead(reference).catch((error) => failure('Failed to save read positions', error));
    },
    toggleMute: () => {
      void toggleMute(reference);
    },
    createChannel: () => openCreateChannel({ guildId: server.guildId, scope: server.scope, kind: 'text' }),
    createRoom: () => openCreateChannel({ guildId: server.guildId, scope: server.scope, kind: 'room' }),
    settings: () => {
      try {
        activateGuild(reference);
        useUIStore.getState().setGuildSettingsId(server.guildId);
      } catch (error) {
        failure(`Failed to open ${server.name}`, error);
      }
    },
    copyLink: () => {
      void writeClipboardText(serverLink(server.guildId))
        .then(() => toast.success('Link copied.'))
        .catch((error) => failure('Could not copy the link', error));
    },
    leave: () => {
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
          failure('Failed to leave server', error);
        }
      })();
    },
  };

  const entries = buildServerMenu(input, actions);
  return (
    <IxMenu
      open={open}
      onClose={closeMenu}
      anchor={anchor}
      label={`${server.name} menu`}
      width={240}
      entries={entries}
      testId="ix-server-menu"
    />
  );
}

/**
 * The shape the Glass places panel used (`useServerMenu()` from
 * components/glass/places/ServerMenu.tsx), kept so a caller that has not moved to
 * `openServerMenu` still works. The menu itself is rendered by the host, so
 * `element` is null.
 */
export interface ServerMenuControl {
  element: null;
  openFromElement: (server: ServerRef, anchor: RefObject<HTMLElement | null>) => void;
  openAtPoint: (server: ServerRef, position: { x: number; y: number }) => void;
  isOpenFor: (guildId: string | null) => boolean;
}

export function useServerMenu(): ServerMenuControl {
  const open = useMenuHostStore((state) => state.menu);
  return useMemo<ServerMenuControl>(
    () => ({
      element: null,
      // The "..." button at the header's right edge: the menu hangs from its right
      // edge. A second press closes the menu it opened.
      openFromElement: (server, anchor) => {
        const element = anchor.current;
        if (!element) return;
        const current = useMenuHostStore.getState().menu;
        if (
          current?.kind === 'server' &&
          current.server.guildId === server.guildId &&
          'element' in current.anchor &&
          current.anchor.element === element
        ) {
          closeMenu();
          return;
        }
        openServerMenu(server, { element, align: 'end' });
      },
      openAtPoint: (server, position) => openServerMenu(server, position),
      isOpenFor: (guildId) => open?.kind === 'server' && open.server.guildId === guildId,
    }),
    [open],
  );
}

export { openServerMenu, useServerMenuOpenFor };
