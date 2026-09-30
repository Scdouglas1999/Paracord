import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bell,
  HelpCircle,
  Image as ImageIcon,
  Inbox,
  MessagesSquare,
  Pin,
  Settings,
  Share2,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { extractApiError } from '../../../api/client';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { useCurrentReadStates } from '../../../hooks/useReadStates';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import { entityScopeKey } from '../../../lib/serverScope';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ReadState } from '../../../types';
import type { ConversationSubject } from '../shell/slots';
import type { ContextMenuItem } from '../../ui/ContextMenu';
import { HelpOverlay } from '../../layout/overlays/HelpOverlay';
import { InboxOverlay } from '../../layout/overlays/InboxOverlay';
import { closeSheets } from '../sheets';
import { toggleContextPanel } from './sheetBridge';

/**
 * The channel menu behind the conversation title (docs/glass-spec.md §3.2,
 * WP-G11), with the dialogs its rows open.
 *
 * INTERIM (WP-G11 → WP-G18): these are the actions the Lantern header's
 * "More" menu carried, moved here unchanged so nothing in the product becomes
 * unreachable when the header is replaced. WP-G18 builds the real channel menu
 * (`glassStore.sheet === 'channel'`) and takes this hook, its dialogs and the
 * shared overlays over. Search and people are not here: they have their own
 * header buttons.
 *
 * Counts on pins and threads (a Lantern header nicety) are not carried; the
 * Glass header has no room for them and the panels list their own contents.
 */

export interface ChannelMenuInput {
  subject: ConversationSubject;
  /** Whether the server allows a catch-up summary here, and why not. */
  summary: { allowed: boolean; reason: string | null };
}

export interface ChannelMenu {
  items: ContextMenuItem[];
  /** The dialogs the rows open. Render once, anywhere in the header. */
  dialogs: ReactNode;
  /** Unread conversations and mentions elsewhere (the inbox row's caption). */
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

export function useChannelMenu({ subject, summary }: ChannelMenuInput): ChannelMenu {
  const isDM = subject.kind === 'dm';
  const channelId = subject.channelId;
  const guildId = subject.kind === 'channel' ? subject.guildId : undefined;

  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const selectedChannel = channelsById[channelId];
  const allChannels = useMemo(() => Object.values(channelsById), [channelsById]);
  const isAnnouncement = selectedChannel?.type === 5 || selectedChannel?.channel_type === 5;

  const { permissions, isAdmin } = usePermissions(isDM ? null : (guildId ?? null));
  const canOpenServerSettings = !isDM && Boolean(guildId) && canAccessGuildSettings(permissions, isAdmin);

  const readScope = useCurrentAccountScope();
  const readStateRecord = useCurrentReadStates();
  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);
  const { mutedGuildKeys } = useMutedGuilds();

  const [showInbox, setShowInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const closeSurfaces = useCallback(() => {
    setShowInbox(false);
    setShowHelp(false);
  }, []);

  // One secondary surface at a time: a dialog replaces an open sheet, so one
  // Escape closes exactly one visible layer.
  const prepareSurface = useCallback(() => {
    closeSurfaces();
    closeSheets();
  }, [closeSurfaces]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!(showInbox || showHelp)) return;
      event.preventDefault();
      closeSurfaces();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeSurfaces, showHelp, showInbox]);

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

  const openInbox = async () => {
    prepareSurface();
    setInboxError(null);
    try {
      if (!readScope) throw new Error('Sign in to this instance before opening the inbox.');
      await useReadStateStore.getState().refresh(readScope);
    } catch (err) {
      setInboxError(`Failed to load inbox: ${extractApiError(err)}`);
    }
    setShowInbox(true);
  };

  const panel = (mode: Parameters<typeof toggleContextPanel>[0]) => () => {
    closeSurfaces();
    toggleContextPanel(mode);
  };

  const items: ContextMenuItem[] = [
    {
      label: 'Catch up summary',
      icon: <Sparkles size={17} />,
      action: panel('summary'),
      disabled: !summary.allowed,
      description: summary.reason ?? undefined,
    },
    { label: 'Pinned messages', icon: <Pin size={17} />, action: panel('pins') },
    ...(!isDM ? [{ label: 'Threads', icon: <MessagesSquare size={17} />, action: panel('threads') }] : []),
    ...(isAnnouncement
      ? [{ label: 'Manage follows', icon: <Share2 size={17} />, action: panel('follows') }]
      : []),
    { label: 'Media', icon: <ImageIcon size={17} />, action: panel('media') },
    ...(!isDM ? [{ label: 'Server leaderboard', icon: <TrendingUp size={17} />, action: panel('leaderboard') }] : []),
    ...(!isDM ? [{ label: 'Notifications', icon: <Bell size={17} />, action: panel('notifications') }] : []),
    ...(canOpenServerSettings && guildId
      ? [{
          label: 'Server settings',
          icon: <Settings size={17} />,
          action: () => {
            prepareSurface();
            useUIStore.getState().setGuildSettingsId(guildId);
          },
        }]
      : []),
    { label: '', action: () => {}, divider: true },
    {
      label: 'Inbox',
      icon: <Inbox size={17} />,
      action: () => void openInbox(),
      description: attentionCaption(unreadItems.length, mentions),
    },
    { label: 'Keyboard shortcuts', icon: <HelpCircle size={17} />, action: () => { prepareSurface(); setShowHelp(true); } },
  ];

  const dialogs = (
    <>
      <InboxOverlay
        open={showInbox}
        onClose={() => setShowInbox(false)}
        unreadItems={unreadItems}
        allChannels={allChannels}
        error={inboxError}
      />

      <HelpOverlay open={showHelp} onClose={() => setShowHelp(false)} />
    </>
  );

  return { items, dialogs, attention: { unread: unreadItems.length, mentions } };
}
