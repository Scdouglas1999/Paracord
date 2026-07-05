import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessagesSquare, Users, PenSquare, Hash } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { DmPickerModal } from '../components/message/DmPickerModal';
import { useChannelStore } from '../stores/channelStore';
import { useReadStateStore } from '../stores/readStateStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useMessageStore } from '../stores/messageStore';
import { useServerListStore } from '../stores/serverListStore';
import { useUIStore } from '../stores/uiStore';
import { LOCAL_SERVER_ID } from '../lib/connectionManager';
import { computeGuildUnread } from '../hooks/useUnreadCounts';
import { snowflakeToMs } from '../lib/attention/conversationModel';
import { safeStoredImageDataUrl } from '../lib/security';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/utils';
import { ChannelType, type Channel, type Message, type ReadState } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

const STATUS_COLOR: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  streaming: 'Streaming',
  offline: 'Offline',
};

interface DmRow {
  channelId: string;
  serverId: string;
  title: string;
  recipientId: string | null;
  avatar: string | null;
  isGroup: boolean;
  unread: boolean;
  mentionCount: number;
  lastActivityId: string | null;
}

/** Best-effort DM/group-DM title from the channel's recipient(s). */
function dmTitle(ch: Channel): string {
  if (ch.name) return ch.name;
  if (ch.recipient?.username) return ch.recipient.username;
  if (ch.recipients?.length) return ch.recipients.map((r) => r.username).join(', ');
  return 'Direct Message';
}

function activityMs(id: string | null): number {
  return id ? snowflakeToMs(id) : 0;
}

/**
 * ChatView + all-conversations index for direct / group DMs (layout-spec §1, §4).
 *
 * `/app/dms` (no `:channelId`) is the destination view: a header with a primary
 * "New message" action (opens the shared `DmPickerModal`) over the full DM/group
 * list MERGED across every connected server. The merge reuses the sidebar's DM
 * source in `channelStore` — the per-server `dmChannelsByServer` index (plus the
 * active-server `channelsByGuild['']` mirror as a back-compat fallback) — and the
 * existing `loadAllDmChannels()` fetch path; it invents no new endpoint. Rows sort
 * by last activity, carry presence dots + unread/mention badges, and open the
 * conversation via the standard DM-open flow.
 *
 * `/app/dms/:channelId` renders the conversation exactly as before — message
 * internals (`MessageList` + composer) reused untouched; the group-DM recipient
 * surface lives in the shell-owned `ContextPanel` `members` mode.
 */
export function DMPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const dmChannelsByServer = useChannelStore((s) => s.dmChannelsByServer);
  const byServer = useReadStateStore((s) => s.byServer);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const toggleContextPanelMode = useUIStore((s) => s.toggleContextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const dmChannel = dmChannels.find((c) => c.id === channelId);
  const isGroupDM = dmChannel?.channel_type === 3 || dmChannel?.type === 3;
  const recipientName = isGroupDM
    ? (dmChannel?.name || dmChannel?.recipients?.map((r) => r.username).join(', ') || 'Group DM')
    : (dmChannel?.recipient?.username || 'Direct Message');

  // Reset transient chat state and any lingering context panel when the DM changes.
  useEffect(() => {
    setReplyingTo(null);
    setContextPanelMode(null);
  }, [channelId, setContextPanelMode]);

  // Reuse the sidebar's cross-server DM fetch path (no new endpoint) so past and
  // present conversations across every connected server land in the list.
  useEffect(() => {
    if (channelId) return;
    void useChannelStore.getState().loadAllDmChannels();
  }, [channelId]);

  // Merge every server's DMs into one recency-sorted list. Reuses computeGuildUnread
  // for per-channel unread/mention against the right per-server read-state bucket.
  const rows = useMemo<DmRow[]>(() => {
    const activeId = activeServerId ?? LOCAL_SERVER_ID;
    const bucketByServer: Record<string, Channel[]> = { ...dmChannelsByServer };
    if (!(activeId in bucketByServer) && dmChannels.length > 0) {
      bucketByServer[activeId] = dmChannels;
    }

    const seen = new Set<string>();
    const out: DmRow[] = [];
    for (const [serverId, list] of Object.entries(bucketByServer)) {
      const readMap = new Map<string, ReadState>(Object.entries(byServer[serverId] ?? {}));
      for (const ch of list) {
        if (seen.has(ch.id)) continue;
        seen.add(ch.id);
        const isGroup = ch.type === ChannelType.GroupDM || ch.channel_type === 3;
        const info = computeGuildUnread([ch], readMap);
        out.push({
          channelId: ch.id,
          serverId,
          title: dmTitle(ch),
          recipientId: isGroup ? null : ch.recipient?.id ?? null,
          avatar: isGroup ? null : ch.recipient?.avatar_hash ?? null,
          isGroup,
          unread: (info?.unreadCount ?? 0) > 0,
          mentionCount: info?.mentionCount ?? 0,
          lastActivityId: ch.last_message_id ?? null,
        });
      }
    }
    out.sort((a, b) => activityMs(b.lastActivityId) - activityMs(a.lastActivityId));
    return out;
  }, [dmChannelsByServer, dmChannels, byServer, activeServerId]);

  const openConversation = (id: string) => {
    useChannelStore.getState().selectChannel(id);
    navigate(`/app/dms/${id}`);
  };

  // ---- Index view: the all-conversations destination -----------------------
  if (!channelId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-primary">
        <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
              <MessagesSquare size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-heading text-text-primary">Messages</h1>
              <p className="text-meta text-text-muted">Your direct and group conversations, most recent first.</p>
            </div>
            <Button onClick={() => setPickerOpen(true)} className="shrink-0">
              <PenSquare size={16} className="mr-1.5" />
              New message
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="px-4 py-4 sm:px-6">
            {rows.length === 0 ? (
              <EmptyState
                icon={<MessagesSquare size={20} />}
                title="No conversations yet"
                description="Find a friend and say hi — pick up a conversation and every DM you start lands right here, across every server you're on."
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => navigate('/app/friends')}>
                      Find friends
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                      New message
                    </Button>
                  </div>
                }
              />
            ) : (
              <>
                <div className="mb-2 px-1 text-section uppercase text-text-muted">
                  Conversations — {rows.length}
                </div>
                <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                  {rows.map((row) => (
                    <DmListRow key={row.channelId} row={row} onOpen={openConversation} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <DmPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} />
      </div>
    );
  }

  // ---- Conversation view: unchanged message surface ------------------------
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <TopBar isDM recipientName={recipientName} dmChannelId={channelId} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isGroupDM && (
          <div className="flex justify-end border-b border-border-subtle px-3 py-2">
            <button
              type="button"
              aria-pressed={contextPanelMode === 'members'}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] aria-pressed:bg-accent-tint aria-pressed:text-accent-primary"
              onClick={() => toggleContextPanelMode('members')}
              title="Members"
            >
              <Users size={14} />
              Members
            </button>
          </div>
        )}
        <MessageList
          channelId={channelId}
          onReply={(msg: Message) =>
            setReplyingTo({
              id: msg.id,
              author: msg.author.username,
              content: msg.content || '',
            })
          }
        />
        <MessageInput channelId={channelId} replyingTo={replyingTo} onCancelReply={() => setReplyingTo(null)} />
      </div>
    </div>
  );
}

