import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Bookmark, Check, CheckCheck, Hash, Inbox, Loader2, MessageSquare, Trash2 } from 'lucide-react';
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
import { cn } from '../../../lib/utils';
import { TopBarOverlay } from './TopBarOverlay';

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

type InboxTab = 'mentions' | 'unread' | 'saved';
const EMPTY_SAVED_ITEMS: ReturnType<typeof useSavedMessageStore.getState>['items'] = [];

function messagePreview(message: Message | null | undefined): string {
  if (message === undefined) return 'Loading latest message…';
  if (message === null) return 'Preview unavailable';
  const content = message.content?.trim();
  if (content) return content;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<InboxTab>('unread');
  const [previews, setPreviews] = useState<Record<string, Message | null>>({});
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const serverScope = useServerListStore((state) => state.activeServerId ?? '__local__');
  const savedItems = useSavedMessageStore((state) => state.serverId === serverScope ? state.items : EMPTY_SAVED_ITEMS);
  const savedLoading = useSavedMessageStore((state) => state.serverId === serverScope && state.loading);
  const savedError = useSavedMessageStore((state) => state.serverId === serverScope ? state.error : null);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  const mentionItems = useMemo(
    () => unreadItems.filter(({ state }) => state.mention_count > 0),
    [unreadItems],
  );

  useEffect(() => {
    if (!open) return;
    setTab(mentionItems.length > 0 ? 'mentions' : 'unread');
    void useSavedMessageStore.getState().load(true);
  }, [open]); // Reset only for a newly opened inbox, not as live read states change.

  useEffect(() => {
    if (!open || unreadItems.length === 0) return;
    let cancelled = false;
    const channelIds = unreadItems.slice(0, 20).map(({ state }) => state.channel_id);
    void Promise.all(channelIds.map(async (channelId) => {
      try {
        const { data } = await channelApi.getMessages(channelId, { limit: 1 });
        if (!cancelled) {
          setPreviews((current) => ({ ...current, [channelId]: data[0] ?? null }));
        }
      } catch {
        if (!cancelled) {
          setPreviews((current) => ({ ...current, [channelId]: null }));
        }
      }
    }));
    return () => {
      cancelled = true;
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
    if (!lastId) return;
    useReadStateStore.getState().markRead(channelId, lastId);
    void channelApi.updateReadState(channelId, lastId).catch((err) => {
      toast.error(`Failed to save read position: ${extractApiError(err)}`);
    });
  };

  const markAllRead = async () => {
    if (markingAllRead) return;
    const targets = unreadItems.flatMap(({ state }) => {
      const lastId = allChannels.find((channel) => channel.id === state.channel_id)?.last_message_id;
      return lastId ? [{ channelId: state.channel_id, lastId }] : [];
    });
    if (targets.length === 0) return;
    setMarkingAllRead(true);
    targets.forEach(({ channelId, lastId }) => {
      useReadStateStore.getState().markRead(channelId, lastId);
    });
    const results = await Promise.allSettled(
      targets.map(({ channelId, lastId }) => channelApi.updateReadState(channelId, lastId)),
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
      icon={Inbox}
      closeLabel="Close inbox"
      panelClassName="max-h-[min(82dvh,42rem)] w-full max-w-2xl"
      bodyClassName="p-0"
    >
      <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-border-subtle bg-bg-floating px-3 py-2">
        {([
          ['mentions', 'Mentions', mentionCount],
          ['unread', 'Unread', unreadItems.length],
          ['saved', 'Saved', savedItems.length],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-label font-semibold outline-none transition-colors focus-visible:shadow-[var(--focus-ring)]',
              tab === value
                ? 'bg-accent-tint text-accent-primary'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
            )}
          >
            {label}
            {count > 0 && (
              <span className="min-w-4 rounded-full bg-bg-mod-strong px-1 text-center text-[10px] tabular-nums text-text-secondary">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        ))}
        {tab !== 'saved' && unreadItems.length > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={markingAllRead}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-meta font-semibold text-text-secondary outline-none transition-colors hover:bg-bg-mod-subtle hover:text-accent-success focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
          >
            {markingAllRead ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
            <span className="hidden sm:inline">Mark all read</span>
          </button>
        )}
      </div>

      {error ? (
        <div role="alert" className="m-3 rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger">
          {error}
        </div>
      ) : tab === 'saved' ? (
        savedLoading && savedItems.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-5 py-12 text-label text-text-muted">
            <Loader2 size={18} className="animate-spin" /> Loading saved messages…
          </div>
        ) : savedError && savedItems.length === 0 ? (
          <div role="alert" className="m-3 rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger">
            {savedError}
          </div>
        ) : savedItems.length > 0 ? (
          <ul className="space-y-1 p-2">
            {savedItems.map((item) => (
              <li key={item.message.id} className="group flex items-start gap-3 rounded-sm px-3 py-2.5 hover:bg-bg-mod-subtle focus-within:bg-bg-mod-subtle">
                <button
                  type="button"
                  onClick={() => goToChannel(item.channel.id, item.message.id, item.channel.guild_id)}
                  className="min-w-0 flex-1 text-left outline-none"
                >
                  <span className="flex min-w-0 items-center gap-2 text-meta text-text-muted">
                    <Bookmark size={13} className="shrink-0 text-accent-primary" />
                    <strong className="truncate text-label text-text-primary">{authorName(item.message)}</strong>
                    <span className="truncate">in {item.channel.guild_id ? `#${item.channel.name}` : item.channel.name}</span>
                    <span className="ml-auto shrink-0">{relativeTime(item.saved_at)}</span>
                  </span>
                  <span className="mt-1 block line-clamp-2 text-label leading-5 text-text-secondary">
                    {messagePreview(item.message)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void removeSaved(item.message.id)}
                  aria-label={`Remove message from ${authorName(item.message)} from saved messages`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-danger-tint hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Bookmark} title="Nothing saved yet" body="Save a message from its actions menu and it will stay here for later." />
        )
      ) : visibleUnread.length > 0 ? (
        <ul className="space-y-1 p-2">
          {visibleUnread.map(({ state, channelName }) => {
            const channel = allChannels.find((candidate) => candidate.id === state.channel_id);
            const isGuildChannel = Boolean(channel?.guild_id);
            const preview = previews[state.channel_id];
            return (
              <li key={state.channel_id} className="group flex items-start gap-3 rounded-sm px-2.5 py-2.5 hover:bg-bg-mod-subtle focus-within:bg-bg-mod-subtle">
                <button
                  type="button"
                  onClick={() => goToChannel(state.channel_id, preview?.id)}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left outline-none"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                    {isGuildChannel ? <Hash size={16} /> : <MessageSquare size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <strong className="truncate text-label text-text-primary">
                        {isGuildChannel ? `#${channelName}` : channelName}
                      </strong>
                      {state.mention_count > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent-danger-fill px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-text-on-danger">
                          {state.mention_count > 99 ? '99+' : state.mention_count}
                        </span>
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary" aria-hidden />
                      )}
                    </span>
                    {preview && (
                      <span className="mt-0.5 block truncate text-meta font-semibold text-text-secondary">
                        {authorName(preview)}
                      </span>
                    )}
                    <span className="block truncate text-label text-text-muted">{messagePreview(preview)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => markItemRead(state.channel_id)}
                  aria-label={`Mark ${isGuildChannel ? `#${channelName}` : channelName} as read`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-bg-mod-strong hover:text-accent-success focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                >
                  <Check size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : tab === 'mentions' ? (
        <EmptyState icon={MessageSquare} title="No mentions waiting" body="Direct mentions and replies that need your attention will appear here." />
      ) : (
        <EmptyState icon={Inbox} title="You’re all caught up" body="New messages in other channels will land here as they arrive." />
      )}
    </TopBarOverlay>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Inbox; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3.5 px-5 py-10">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
        <Icon size={20} />
      </span>
      <div className="min-w-0 pt-0.5">
        <h3 className="text-subhead text-text-primary">{title}</h3>
        <p className="mt-1 text-label text-text-secondary">{body}</p>
      </div>
    </div>
  );
}
