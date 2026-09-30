import { useId, useMemo } from 'react';

import { Button } from '../ui';
import { GlyphTile } from '../glass/places/Lead';
import type { FaceModel } from '../glass/places/model';
import { snowflakeToMs, type ConversationEntry } from '../../lib/attention/conversationModel';
import { usePresenceStore } from '../../stores/presenceStore';
import { PageSection } from './GlassPage';
import { PagePerson, PageRow, RowTime } from './PageRow';
import { shortAgo } from './timeOfDay';
import { useHomeMessagePreview } from './useHomeMessagePreview';
import { useScopedAvatar } from '../../hooks/useScopedAvatar';

export interface HomePickUpProps {
  entries: readonly ConversationEntry[];
  /**
   * Room keys (`entityScopeKey(scope, channelId)`) with a call live in them right
   * now, so a row's face wears the amber mark the places panel's live row does.
   * Anything not in here draws plain: this component never decides a room is live.
   */
  litRooms: ReadonlySet<string>;
  onOpen: (entry: ConversationEntry) => void;
}

function PickUpRow({
  entry,
  lit,
  onOpen,
}: {
  entry: ConversationEntry;
  lit: boolean;
  onOpen: (entry: ConversationEntry) => void;
}) {
  const { preview, text, failed, historyUnavailable, retry } = useHomeMessagePreview(entry, 'latest');
  const contextId = useId();
  const previewId = useId();
  const isDm = entry.kind === 'dm';
  const leadUserId = isDm ? entry.userId : preview?.authorId;
  const leadName = isDm ? entry.title : preview?.author ?? entry.title;
  const leadAvatar = useScopedAvatar(isDm ? entry.avatar : preview?.avatar, entry.scope);
  const status = usePresenceStore((state) =>
    leadUserId
      ? (state.getPresence(leadUserId, entry.scope.serverId)?.status ?? 'offline')
      : 'offline',
  );
  const face = useMemo<FaceModel | null>(
    () => (leadUserId ? { userId: leadUserId, name: leadName, avatar: leadAvatar ?? null } : null),
    [leadUserId, leadName, leadAvatar],
  );
  const lastMessageId = preview?.messageId ?? entry.lastActivityId;
  const ago = shortAgo(lastMessageId ? snowflakeToMs(lastMessageId) : null, Date.now());
  const where = isDm ? 'Direct message' : entry.kind === 'group_dm' ? 'Group message' : entry.contextLabel;

  return (
    <PageRow
      dataKey={entry.key}
      onOpen={() => onOpen(entry)}
      label={`Open ${entry.title}`}
      describedBy={`${contextId} ${previewId}`}
      lead={face ? <PagePerson face={face} status={status} live={lit} /> : <GlyphTile glyph="chat" />}
      title={
        <>
          {entry.title}
          {where && (
            <span id={contextId} className="glass-prow__tag">
              {' '}
              {where}
              {entry.unread && <span className="sr-only"> · unread</span>}
            </span>
          )}
        </>
      }
      line={
        <span id={previewId}>
          {preview?.author && <span className="glass-prow__author">{preview.author}: </span>}
          {text}
        </span>
      }
      wrap
      aside={ago ? <RowTime>{ago}</RowTime> : undefined}
      actions={
        failed ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={retry}
            aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`}
          >
            {historyUnavailable ? 'Reconnect' : 'Retry'}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * Pick up the conversation — real recent messages, with room to recognize who
 * wrote them and where they belong.
 *
 * The conversations you were last in that are *not* waiting on you — the ones
 * For you has already claimed are never repeated here. Omitted entirely when
 * there is nothing to return to.
 */
export function HomePickUp({ entries, litRooms, onOpen }: HomePickUpProps) {
  if (entries.length === 0) return null;
  return (
    <PageSection kicker="Pick up where you left off" label="Pick up the conversation">
      {entries.map((entry) => (
        <PickUpRow key={entry.key} entry={entry} lit={litRooms.has(entry.key)} onOpen={onOpen} />
      ))}
    </PageSection>
  );
}
