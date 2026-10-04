import { useEffect, useMemo, type ReactNode } from 'react';
import { extractApiError } from '../../../api/client';
import { writeClipboardText } from '../../../lib/clipboard';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { useCurrentReadStates } from '../../../hooks/useReadStates';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import { hasPermission, Permissions } from '../../../types';
import { entityScopeKey } from '../../../lib/serverScope';
import { toast } from '../../../stores/toastStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ReadState } from '../../../types';
import type { ConversationSubject } from '../shell/slots';
import type { ContextMenuItem } from '../../ui/ContextMenu';
import { buildChannelMenu, channelLink } from '../../ix/menus/ChannelMenu';
import type { IxMenuEntry } from '../../ix/menus/IxMenu';
import { openChannelSheet } from '../sheets';

/**
 * The Glass header's channel menu, now a thin adapter over the Index channel menu
 * model (components/ix/menus/ChannelMenu.tsx, docs/index-spec.md §6.5).
 *
 * INTERIM (IX-9 → IX-15): the Glass `ConversationHeader` still renders its title
 * menu with the shared `ContextMenu`, so it takes its rows from the same
 * `buildChannelMenu` that feeds the Index popover: one list, no drift. IX-15
 * replaces the header with the large title that calls `openChannelMenu`, and
 * deletes this file. Inbox and Keyboard shortcuts are no longer in this menu
 * (Inbox is People's page, the shortcuts are the account menu's); `dialogs` is
 * kept so the header's call site still type-checks, and renders nothing.
 */

export interface ChannelMenuInput {
  subject: ConversationSubject;
  /** Whether the server allows a catch-up summary here, and why not. */
  summary: { allowed: boolean; reason: string | null };
}

export interface ChannelMenu {
  items: ContextMenuItem[];
  /** Kept for the header's call site; the dialogs it once rendered moved out. */
  dialogs: ReactNode;
  /** Unread conversations and mentions elsewhere (the title's description). */
  attention: { unread: number; mentions: number };
}

export function attentionCaption(unread: number, mentions: number): string {
  const conversations = `${unread} unread conversation${unread === 1 ? '' : 's'}`;
  return mentions > 0
    ? `${mentions} mention${mentions === 1 ? '' : 's'} in ${conversations}`
    : unread > 0
      ? conversations
      : 'No unread conversations';
}

/** A menu model as the shared `ContextMenu`'s rows. */
export function toContextItems(entries: IxMenuEntry[]): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator') items.push({ label: '', action: () => {}, divider: true });
    else if (entry.type === 'item') {
      items.push({
        label: entry.label,
        icon: entry.icon,
        description: entry.description,
        disabled: entry.disabled,
        danger: entry.danger,
        shortcut: entry.hint,
        selected: entry.checked,
        action: entry.onSelect,
      });
    }
  }
  return items;
}

export function useChannelMenu({ subject, summary }: ChannelMenuInput): ChannelMenu {
  const isDM = subject.kind === 'dm';
  const channelId = subject.channelId;
  const guildId = subject.kind === 'channel' ? subject.guildId : undefined;

  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const selectedChannel = channelsById[channelId];
  const allChannels = useMemo(() => Object.values(channelsById), [channelsById]);
  const isAnnouncement = selectedChannel?.type === 5 || selectedChannel?.channel_type === 5;

  const { permissions, isAdmin } = usePermissions(isDM ? null : (guildId ?? null));
  const canEdit = !isDM && Boolean(guildId) && (isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS));

  const readScope = useCurrentAccountScope();
  const readStateRecord = useCurrentReadStates();
  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);
  const { mutedGuildKeys } = useMutedGuilds();

  // Read state lives in the shared store, kept live by dispatch and mark-read
  // call sites; pull an authoritative snapshot once on mount.
  useEffect(() => {
    void useReadStateStore.getState().refreshAll();
  }, []);

  const unreadItems = useMemo(() => {
    const result: Array<{ state: ReadState; channelName: string }> = [];
    const stateByChannel = new Map(readStates.map((state) => [state.channel_id, state]));
    for (const channel of allChannels) {
      if (channel.id === channelId) continue;
      if (channel.guild_id && readScope && mutedGuildKeys.includes(entityScopeKey(readScope, channel.guild_id))) {
        continue;
      }
      if (!channel.last_message_id || channel.type === 4 || channel.channel_type === 4) continue;
      const state = stateByChannel.get(channel.id) ?? {
        channel_id: channel.id,
        last_message_id: '',
        mention_count: 0,
      };
      if (isMessageUnread(channel.last_message_id, state.last_message_id)) {
        result.push({ state, channelName: channel.name || state.channel_id });
      }
    }
    result.sort((a, b) => b.state.mention_count - a.state.mention_count);
    return result;
  }, [readStates, allChannels, mutedGuildKeys, channelId, readScope]);
  const mentions = unreadItems.reduce((total, item) => total + item.state.mention_count, 0);

  const entries = buildChannelMenu(
    { isDm: isDM, isAnnouncement, summary, canEdit },
    {
      page: (page) => openChannelSheet(page),
      edit: () => {
        if (guildId) useUIStore.getState().openGuildSettings(guildId, 'channels', channelId);
      },
      copyLink: () => {
        void writeClipboardText(channelLink(subject.kind === 'channel'
          ? { kind: 'channel', guildId: subject.guildId, channelId }
          : { kind: 'dm', channelId }))
          .then(() => toast.success('Link copied.'))
          .catch((error) => toast.error(`Could not copy the link: ${extractApiError(error)}`));
      },
    },
  );

  return { items: toContextItems(entries), dialogs: null, attention: { unread: unreadItems.length, mentions } };
}
