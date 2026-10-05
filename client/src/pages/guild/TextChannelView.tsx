import { useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { displayName } from '../../lib/displayName';
import { entityScopeKey } from '../../lib/serverScope';
import { useMemberStore } from '../../stores/memberStore';
import type { Channel } from '../../types';
import { IxConversation, type ConversationSubject } from '../../components/ix/conversation';
import { usePushedPageKeys } from '../../components/rooms/lobby/usePushedPageKeys';

interface TextChannelViewProps {
  guildId: string | undefined;
  channelId: string;
  channelName: string;
  channel: Channel | undefined;
  channels: Channel[];
  /** What the conversation is: the large title, the toolbar and the message box are made from it. */
  subject: ConversationSubject;
  /** Under the large title: a pinned score, a stage channel's session. */
  notices?: ReactNode;
  /** Brings the server's onboarding page back ("Pick roles" in the joiner welcome). */
  onPickRoles?: () => void;
}

/**
 * A text channel or a thread as an Index conversation (docs/index-spec.md §4.11,
 * §8.1): `IxConversation` draws the large title, the timeline, the welcome and the
 * message box; this page says what a THREAD is.
 *
 * **A thread view is about the thread** (docs/lantern-stage-spec.md §7.4). It
 * used to be about the thread's *parent*: the body rendered the parent room's
 * timeline behind a "Parent channel" strip while the thread itself was pushed
 * into the side panel, so a page whose title was the thread said "design-notes
 * is dark" about a room with fifty messages in it. The thread is the page now: a
 * pushed page (§6.1) with the thread's name as its title, "Thread in design-notes ·
 * started by Mara" under it, a back chevron to the channel it lives in, and Esc or
 * Alt+Left to go there too. The room's other threads are one click away in the
 * Threads page of the channel menu.
 */
export function TextChannelView(props: TextChannelViewProps) {
  const scope = useCurrentAccountScope();
  return <OwnedTextChannelView key={scope ? entityScopeKey(scope, props.channelId) : `unavailable:${props.channelId}`} {...props} />;
}

function OwnedTextChannelView({ guildId, channel, channels, subject, notices, onPickRoles }: TextChannelViewProps) {
  const navigate = useNavigate();
  const scope = useCurrentAccountScope();

  const isThread = channel?.type === 6 || channel?.channel_type === 6;
  const parentChannelId = isThread ? (channel?.parent_id ?? null) : null;
  const parentChannel = parentChannelId ? channels.find((candidate) => candidate.id === parentChannelId) : null;

  // Who opened the thread. Named only when this client can actually resolve
  // them: a thread whose starter is not in the loaded roster says nothing
  // rather than guessing, and never renders a bare id.
  const members = useMemberStore((state) => (scope && guildId ? state.members.get(entityScopeKey(scope, guildId)) : undefined));
  const starterName = useMemo(() => {
    const ownerId = isThread ? channel?.owner_id : null;
    if (!ownerId || !members) return null;
    const member = members.find((entry) => entry.user.id === ownerId);
    return member ? displayName(member.user, member.nick) : null;
  }, [channel?.owner_id, isThread, members]);

  const threadSubject = useMemo<ConversationSubject>(() => {
    if (!isThread || subject.kind !== 'channel') return subject;
    const where = parentChannel ? `Thread in ${parentChannel.name || 'a channel'}` : 'Thread in a channel you can no longer see';
    return { ...subject, isThread: true, subtitle: starterName ? `${where} · started by ${starterName}` : where };
  }, [isThread, subject, parentChannel, starterName]);

  // Back: the channel the thread lives in, or the server when that is gone.
  const goBack = useCallback(() => {
    if (!guildId) return;
    navigate(parentChannel ? `/app/guilds/${guildId}/channels/${parentChannel.id}` : `/app/guilds/${guildId}`);
  }, [navigate, guildId, parentChannel]);
  const onBack = isThread && guildId ? goBack : undefined;
  usePushedPageKeys(onBack ?? null);

  return (
    <IxConversation
      subject={threadSubject}
      notices={notices}
      onBack={onBack}
      backLabel={parentChannel ? `Back to ${parentChannel.name || 'the channel'}` : 'Back to the server'}
      onPickRoles={onPickRoles}
    />
  );
}
