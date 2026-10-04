import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import type { ReminderItem } from '../../../api/reminders';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { snowflakeTime } from '../../../hooks/useChannelPreviews';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { activateConversation } from '../../../lib/attention/conversationNavigation';
import { relativeTime } from '../../../lib/formatters';
import { formatRowTime } from '../../glass/places/model';
import { useMinuteClock } from '../../glass/places/usePlacesData';
import { messagePreviewText } from '../../../lib/markdown';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useReminderStore } from '../../../stores/reminderStore';
import { useSavedMessageStore } from '../../../stores/savedMessageStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { toast } from '../../../stores/toastStore';
import type { Message } from '../../../types';
import { RemindersPane } from '../../layout/overlays/RemindersPane';
import { IxGlyph } from '../glyphs';
import { Avatar, ServerMark } from '../identity';
import { EmptyPage, LargeTitlePage } from '../page';
import { Control, WideControl } from '../primitives';
import { dmStateWords, inboxPageLine } from './peopleModel';
import { Segmented, segmentedIds } from './Segmented';
import { useConversationPreview } from './useConversationPreview';
import { useNearViewport } from './useNearViewport';
import { inboxEntries } from './usePeopleSidebar';

type InboxTab = 'mentions' | 'unread' | 'saved' | 'reminders';
const EMPTY_SAVED: ReturnType<typeof useSavedMessageStore.getState>['items'] = [];

/** The words of a saved message's line, as every other preview: plain, a role mention reads "@Design". */
function savedLine(message: Message): string {
  const content = message.e2ee ? '' : messagePreviewText(message.content ?? '');
  if (content) return content;
  if (message.forwarded_from?.content) return `Forwarded: ${messagePreviewText(message.forwarded_from.content)}`;
  if (message.poll?.question) return `Poll: ${message.poll.question}`;
  if (message.attachments[0]?.filename) return `Attachment: ${message.attachments[0].filename}`;
  if (message.e2ee) return 'Encrypted message';
  return 'New activity';
}

function authorName(message: Message): string {
  return message.author.display_name?.trim() || message.author.username;
}

/**
 * Inbox (docs/index-spec.md §6.6, §8.1; it replaces the Glass inbox overlay): what is
 * waiting for you across every server and your messages, as a page in People. A
 * segmented control moves between Mentions, Unread, Saved and Reminders; a row opens the
 * conversation (at the mention when it knows it), and a check marks it read. "Mark all
 * read" settles every conversation that is waiting.
 */
