import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Bookmark, Check, CheckCheck, Clock, Inbox, Loader2, MessageSquare, MessagesSquare, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Message, ReadState } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { extractApiError } from '../../../api/client';
import { toast } from '../../../stores/toastStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useSavedMessageStore } from '../../../stores/savedMessageStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { channelApi } from '../../../api/channels';
import { relativeTime } from '../../../lib/formatters';
import { messagePreviewText } from '../../../lib/markdown';
import { fetchGuildRoles } from '../../../lib/permissionDataCache';
import { RollingNumber } from '../../../lib/motion';
import { GlassButton } from '../../glass/primitives';
import { SheetAlert, SheetEmpty, SheetStatus } from '../../glass/sheets/SheetParts';
import { TopBarOverlay } from './TopBarOverlay';
import { RemindersPane } from './RemindersPane';
import { useReminderStore } from '../../../stores/reminderStore';

interface UnreadItem {
  state: ReadState;
  channelName: string;
}

interface InboxChannel {
  id: string;
  guild_id?: string | null;
  last_message_id?: string | null;
}

interface InboxOverlayProps {
  open: boolean;
  onClose: () => void;
  unreadItems: UnreadItem[];
  allChannels: InboxChannel[];
  error?: string | null;
}

type InboxTab = 'mentions' | 'unread' | 'saved' | 'reminders';
const EMPTY_SAVED_ITEMS: ReturnType<typeof useSavedMessageStore.getState>['items'] = [];

function messagePreview(message: Message | null | undefined, roleNames?: ReadonlyMap<string, string>): string {
  if (message === undefined) return 'Loading latest message…';
  if (message === null) return 'Preview unavailable';
  // Plain words, as every other preview: a role mention reads "@Design".
  const content = message.e2ee ? '' : messagePreviewText(message.content ?? '', undefined, roleNames);
  if (content) return content;
  if (message.forwarded_from?.content) return `Forwarded: ${messagePreviewText(message.forwarded_from.content, undefined, roleNames)}`;
  if (message.poll?.question) return `Poll: ${message.poll.question}`;
  if (message.attachments[0]?.filename) return `Attachment: ${message.attachments[0].filename}`;
  if (message.e2ee) return 'Encrypted message';
  return 'New activity';
}

function authorName(message: Message): string {
  return message.author.display_name?.trim() || message.author.username;
}

