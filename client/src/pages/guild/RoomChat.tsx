import { X } from 'lucide-react';
import { useMemo } from 'react';

import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import { RoomChatRibbon } from '../../components/voice/stage';
import { IconButton } from '../../components/ui';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useHereNow } from '../../hooks/useLights';
import { displayName } from '../../lib/displayName';
import type { Message } from '../../types';

type ReplyTarget = { id: string; author: string; content: string } | null;

interface RoomChatProps {
  /** Phone renders the ribbon as a sheet under the controls. */
  isPhone: boolean;
  channelId: string;
  guildId: string | undefined;
  channelName: string;
  replyingTo: ReplyTarget;
  onReply: (target: ReplyTarget) => void;
  onClose: () => void;
  /** Sheet only. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Closed, and playing its leave. */
  leaving?: boolean;
}

/**
 * The room's text channel beside the Stage (docs/lantern-stage-spec.md §7.2).
 *
 * The timeline and the composer are the same components a text room uses, in
 * their ribbon variant: 28px lit avatars, compact rows, a raised highlight on
 * anything written by somebody who is in the room right now, and a composer
 * that says "Say something to the room".
 *
 * Who is "in the room" comes from the room's light (WP1's `useHereNow`) — this
 * never works it out for itself.
 */
export function RoomChat({
  isPhone,
  channelId,
  guildId,
  channelName,
  replyingTo,
  onReply,
  onClose,
  expanded = true,
  onToggleExpanded,
  leaving = false,
}: RoomChatProps) {
  const hereNow = useHereNow(guildId, channelId);
  const inRoomUserIds = useMemo(
    () => new Set(hereNow.people.map((person) => person.userId)),
    [hereNow.people],
  );

  return (
    <RoomChatRibbon
      roomName={channelName}
      lit={hereNow.here > 0}
      surface={isPhone ? 'sheet' : 'ribbon'}
      expanded={expanded}
      onToggle={onToggleExpanded}
      leaving={leaving}
      aria-hidden={leaving || undefined}
      actions={
        isPhone ? undefined : (
          <IconButton label="Close the call chat" size="sm" tone="ghost" onClick={onClose}>
            <X size={16} />
          </IconButton>
        )
      }
      composer={
        <MessageInput
          variant="ribbon"
          channelId={channelId}
          guildId={guildId}
          channelName={channelName}
          replyingTo={replyingTo}
          onCancelReply={() => onReply(null)}
        />
      }
    >
      <ErrorBoundary variant="section" label="the call chat">
        <MessageList
          variant="ribbon"
          channelId={channelId}
          inRoomUserIds={inRoomUserIds}
          onReply={(msg: Message) =>
            onReply({ id: msg.id, author: displayName(msg.author), content: msg.content || '' })
          }
        />
      </ErrorBoundary>
    </RoomChatRibbon>
  );
}
