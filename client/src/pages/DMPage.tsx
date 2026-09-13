import { activateChannel } from '../lib/channelNavigation';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import { getServerAccountScope } from '../lib/serverIdentity';
import { useCurrentChannelStore, useAvailableChannels } from '../hooks/useChannels';
import { useCurrentUser, useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { MessagesSquare, PenSquare, Search, X } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { DmPickerModal } from '../components/message/DmPickerModal';
import { VoiceControlBar } from '../components/voice/VoiceControlBar';
import { StreamViewer } from '../components/voice/StreamViewer';
import { useChannelStore } from '../stores/channelStore';
import { useReadStateStore } from '../stores/readStateStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useAccountMessageStore } from '../hooks/useMessageStore';
import { useServerListStore } from '../stores/serverListStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { LOCAL_SERVER_ID } from '../lib/connectionManager';
import { computeGuildUnread } from '../hooks/useUnreadCounts';
import { snowflakeToMs } from '../lib/attention/conversationModel';
import { safeStoredImageDataUrl } from '../lib/security';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { cn } from '../lib/utils';
import { ChannelType, type Channel, type Message, type ReadState } from '../types';
import { displayName } from '../lib/displayName';
import { presenceLabel, presenceLight } from '../lib/presence';
import { dmTitleFor } from '../lib/dmTitle';
import { wallClock } from '../lib/formatters';
import { avatarInitials } from '../components/light';
import { getIdentityColor } from '../lib/colors';
import { ErrorBoundary } from '../components/ErrorBoundary';

const EMPTY_CHANNELS: Channel[] = [];

interface DmRow {
  key: string;
  scope: AccountScope;
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

function activityMs(id: string | null): number {
  return id ? snowflakeToMs(id) : 0;
}

function formatDmActivity(id: string | null): { short: string; full: string } | null {
  if (!id) return null;
  try {
    const date = new Date(activityMs(id));
    if (Number.isNaN(date.getTime())) return null;
    const now = new Date();
    const full = date.toLocaleString();
    if (date.toDateString() === now.toDateString()) {
      return { short: wallClock(date), full };
    }
    const daysAgo = (now.getTime() - date.getTime()) / 86_400_000;
    if (daysAgo >= 0 && daysAgo < 7) {
      return { short: date.toLocaleDateString([], { weekday: 'short' }), full };
    }
    if (date.getFullYear() === now.getFullYear()) {
      return { short: date.toLocaleDateString([], { month: 'short', day: 'numeric' }), full };
    }
    return { short: date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }), full };
  } catch {
    return null;
  }
}

/**
 * ChatView + all-conversations index for direct / group DMs (layout-spec §1, §4).
 *
 * `/app/dms` (no `:channelId`) is the destination view: a header with a primary
 * "New message" action (opens the shared `DmPickerModal`) over the full DM/group
 * list MERGED across every connected server. The merge reuses the sidebar's DM
 * account-qualified channel cache and the
 * existing `loadAllDmChannels()` fetch path; it invents no new endpoint. Rows sort
 * by last activity, carry presence dots + unread/mention badges, and open the
 * conversation via the standard DM-open flow.
 *
 * `/app/dms/:channelId` renders the conversation exactly as before — message
 * internals (`MessageList` + composer) reused untouched; the group-DM recipient
 * surface lives in the shell-owned `ContextPanel` `members` mode.
 */
export function DMPage() {
  const scope = useCurrentAccountScope();
  const { channelId } = useParams();
  return <OwnedDMPage key={JSON.stringify([scope?.serverId, scope?.userId, channelId])} />;
}

function OwnedDMPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const dmChannels = useCurrentChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const availableChannels = useAvailableChannels();
  const byAccount = useReadStateStore((s) => s.byAccount);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');

  // Voice hooks must run unconditionally (before any early return).
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const voiceGuildId = useVoiceStore((s) => s.guildId);
  const watchedStreamerId = useVoiceStore((s) => s.watchedStreamerId);
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);
  const selfStream = useVoiceStore((s) => s.selfStream);
  const stopStream = useVoiceStore((s) => s.stopStream);
  const participants = useVoiceStore((s) => s.participants);
  const currentUserId = useCurrentUser()?.id ?? null;

  const dmChannelInfo = useMemo(() => {
    if (!channelId) return null;
    const activeId = activeServerId ?? LOCAL_SERVER_ID;
    const activeChannel = dmChannels.find((c) => c.id === channelId);
    if (activeChannel) return { channel: activeChannel, serverId: activeId };
    return null;
  }, [activeServerId, channelId, dmChannels]);
  const dmChannel = dmChannelInfo?.channel;
  const isGroupDM = dmChannel?.channel_type === 3 || dmChannel?.type === 3;
  const recipientName = dmTitleFor(
    dmChannel,
    dmChannelInfo ? getServerAccountScope(dmChannelInfo.serverId)?.userId : null,
    isGroupDM ? 'Just you' : 'Direct message',
  );

  // Reset transient chat state and any lingering context panel when the DM changes.
  useEffect(() => {
    setReplyingTo(null);
    setContextPanelMode(null);
  }, [channelId, setContextPanelMode]);

  // Reuse the sidebar's cross-server DM fetch path (no new endpoint) so past and
  // present conversations across every connected server land in the list.
  useEffect(() => {
    if (channelId && dmChannel) return;
    void useChannelStore.getState().loadAllDmChannels();
  }, [channelId, dmChannel]);

  useEffect(() => {
    if (
      !dmChannelInfo
      || dmChannelInfo.serverId === LOCAL_SERVER_ID
      || activeServerId === dmChannelInfo.serverId
    ) {
      return;
    }
    useServerListStore.getState().setActive(dmChannelInfo.serverId);
  }, [activeServerId, dmChannelInfo]);

  // Merge every server's DMs into one recency-sorted list. Reuses computeGuildUnread
  // for per-channel unread/mention against the right per-server read-state bucket.
  const rows = useMemo<DmRow[]>(() => {
    const out: DmRow[] = [];
    for (const ch of availableChannels) {
      if (ch.guild_id) continue;
      const serverId = ch.scope.serverId;
      const readMap = new Map<string, ReadState>(Object.entries(byAccount[accountScopeKey(ch.scope)] ?? {}));
        const isGroup = ch.type === ChannelType.GroupDM || ch.channel_type === 3;
        const info = computeGuildUnread([ch], readMap);
        out.push({
          key: ch.key,
          scope: ch.scope,
          channelId: ch.id,
          serverId,
          // A conversation is named after the people in it OTHER than you.
          title: dmTitleFor(ch, ch.scope.userId, isGroup ? 'Just you' : 'Direct message'),
          recipientId: isGroup ? null : ch.recipient?.id ?? null,
          avatar: isGroup ? null : ch.recipient?.avatar_hash ?? null,
          isGroup,
          unread: (info?.unreadCount ?? 0) > 0,
          mentionCount: info?.mentionCount ?? 0,
          lastActivityId: ch.last_message_id ?? null,
        });
    }
    out.sort((a, b) => activityMs(b.lastActivityId) - activityMs(a.lastActivityId));
    return out;
  }, [availableChannels, byAccount]);
  const filteredRows = useMemo(() => {
    const query = conversationQuery.trim().toLocaleLowerCase();
    if (!query) return rows;
    return rows.filter((row) => row.title.toLocaleLowerCase().includes(query));
  }, [conversationQuery, rows]);

  const openConversation = (row: DmRow) => {
    activateChannel({ id: row.channelId, scope: row.scope });
    navigate(`/app/dms/${row.channelId}`);
  };

  const inThisDmCall =
    voiceConnected &&
    channelId != null &&
    voiceChannelId === channelId &&
    voiceGuildId === 'dm';

  const watchedStreamerName = useMemo(() => {
    if (!watchedStreamerId) return undefined;
    if (currentUserId != null && watchedStreamerId === currentUserId) return 'You';
    const vs = participants.get(watchedStreamerId);
    return vs ? displayName(vs) : undefined;
  }, [watchedStreamerId, currentUserId, participants]);

  // ---- Index view: the all-conversations destination -----------------------
  if (!channelId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-base p-[var(--gutter)]">
        <div className="pc-plate flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-border-subtle px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="pc-display text-display text-text-primary">Messages</h1>
              <p className="mt-1 text-meta text-text-faint">Every conversation you are part of, brightest first.</p>
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
                title="Nobody has said anything to you yet"
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
                <div className="relative mb-4 max-w-xl">
                  <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <Input
                    type="search"
                    aria-label="Filter conversations"
                    placeholder="Filter conversations"
                    className="pl-9 pr-10"
                    value={conversationQuery}
                    onChange={(event) => setConversationQuery(event.target.value)}
                  />
                  {conversationQuery && (
                    <button
                      type="button"
                      aria-label="Clear conversation filter"
                      onClick={() => setConversationQuery('')}
                      className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-chip text-text-muted outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="mb-2 flex items-center justify-between gap-3 px-1 text-section text-text-secondary">
                  <span>Conversations</span>
                  <span className="pc-mono text-meta text-text-faint">
                    {conversationQuery ? `${filteredRows.length} of ${rows.length}` : rows.length}
                  </span>
                </div>
                {filteredRows.length === 0 ? (
                  <EmptyState
                    className="bg-bg-well shadow-[var(--shadow-well)]"
                    icon={<Search size={20} />}
                    title="No matching conversations"
                    description={`No direct or group conversations match “${conversationQuery.trim()}”.`}
                    action={<Button variant="secondary" size="sm" onClick={() => setConversationQuery('')}>Clear filter</Button>}
                  />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {filteredRows.map((row) => (
                      <DmListRow key={row.key} row={row} onOpen={openConversation} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        </div>
        <DmPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} />
      </div>
    );
  }

  // ---- Conversation view ---------------------------------------------------
  // §7.6: a DM is a text room between two people, so it is the same plate — the
  // header, the timeline and the composer on one surface, on the 12px gutter.
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base p-[var(--gutter)]">
      <div className="pc-plate flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar isDM recipientName={recipientName} dmChannelId={channelId} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {inThisDmCall && watchedStreamerId && (
          <div className="relative max-h-[40vh] min-h-[180px] shrink-0 border-b border-border-subtle bg-black">
            <ErrorBoundary variant="section" label="the stream">
            <StreamViewer
              streamerId={watchedStreamerId}
              streamerName={watchedStreamerName}
              expectingStream={
                Boolean(
                  currentUserId != null &&
                    watchedStreamerId === currentUserId &&
                    selfStream,
                )
              }
              onStopWatching={() => setWatchedStreamer(null)}
              onStopStream={
                currentUserId != null && watchedStreamerId === currentUserId
                  ? () => stopStream()
                  : undefined
              }
            />
            </ErrorBoundary>
          </div>
        )}
        <ErrorBoundary variant="section" label="the message feed">
          <MessageList
            channelId={channelId}
            onReply={(msg: Message) =>
              setReplyingTo({
                id: msg.id,
                author: displayName(msg.author),
                content: msg.content || '',
              })
            }
          />
        </ErrorBoundary>
        <MessageInput
          channelId={channelId}
          channelName={recipientName}
          conversationKind={isGroupDM ? 'room' : 'person'}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
        {inThisDmCall && <VoiceControlBar />}
      </div>
      </div>
    </div>
  );
}

/**
 * One conversation row. Presence and the last-message preview are read PER ROW
 * (own store selectors) so a presence tick or a new message re-renders only the
 * affected row — never the whole merged list (the same rule the Buildings
 * column's rows keep).
 */
function DmListRow({ row, onOpen }: { row: DmRow; onOpen: (row: DmRow) => void }) {
  const status = usePresenceStore((s) =>
    row.recipientId ? s.getPresence(row.recipientId, row.serverId)?.status ?? 'offline' : 'offline',
  );
  const lastMessage = useAccountMessageStore(row.scope, (s) => {
    const msgs = s.messages[row.channelId];
    return msgs?.length ? msgs[msgs.length - 1] : undefined;
  });

  const preview = lastMessage?.content?.trim();
  const subtitle = preview
    ? preview
    : row.isGroup
      ? 'Group conversation'
      : status !== 'offline'
        ? presenceLabel(status)
        : 'Direct message';

  const statusWord = row.isGroup ? null : presenceLabel(status);
  const light = presenceLight(status);
  const src = safeStoredImageDataUrl(row.avatar);
  const showMention = row.mentionCount > 0;
  const showUnreadDot = row.unread && !showMention;
  const activity = formatDmActivity(row.lastActivityId);

  return (
    // §8 TextRoomRow: a window dot / lit face, the name with its last line, and
    // one attention mark on the right. A conversation is a room, so it is a row.
    <button
      type="button"
      onClick={() => onOpen(row)}
      className="pc-focusable group grid w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
    >
      <div className="relative shrink-0">
        {/* §1.5: presence is a rim of light on the avatar, never a coloured dot. */}
        <div
          data-testid={row.isGroup ? undefined : 'presence-light'}
          data-status={row.isGroup ? undefined : status}
          className={cn(
            'pc-display flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-label font-bold text-text-on-light',
            !row.isGroup && light.avatarClass,
            !row.isGroup && light.dnd && 'pc-dnd',
          )}
          style={{ background: src ? undefined : getIdentityColor(row.recipientId ?? row.channelId) }}
        >
          {src ? (
            <img src={src} alt="" className="h-full w-full object-cover" />
          ) : row.isGroup ? (
            <MessagesSquare size={17} aria-hidden className="text-text-on-light" />
          ) : (
            avatarInitials(row.title)
          )}
        </div>
        {statusWord && statusWord !== subtitle && (
          <span className="sr-only">{statusWord}</span>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('pc-display truncate text-name', row.unread ? 'text-text-primary' : 'text-text-primary')}>
            {row.title}
          </span>
          {row.isGroup && <span className="text-meta text-text-faint">group</span>}
        </div>
        <div className={cn('truncate text-meta', row.unread ? 'text-text-secondary' : 'text-text-faint')}>{subtitle}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {activity && (
          <time
            data-testid="dm-last-activity"
            dateTime={new Date(activityMs(row.lastActivityId)).toISOString()}
            title={activity.full}
            className={cn('pc-mono mr-1 text-meta', row.unread ? 'text-text-secondary' : 'text-text-faint')}
          >
            {activity.short}
          </time>
        )}
        {showMention && (
          <span
            data-testid="mention-badge"
            className="pc-mono flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-chip)] bg-accent-primary px-1.5 text-meta font-semibold text-text-on-accent"
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