/**
 * One conversation row. Presence and the last-message preview are read PER ROW
 * (own store selectors) so a presence tick or a new message re-renders only the
 * affected row — never the whole merged list (mirrors the sidebar ConversationRow).
 */
function DmListRow({ row, onOpen }: { row: DmRow; onOpen: (id: string) => void }) {
  const status = usePresenceStore((s) =>
    row.recipientId ? s.getPresence(row.recipientId, row.serverId)?.status ?? 'offline' : 'offline',
  );
  const lastMessage = useMessageStore((s) => {
    const msgs = s.messages[row.channelId];
    return msgs?.length ? msgs[msgs.length - 1] : undefined;
  });

  const preview = lastMessage?.content?.trim();
  const subtitle = preview
    ? preview
    : row.isGroup
      ? 'Group conversation'
      : status !== 'offline'
        ? STATUS_LABEL[status] ?? 'Direct message'
        : 'Direct message';

  const src = safeStoredImageDataUrl(row.avatar);
  const showMention = row.mentionCount > 0;
  const showUnreadDot = row.unread && !showMention;

  return (
    <button
      type="button"
      onClick={() => onOpen(row.channelId)}
      className="group flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
    >
      <div className="relative shrink-0">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-bg-mod-strong text-label font-semibold text-text-secondary">
          {src ? (
            <img src={src} alt="" className="h-full w-full object-cover" />
          ) : row.isGroup ? (
            <MessagesSquare size={17} aria-hidden className="text-text-secondary" />
          ) : (
            (row.title.charAt(0) || '?').toUpperCase()
          )}
        </div>
        {!row.isGroup && status !== 'offline' && (
          <span
            data-testid="presence-dot"
            data-status={status}
            className={cn('absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full', STATUS_COLOR[status] ?? 'bg-status-offline')}
            style={{ boxShadow: '0 0 0 2.5px var(--bg-secondary)' }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {row.isGroup && <Hash size={13} aria-hidden className="shrink-0 text-text-muted" />}
          <span className={cn('truncate text-label', row.unread ? 'font-semibold text-text-primary' : 'font-medium text-text-primary')}>
            {row.title}
          </span>
        </div>
        <div className={cn('truncate text-meta', row.unread ? 'text-text-secondary' : 'text-text-muted')}>{subtitle}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {showMention && (
          <span
            data-testid="mention-badge"
            className="flex h-4 min-w-4 items-center justify-center rounded-xs bg-accent-primary px-1 text-meta font-semibold tabular-nums text-text-on-accent"
          >
            {row.mentionCount > 99 ? '99+' : row.mentionCount}
          </span>
        )}
        {showUnreadDot && (
          <span data-testid="unread-dot" aria-label="Unread" className="h-2 w-2 rounded-full bg-accent-primary" />
        )}
      </div>
    </button>
  );
}
