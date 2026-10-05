import type { ReactNode } from 'react';
import {
  Bell,
  Image as ImageIcon,
  Link2,
  MessagesSquare,
  Pencil,
  Pin,
  Share2,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

import { extractApiError } from '../../../api/client';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { usePermissions } from '../../../hooks/usePermissions';
import { writeClipboardText } from '../../../lib/clipboard';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { hasPermission, Permissions } from '../../../types';
import { openChannelSheet, type ChannelSheetPage } from '../../glass/sheets/sheetStore';
import type { MenuAnchor } from './anchor';
import { closeMenu, type ChannelMenuRequest } from './hostStore';
import { IxMenu, type IxMenuEntry } from './IxMenu';

/**
 * The channel menu (docs/index-spec.md §6.5): the large or folded channel title
 * opens a popover with Summary (catch up), Pinned, Threads, Media, Follows
 * (announcement channels), Leaderboard, Notifications, Edit channel (permitted)
 * and Copy link. Each page row opens the channel sheet on that page (a segmented
 * control at the sheet's top moves between them). Inbox and Help are not here:
 * Inbox is People's page, Help is the account menu's Keyboard shortcuts.
 *
 * HOW TO OPEN IT (IX-15's title): `openChannelMenu({ subject, summary }, anchor)`
 * from `components/ix/menus`, with the title's element as the anchor
 * (`{ element, align: 'start' }`). `summary` is `useConversationActions`'s
 * `actions.summary`. The menu is mounted once by the sheet slot.
 *
 * The rows are decided by `buildChannelMenu` from plain booleans (a unit test),
 * and the same model feeds the Glass header's menu until IX-15 retires it
 * (`components/glass/conversation/useChannelMenu`).
 */

const glyph = (Icon: typeof Bell) => <Icon size={16} strokeWidth={1.7} />;

export interface ChannelMenuInput {
  /** A direct message or a group: no threads, follows, leaderboard or per-channel notification page. */
  isDm: boolean;
  isAnnouncement: boolean;
  summary: { allowed: boolean; reason: string | null };
  /** May edit this channel (Manage Channels in a server; never in a DM). */
  canEdit: boolean;
}

export interface ChannelMenuActions {
  page: (page: ChannelSheetPage) => void;
  edit: () => void;
  copyLink: () => void;
}

export function buildChannelMenu(input: ChannelMenuInput, actions: ChannelMenuActions): IxMenuEntry[] {
  const page = (id: ChannelSheetPage, label: string, icon: ReactNode, extra?: { disabled?: boolean; description?: string }): IxMenuEntry => ({
    type: 'item',
    id,
    label,
    icon,
    testId: `ix-menu-${id}`,
    onSelect: () => actions.page(id),
    ...extra,
  });
  const entries: IxMenuEntry[] = [
    page('summary', 'Catch up summary', glyph(Sparkles), {
      disabled: !input.summary.allowed,
      description: input.summary.reason ?? undefined,
    }),
    page('pins', 'Pinned messages', glyph(Pin)),
  ];
  if (!input.isDm) entries.push(page('threads', 'Threads', glyph(MessagesSquare)));
  entries.push(page('media', 'Media', glyph(ImageIcon)));
  if (!input.isDm && input.isAnnouncement) entries.push(page('follows', 'Follows', glyph(Share2)));
  if (!input.isDm) {
    entries.push(page('leaderboard', 'Leaderboard', glyph(TrendingUp)));
    entries.push(page('notifications', 'Notifications', glyph(Bell)));
  }
  entries.push({ type: 'separator', id: 'sep-manage' });
  if (input.canEdit) {
    entries.push({ type: 'item', id: 'edit', label: 'Edit channel', icon: glyph(Pencil), onSelect: actions.edit, testId: 'ix-menu-edit' });
  }
  entries.push({ type: 'item', id: 'copy-link', label: 'Copy link', icon: glyph(Link2), onSelect: actions.copyLink, testId: 'ix-menu-copy-link' });
  return entries;
}

export function channelLink(subject: ChannelMenuRequest['subject']): string {
  const path = subject.kind === 'channel'
    ? `/app/guilds/${subject.guildId}/channels/${subject.channelId}`
    : `/app/dms/${subject.channelId}`;
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}

export function ChannelMenuView({ request, anchor, open = true }: { request: ChannelMenuRequest; anchor: MenuAnchor; open?: boolean }) {
  const { subject, summary } = request;
  const isDm = subject.kind === 'dm';
  const guildId = subject.kind === 'channel' ? subject.guildId : null;
  const channel = useCurrentChannelStore((state) => state.channelsById[subject.channelId]);
  const { permissions, isAdmin } = usePermissions(guildId);

  const input: ChannelMenuInput = {
    isDm,
    isAnnouncement: channel?.type === 5 || channel?.channel_type === 5,
    summary,
    canEdit: !isDm && Boolean(guildId) && (isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS)),
  };

  const entries = buildChannelMenu(input, {
    page: (page) => openChannelSheet(page),
    edit: () => {
      if (guildId) useUIStore.getState().openGuildSettings(guildId, 'channels', subject.channelId);
    },
    copyLink: () => {
      void writeClipboardText(channelLink(subject))
        .then(() => toast.success('Link copied.'))
        .catch((error) => toast.error(`Could not copy the link: ${extractApiError(error)}`));
    },
  });

  return (
    <IxMenu
      open={open}
      onClose={closeMenu}
      anchor={anchor}
      label="Channel actions"
      width={248}
      entries={entries}
      testId="ix-channel-menu"
    />
  );
}