export function InboxPage() {
  const navigate = useNavigate();
  const nowMs = useMinuteClock();
  const { mutedGuildKeys } = useMutedGuilds();
  const conversations = useUnifiedConversations(mutedGuildKeys);
  const entries = useMemo(
    () => inboxEntries([...conversations.pinned, ...conversations.needsYou, ...conversations.recent]),
    [conversations.pinned, conversations.needsYou, conversations.recent],
  );
  const mentions = useMemo(() => entries.filter((entry) => entry.mentionCount > 0), [entries]);
  const mentionTotal = mentions.reduce((total, entry) => total + entry.mentionCount, 0);

  const serverScope = useServerListStore((state) => state.activeServerId ?? '__local__');
  const savedItems = useSavedMessageStore((state) => (state.serverId === serverScope ? state.items : EMPTY_SAVED));
  const savedLoading = useSavedMessageStore((state) => state.serverId === serverScope && state.loading);
  const savedError = useSavedMessageStore((state) => (state.serverId === serverScope ? state.error : null));
  const reminderCount = useReminderStore((state) => (state.serverId === serverScope ? state.items.length : 0));

  // A mention first when there is one; once you pick a tab it stays where you put it.
  const [picked, setPicked] = useState<InboxTab | null>(null);
  const tab: InboxTab = picked ?? (mentions.length > 0 ? 'mentions' : 'unread');
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    void useSavedMessageStore.getState().load(true);
  }, []);

  const visible = tab === 'mentions' ? mentions : entries;
  const subtitle =
    entries.length === 0
      ? 'Nothing is waiting for you'
      : [
          mentionTotal > 0 ? (mentionTotal === 1 ? '1 mention' : `${mentionTotal} mentions`) : null,
          `${entries.length} ${entries.length === 1 ? 'conversation' : 'conversations'} with something new`,
        ]
          .filter(Boolean)
          .join(' · ');

  const open = useCallback(
    (entry: ConversationEntry, messageId?: string | null) => {
      try {
        const path = activateConversation(entry);
        navigate(messageId ? `${path}?message=${encodeURIComponent(messageId)}` : path);
      } catch (error) {
        toast.error(`Failed to open ${entry.title}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const markRead = useCallback((entry: ConversationEntry) => {
    const lastId = entry.lastActivityId;
    if (!lastId) return;
    useReadStateStore.getState().markRead(entry.scope, entry.channelId, lastId);
    void useReadStateStore.getState().saveReadPosition(entry.scope, entry.channelId, lastId).catch((err) => {
      toast.error(`Failed to save read position: ${extractApiError(err)}`);
    });
  }, []);

  const markAll = async () => {
    if (markingAll) return;
    const targets = entries.filter((entry) => entry.lastActivityId);
    if (targets.length === 0) return;
    setMarkingAll(true);
    for (const entry of targets) useReadStateStore.getState().markRead(entry.scope, entry.channelId, entry.lastActivityId as string);
    const results = await Promise.allSettled(
      targets.map((entry) => useReadStateStore.getState().saveReadPosition(entry.scope, entry.channelId, entry.lastActivityId as string)),
    );
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures > 0) toast.error(`Could not save ${failures} read position${failures === 1 ? '' : 's'}.`);
    else toast.success('Inbox marked as read.');
    setMarkingAll(false);
  };

  const removeSaved = async (messageId: string) => {
    try {
      await useSavedMessageStore.getState().remove(messageId);
      toast.success('Removed from saved messages.');
    } catch (err) {
      toast.error(`Failed to remove saved message: ${extractApiError(err)}`);
    }
  };

  const openSaved = (item: (typeof savedItems)[number]) => {
    const query = `?message=${encodeURIComponent(item.message.id)}`;
    navigate(item.channel.guild_id ? `/app/guilds/${item.channel.guild_id}/channels/${item.channel.id}${query}` : `/app/dms/${item.channel.id}${query}`);
  };

  const openReminder = (item: ReminderItem) => {
    const query = `?message=${encodeURIComponent(item.message.id)}`;
    navigate(item.channel.guild_id ? `/app/guilds/${item.channel.guild_id}/channels/${item.channel.id}${query}` : `/app/dms/${item.channel.id}${query}`);
  };

  const tabs = [
    { value: 'mentions' as const, label: 'Mentions', count: mentionTotal },
    { value: 'unread' as const, label: 'Unread', count: entries.length },
    { value: 'saved' as const, label: 'Saved', count: savedItems.length },
    { value: 'reminders' as const, label: 'Reminders', count: reminderCount },
  ];
  const ids = segmentedIds('ix-inbox', tab);

  return (
    <LargeTitlePage title="Inbox" subtitle={subtitle} data-testid="ix-inbox" className="ix-sp ix-ib">
      <div className="ix-ib__bar">
        <Segmented label="Inbox" idBase="ix-inbox" items={tabs} value={tab} onChange={setPicked} />
        {(tab === 'mentions' || tab === 'unread') && entries.length > 0 && (
          <WideControl className="ix-ib__markall" onClick={() => void markAll()} disabled={markingAll}>
            Mark all read
          </WideControl>
        )}
      </div>

      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className="ix-ib__panel">
        {tab === 'reminders' ? (
          <RemindersPane
            onOpen={openReminder}
            empty={<EmptyPage inline glyph="plan" title="No reminders" line="Choose Remind me on a message and it will come back here when it is due." />}
          />
        ) : tab === 'saved' ? (
          savedLoading && savedItems.length === 0 ? (
            <p className="ix-ib__status" role="status">
              Loading saved messages…
            </p>
          ) : savedError && savedItems.length === 0 ? (
            <p className="ix-ib__status" role="alert" data-tone="danger">
              {savedError}
            </p>
          ) : savedItems.length > 0 ? (
            <ul className="ix-ib__list">
              {savedItems.map((item) => (
                <li key={item.message.id} className="ix-ib__row">
                  <button type="button" className="ix-ib__body" onClick={() => openSaved(item)}>
                    <span className="ix-ib__lead" aria-hidden="true">
                      <IxGlyph name="attach" size={18} />
                    </span>
                    <span className="ix-ib__text">
                      <span className="ix-ib__head">
                        <span className="ix-ib__name">{authorName(item.message)}</span>
                        <span className="ix-ib__where">in {item.channel.name}</span>
                        <span className="ix-ib__when">{relativeTime(item.saved_at)}</span>
                      </span>
                      <span className="ix-ib__line">{savedLine(item.message)}</span>
                    </span>
                  </button>
                  <div className="ix-ib__actions">
                    <Control label={`Remove message from ${authorName(item.message)} from saved messages`} onClick={() => void removeSaved(item.message.id)}>
                      <IxGlyph name="x" size={16} />
                    </Control>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyPage inline glyph="attach" title="Nothing saved yet" line="Save a message from its actions menu and it will stay here for later." />
          )
        ) : visible.length > 0 ? (
          <ul className="ix-ib__list">
            {visible.map((entry) => (
              <InboxItem key={entry.key} entry={entry} nowMs={nowMs} onOpen={open} onRead={markRead} />
            ))}
          </ul>
        ) : tab === 'mentions' ? (
          <EmptyPage inline glyph="hello" title="No mentions waiting" line="Direct mentions and replies that need your attention will appear here." />
        ) : (
          <EmptyPage inline glyph="check" title="You’re all caught up" line="New messages in other channels will land here as they arrive." />
        )}
      </div>
    </LargeTitlePage>
  );
}

/** One conversation that needs you: its face, where it is, who said what, and a check to mark it read. */
function InboxItem({
  entry,
  nowMs,
  onOpen,
  onRead,
}: {
  entry: ConversationEntry;
  nowMs: number;
  onOpen: (entry: ConversationEntry, messageId?: string | null) => void;
  onRead: (entry: ConversationEntry) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const near = useNearViewport(rowRef);
  const guilds = useAvailableGuilds();
  const guild = entry.guildId ? guilds.find((candidate) => candidate.id === entry.guildId) : null;
  const { preview, text } = useConversationPreview(entry, 'attention', near);
  // Who said it, then what: the conversation's name is already the row's head.
  const line = preview?.message ? inboxPageLine(entry, preview.message, entry.scope.userId) : preview ? preview.text : text;
  const when = snowflakeTime(entry.lastActivityId);
  // The time of the last message in the sidebar's words ("9:44 PM", "Tue"), so a row reads the same in both places.
  const time = formatRowTime(when, nowMs);
  const state = dmStateWords(entry.unread || entry.isDMUnread, entry.mentionCount);

  return (
    <li ref={rowRef} className="ix-ib__row" data-testid="ix-inbox-row" data-channel-id={entry.channelId} data-mentions={entry.mentionCount > 0 || undefined}>
      <button type="button" className="ix-ib__body" onClick={() => onOpen(entry, preview?.messageId ?? null)}>
        <span className="ix-ib__lead" aria-hidden="true">
          {guild ? (
            <ServerMark guildId={guild.id} name={guild.name} icon={guild.icon_hash ?? guild.icon ?? null} hue={guild.hue ?? null} size={36} />
          ) : entry.kind === 'group_dm' ? (
            <IxGlyph name="people" size={18} />
          ) : (
            <Avatar userId={entry.userId ?? entry.channelId} name={entry.title} avatar={entry.avatar ?? null} size={36} ring="var(--ix-main)" />
          )}
        </span>
        <span className="ix-ib__text">
          <span className="ix-ib__head">
            <span className="ix-ib__name">{entry.title}</span>
            {entry.contextLabel && <span className="ix-ib__where">in {entry.contextLabel}</span>}
            {when !== null && time && (
              <time className="ix-ib__when" dateTime={new Date(when).toISOString()} title={new Date(when).toLocaleString()}>
                {time}
              </time>
            )}
            {state.length > 0 && <span className="sr-only">, {state.join(', ')}</span>}
          </span>
          <span className="ix-ib__line">{line}</span>
        </span>
        {entry.mentionCount > 0 && (
          <span className="ix-ib__badge" aria-hidden="true">
            {entry.mentionCount > 99 ? '99+' : entry.mentionCount}
          </span>
        )}
      </button>
      <div className="ix-ib__actions">
        <Control label={`Mark ${entry.title} as read`} onClick={() => onRead(entry)}>
          <IxGlyph name="check" size={16} />
        </Control>
      </div>
    </li>
  );
}
