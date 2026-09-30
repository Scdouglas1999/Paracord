import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey } from '../../lib/serverScope';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import { useMemberStore } from '../../stores/memberStore';
import type { Channel, Message } from '../../types';
import { displayName } from '../../lib/displayName';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { ConversationPane, type ConversationSubject } from '../../components/glass/conversation';

interface TextChannelViewProps {
  guildId: string | undefined;
  channelId: string;
  channelName: string;
  channel: Channel | undefined;
  channels: Channel[];
  /** What the conversation pane's header describes. */
  subject: ConversationSubject;
  /** Strips above the timeline from the page (a pinned score, the entry gates). */
  notices?: ReactNode;
}

/**
 * A text or thread channel as a Glass conversation (docs/glass-spec.md §3.2):
 * it renders into the `ConversationPane` slot — header, notices, the timeline
 * (`MessageList`) and the message box (`MessageInput`) — and the shell floats
 * that pane on the room. The message internals are reused untouched.
 *
 * The side surfaces (search / pins / threads / media / economy) are not docked
 * here; the shell's sheets slot hosts them, driven by
 * `uiStore.contextPanelMode` and toggled from the header.
 *
 * **A thread view is about the thread** (docs/lantern-stage-spec.md §7.4). It
 * used to be about the thread's *parent*: the body rendered the parent room's
 * timeline behind a "Parent channel" strip while the thread itself was pushed
 * into the side panel, so a page whose title was the thread said "design-notes
 * is dark — nobody has posted in design-notes yet" about a room with fifty
 * messages in it. The thread is the page now; one line under the header says
 * where it lives and who started it, and the room's other threads are one
 * click away in the Threads panel.
 */
export function TextChannelView(props: TextChannelViewProps) {
  const scope = useCurrentAccountScope();
  return <OwnedTextChannelView key={scope ? entityScopeKey(scope, props.channelId) : `unavailable:${props.channelId}`} {...props} />;
}

function OwnedTextChannelView({
  guildId,
  channelId,
  channelName,
  channel,
  channels,
  subject,
  notices,
}: TextChannelViewProps) {
  const navigate = useNavigate();
  const scope = useCurrentAccountScope();
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);

  // Clear the reply target when switching channels.
  useEffect(() => {
    setReplyingTo(null);
  }, [channelId]);

  const isThread = channel?.type === 6 || channel?.channel_type === 6;
  const parentChannelId = isThread ? channel?.parent_id ?? null : null;
  const parentChannel = parentChannelId ? channels.find((c) => c.id === parentChannelId) : null;

  // Who opened the thread. Named only when this client can actually resolve
  // them — a thread whose starter is not in the loaded roster says nothing
  // rather than guessing, and never renders a bare id.
  const members = useMemberStore((state) =>
    scope && guildId ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const starterName = useMemo(() => {
    const ownerId = isThread ? channel?.owner_id : null;
    if (!ownerId || !members) return null;
    const member = members.find((entry) => entry.user.id === ownerId);
    return member ? displayName(member.user, member.nick) : null;
  }, [channel?.owner_id, isThread, members]);

  // A single malformed message must degrade this panel, not the app.
  const timeline = (
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
  );

  const threadOrigin = isThread && (
    <div className="panel-divider flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border-subtle px-4 py-2.5">
      <MessageSquare size={13} aria-hidden className="shrink-0 text-text-muted" />
      <span className="text-meta text-text-muted">A thread in</span>
      {parentChannel && guildId ? (
        <button
          type="button"
          onClick={() => navigate(`/app/guilds/${guildId}/channels/${parentChannel.id}`)}
          className="pc-focusable rounded-[var(--radius-control)] px-1 text-label text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-text-primary"
        >
          #{parentChannel.name || 'unknown'}
        </button>
      ) : (
        <span className="text-label text-text-secondary">a channel you can no longer see</span>
      )}
      {starterName && (
        <span className="truncate text-meta text-text-muted">· started by {starterName}</span>
      )}
    </div>
  );

  return (
    <ConversationPane
      subject={subject}
      notices={
        notices != null || threadOrigin ? (
          <>
            {notices}
            {threadOrigin}
          </>
        ) : undefined
      }
      timeline={timeline}
      composer={
        <MessageInput
          channelId={channelId}
          guildId={guildId}
          channelName={channelName}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
      }
    />
  );
}