export function InboxOverlay({ open, onClose, unreadItems, allChannels, error }: InboxOverlayProps) {
  const navigate = useNavigate();
  const readScope = useCurrentAccountScope();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<InboxTab>('unread');
  const [previews, setPreviews] = useState<Record<string, Message | null>>({});
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const serverScope = useServerListStore((state) => state.activeServerId ?? '__local__');
  const savedItems = useSavedMessageStore((state) => state.serverId === serverScope ? state.items : EMPTY_SAVED_ITEMS);
  const savedLoading = useSavedMessageStore((state) => state.serverId === serverScope && state.loading);
  const savedError = useSavedMessageStore((state) => state.serverId === serverScope ? state.error : null);
  const reminderCount = useReminderStore((state) => state.serverId === serverScope ? state.items.length : 0);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  // Role names for the servers these previews come from.
  const [roleNames, setRoleNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const previewGuildIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channel of allChannels) if (channel.guild_id) ids.add(channel.guild_id);
    return [...ids].sort().join(',');
  }, [allChannels]);
  useEffect(() => {
    if (!open || !previewGuildIds) return;
    let canceled = false;
    void Promise.all(previewGuildIds.split(',').map((guildId) => fetchGuildRoles(guildId)))
      .then((lists) => {
        if (canceled) return;
        setRoleNames(new Map(lists.flat().map((role) => [role.id, role.name])));
      })
      .catch((err) => {
        if (!canceled) toast.error(`Role names in these previews could not load: ${extractApiError(err)}`);
      });
    return () => {
      canceled = true;
    };
  }, [open, previewGuildIds]);

  const mentionItems = useMemo(
    () => unreadItems.filter(({ state }) => state.mention_count > 0),
    [unreadItems],
  );

  const wasOpen = useRef(false);
  useEffect(() => {
    const newlyOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!newlyOpened) return;
    setTab(mentionItems.length > 0 ? 'mentions' : 'unread');
    void useSavedMessageStore.getState().load(true);
  }, [open, mentionItems.length]); // Reset only for a newly opened inbox, not as live read states change.

  useEffect(() => {
    if (!open || unreadItems.length === 0) return;
    let canceled = false;
    const channelIds = unreadItems.slice(0, 20).map(({ state }) => state.channel_id);
    void Promise.all(channelIds.map(async (channelId) => {
      try {
        const { data } = await channelApi.getMessages(channelId, { limit: 1 });
        if (!canceled) {
          setPreviews((current) => ({ ...current, [channelId]: data[0] ?? null }));
        }
      } catch {
        if (!canceled) {
          setPreviews((current) => ({ ...current, [channelId]: null }));
        }
      }
    }));
    return () => {
      canceled = true;
    };
  }, [open, unreadItems]);

  const goToChannel = (channelId: string, messageId?: string, knownGuildId?: string | null) => {
    const channel = allChannels.find((candidate) => candidate.id === channelId);
    const guildId = knownGuildId ?? channel?.guild_id;
    const query = messageId ? `?message=${encodeURIComponent(messageId)}` : '';
    onClose();
    if (guildId) {
      navigate(`/app/guilds/${guildId}/channels/${channelId}${query}`);
    } else {
      navigate(`/app/dms/${channelId}${query}`);
    }
  };

  const markItemRead = (channelId: string) => {
    const channel = allChannels.find((candidate) => candidate.id === channelId);
    const lastId = channel?.last_message_id;
    if (!lastId || !readScope) return;
    useReadStateStore.getState().markRead(readScope, channelId, lastId);
    void useReadStateStore.getState().saveReadPosition(readScope, channelId, lastId).catch((err) => {
      toast.error(`Failed to save read position: ${extractApiError(err)}`);
    });
  };

  const markAllRead = async () => {
    if (markingAllRead || !readScope) return;
    const targets = unreadItems.flatMap(({ state }) => {
      const lastId = allChannels.find((channel) => channel.id === state.channel_id)?.last_message_id;
      return lastId ? [{ channelId: state.channel_id, lastId }] : [];
    });
    if (targets.length === 0) return;
    setMarkingAllRead(true);
    targets.forEach(({ channelId, lastId }) => {
      useReadStateStore.getState().markRead(readScope, channelId, lastId);
    });
    const results = await Promise.allSettled(
      targets.map(({ channelId, lastId }) => useReadStateStore.getState().saveReadPosition(readScope, channelId, lastId)),
    );
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures > 0) {
      toast.error(`Could not save ${failures} read position${failures === 1 ? '' : 's'}.`);
    } else {
      toast.success('Inbox marked as read.');
    }
    setMarkingAllRead(false);
  };

  const removeSaved = async (messageId: string) => {
    try {
      await useSavedMessageStore.getState().remove(messageId);
      toast.success('Removed from saved messages.');
    } catch (err) {
      toast.error(`Failed to remove saved message: ${extractApiError(err)}`);
    }
  };

  const visibleUnread = tab === 'mentions' ? mentionItems : unreadItems;
  const mentionCount = mentionItems.reduce((total, item) => total + item.state.mention_count, 0);

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-inbox-title"
      title="Inbox"
      closeLabel="Close inbox"
    >
      <div className="glass-inbox__bar">
        <div className="glass-sheet-tabs" role="tablist" aria-label="Inbox">
          {([
            ['mentions', 'Mentions', mentionCount],
            ['unread', 'Unread', unreadItems.length],
            ['saved', 'Saved', savedItems.length],
            ['reminders', 'Reminders', reminderCount],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className="glass-sheet-tab glass-focusable"
            >
              {label}
              {count > 0 && (
                <span className="glass-inbox__count glass-instrument">
                  {/* §5.1: the tab's count re-rolls as mentions land and are
                      read. The tab announces itself; the number stays silent. */}
                  <RollingNumber
                    value={count}
                    format={(n) => (n > 99 ? '99+' : String(n))}
                    announce={false}
                  />
                </span>
              )}
            </button>
          ))}
        </div>
        {tab !== 'saved' && unreadItems.length > 0 && (
          <GlassButton
            variant="text"
            onClick={() => void markAllRead()}
            disabled={markingAllRead}
          >
            {markingAllRead ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCheck size={14} aria-hidden />}
            Mark all read
          </GlassButton>
        )}
      </div>

      {error ? (
        <SheetAlert>{error}</SheetAlert>
      ) : tab === 'reminders' ? (
        <RemindersPane
          onOpen={(item) => goToChannel(item.channel.id, item.message.id, item.channel.guild_id)}
          empty={<SheetEmpty icon={<Clock size={20} />} title="No reminders">Choose Remind me on a message and it will come back here when it is due.</SheetEmpty>}
        />
      ) : tab === 'saved' ? (
        savedLoading && savedItems.length === 0 ? (
          <SheetStatus><Loader2 size={16} className="animate-spin" aria-hidden /> Loading saved messages…</SheetStatus>
        ) : savedError && savedItems.length === 0 ? (
          <SheetAlert>{savedError}</SheetAlert>
        ) : savedItems.length > 0 ? (
          <ul className="glass-sheet-cards">
            {savedItems.map((item) => (
              <li key={item.message.id} className="glass-pin">
                <button
                  type="button"
                  onClick={() => goToChannel(item.channel.id, item.message.id, item.channel.guild_id)}
                  className="glass-sheet-card glass-pin__card glass-focusable"
                >
                  <span className="glass-sheet-card__head">
                    <Bookmark size={14} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="glass-sheet-card__author">{authorName(item.message)}</span>
                    <span className="glass-sheet-line glass-inbox__where">in {item.channel.guild_id ? item.channel.name : item.channel.name}</span>
                    <span className="glass-sheet-card__when">{relativeTime(item.saved_at)}</span>
                  </span>
                  <span className="glass-sheet-card__body glass-inbox__preview">
                    {messagePreview(item.message, roleNames)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void removeSaved(item.message.id)}
                  aria-label={`Remove message from ${authorName(item.message)} from saved messages`}
                  className="glass-sheet-row__action glass-pin__unpin glass-focusable"
                  data-tone="danger"
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <SheetEmpty icon={<Bookmark size={20} />} title="Nothing saved yet">Save a message from its actions menu and it will stay here for later.</SheetEmpty>
        )
      ) : visibleUnread.length > 0 ? (
        <ul className="glass-sheet-list">
          {visibleUnread.map(({ state, channelName }) => {
            const channel = allChannels.find((candidate) => candidate.id === state.channel_id);
            const isGuildChannel = Boolean(channel?.guild_id);
            const preview = previews[state.channel_id];
            return (
              <li key={state.channel_id} className="glass-sheet-row glass-inbox__row">
                <button
                  type="button"
                  onClick={() => goToChannel(state.channel_id, preview?.id)}
                  className="glass-inbox__open glass-focusable"
                >
                  <span className="glass-sheet-row__lead" aria-hidden>
                    {isGuildChannel ? <MessagesSquare size={17} /> : <MessageSquare size={17} />}
                  </span>
                  <span className="glass-sheet-row__text">
                    <span className="glass-inbox__title">
                      <span className="glass-sheet-row__name">{channelName}</span>
                      {state.mention_count > 0 ? (
                        <span className="glass-badge-text glass-inbox__mention">
                          <RollingNumber
                            value={state.mention_count}
                            format={(n) => (n > 99 ? '99+' : String(n))}
                            announce={false}
                          />
                        </span>
                      ) : (
                        <span className="glass-inbox__dot" aria-hidden />
                      )}
                    </span>
                    {preview && <span className="glass-inbox__author">{authorName(preview)}</span>}
                    <span className="glass-sheet-row__detail">{messagePreview(preview, roleNames)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => markItemRead(state.channel_id)}
                  aria-label={`Mark ${channelName} as read`}
                  className="glass-sheet-row__action glass-focusable"
                >
                  <Check size={16} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : tab === 'mentions' ? (
        <SheetEmpty icon={<MessageSquare size={20} />} title="No mentions waiting">Direct mentions and replies that need your attention will appear here.</SheetEmpty>
      ) : (
        <SheetEmpty icon={<Inbox size={20} />} title="You’re all caught up">New messages in other channels will land here as they arrive.</SheetEmpty>
      )}
    </TopBarOverlay>
  );
}
