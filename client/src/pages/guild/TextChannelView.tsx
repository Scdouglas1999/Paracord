import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey } from '../../lib/serverScope';
import { useEffect, useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import { useMemberStore } from '../../stores/memberStore';
import type { Channel, Message } from '../../types';
import { displayName } from '../../lib/displayName';
import { ErrorBoundary } from '../../components/ErrorBoundary';

interface TextChannelViewProps {
  guildId: string | undefined;
  channelId: string;
  channelName: string;
  channel: Channel | undefined;
  channels: Channel[];
}

/**
 * ChatView body for a text/thread channel (layout-spec §1 — full-width single
 * pane). All message internals are reused untouched: `MessageList` + composer.
 *
 * The right-hand surfaces (search / pins / members / economy / threads) are no
 * longer docked here — they live in the shell-owned `ContextPanel`, driven by
 * `uiStore.contextPanelMode` and toggled from `TopBar`.
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

  const timeline = (
    <>
      {/* A single malformed message must degrade this panel, not the app. */}
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
        guildId={guildId}
        channelName={channelName}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {isThread && (
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
        )}
        {timeline}
      </div>
    </div>
  );
}
