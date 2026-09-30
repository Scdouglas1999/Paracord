import { activateChannel } from '../lib/channelNavigation';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import { getServerAccountScope } from '../lib/serverIdentity';
import { useCurrentChannelStore, useAvailableChannels } from '../hooks/useChannels';
import { useCurrentUser, useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { MessagesSquare, PenSquare, Search } from 'lucide-react';
import { ConversationPane } from '../components/glass/conversation';
import { GlassChip } from '../components/glass/primitives';
import { GlyphTile } from '../components/glass/places/Lead';
import { GlassPage, PageBar, PageScroll, PageSection } from '../components/home/GlassPage';
import { PagePerson, PageRow } from '../components/home/PageRow';
import { formatRowTime } from '../components/glass/places/model';
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
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { SearchWell } from '../components/ui/TextField';
import { ChannelType, type Channel, type Message, type ReadState } from '../types';
import { displayName } from '../lib/displayName';
import { presenceLabel } from '../lib/presence';
import { dmTitleFor } from '../lib/dmTitle';
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
  const ms = activityMs(id);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // The places panel's own words: a clock time today, a weekday within the week,
  // a date beyond it.
  const short = formatRowTime(ms, Date.now());
  return short ? { short, full: date.toLocaleString() } : null;
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
      <GlassPage label="Messages">
        <PageBar
          title="Messages"
          line={
            rows.length === 0
              ? 'Every conversation you are part of lands here'
              : `${rows.length} ${rows.length === 1 ? 'conversation' : 'conversations'}, latest first`
          }
          actions={
            <Button onClick={() => setPickerOpen(true)}>
              <PenSquare size={16} aria-hidden />
              New message
            </Button>
          }
        />

        <PageScroll>
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
                  <Button variant="glass" size="sm" onClick={() => setPickerOpen(true)}>
                    New message
                  </Button>
                </div>
              }
            />
          ) : (
            <>
              <div className="glass-toolbar">
                <SearchWell
                  type="search"
                  label="Filter conversations"
                  placeholder="Filter conversations"
                  icon={<Search size={16} aria-hidden />}
                  className="glass-toolbar__grow"
                  value={conversationQuery}
                  onChange={(event) => setConversationQuery(event.target.value)}
                />
                {conversationQuery && (
                  <Button variant="ghost" size="sm" aria-label="Clear conversation filter" onClick={() => setConversationQuery('')}>
                    Clear
                  </Button>
                )}
              </div>
              {filteredRows.length === 0 ? (
                <EmptyState
                  icon={<Search size={20} />}
                  title="No matching conversations"
                  description={`No direct or group conversations match “${conversationQuery.trim()}”.`}
                  action={<Button variant="glass" size="sm" onClick={() => setConversationQuery('')}>Clear filter</Button>}
                />
              ) : (
                <PageSection
                  kicker="Conversations"
                  count={conversationQuery ? `${filteredRows.length} of ${rows.length}` : rows.length}
                >
                  {filteredRows.map((row) => (
                    <DmListRow key={row.key} row={row} onOpen={openConversation} />
                  ))}
                </PageSection>
              )}
            </>
          )}
        </PageScroll>

        <DmPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} />
      </GlassPage>
    );
  }

  // ---- Conversation view ---------------------------------------------------
  // A DM is a conversation between people, so it is the same Glass
  // conversation pane as a channel: header, timeline in the column, message
  // box. A DM call's stream and controls sit in it until the call pill and the
  // stage (WP-G12, WP-G14) carry them.
  return (
    <ConversationPane
      subject={{ kind: 'dm', channelId, title: recipientName, isGroup: isGroupDM }}
      notices={
        inThisDmCall && watchedStreamerId ? (
          <div className="glass-dmstream">
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
        ) : undefined
      }
      timeline={
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
      }
      composer={
        <MessageInput
          channelId={channelId}
          channelName={recipientName}
          conversationKind={isGroupDM ? 'group' : 'person'}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
      }
      dock={inThisDmCall ? <VoiceControlBar /> : undefined}
    />
  );
}

/**
 * One conversation row: the places panel's row at page width (docs/glass-spec.md
 * §3.1). Presence and the last-message preview are read PER ROW (own store
 * selectors) so a presence tick or a new message re-renders only the affected
 * row, never the whole merged list.
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
  const showMention = row.mentionCount > 0;
  const showUnreadDot = row.unread && !showMention;
  const activity = formatDmActivity(row.lastActivityId);

  return (
    <PageRow
      onOpen={() => onOpen(row)}
      lead={
        row.isGroup ? (
          <GlyphTile glyph="people" />
        ) : (
          <PagePerson face={{ userId: row.recipientId ?? row.channelId, name: row.title, avatar: row.avatar }} status={status} />
        )
      }
      title={
        <>
          {row.title}
          {row.isGroup && <span className="glass-prow__tag"> group</span>}
        </>
      }
      line={
        <>
          {subtitle}
          {statusWord && statusWord !== subtitle && <span className="sr-only">, {statusWord}</span>}
        </>
      }
      aside={
        <>
          {activity && (
            <time
              data-testid="dm-last-activity"
              dateTime={new Date(activityMs(row.lastActivityId)).toISOString()}
              title={activity.full}
              className="glass-instrument glass-prow__time"
            >
              {activity.short}
            </time>
          )}
          {showMention && (
            <GlassChip tone="mention" data-testid="mention-badge">
              {row.mentionCount > 99 ? '99+' : row.mentionCount}
            </GlassChip>
          )}
          {showUnreadDot && <span data-testid="unread-dot" role="img" aria-label="Unread" className="glass-place-dot" />}
        </>
      }
      offline={!row.isGroup && status === 'offline'}
    />
  );
}
