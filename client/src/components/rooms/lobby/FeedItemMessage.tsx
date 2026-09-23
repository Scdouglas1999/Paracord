import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PollMessageCard } from '../../message/PollMessageCard';
import { ReactionChip } from '../../message/ReactionPeople';
import { CustomEmojiImage } from '../../ui/ResourceImage';
import type { FeedMessageItem, FeedUser } from '../../../api/serverFeed';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { parseCustomEmojiToken } from '../../../lib/customEmoji';
import { displayName } from '../../../lib/displayName';
import { parseMarkdown } from '../../../lib/markdown';
import { cn } from '../../../lib/utils';
import type { Reaction } from '../../../types';
import { FeedAvatar, FeedCardHeader, FileChips, PhotoGrid, ReasonTag, isImageAttachment } from './feedParts';

export interface FeedItemMessageProps {
  item: FeedMessageItem;
  guildId: string;
  when: string;
  /** Names for `<@id>` mentions in the text. */
  mentionNames: Map<string, string>;
  onOpen: () => void;
  onToggleReaction: (reaction: Reaction) => void;
  /** A phone: the author sits above the text, and the text takes the full width. */
  compact?: boolean;
}

/** Lines of text before "Show more". */
const CLAMP = 6;

function isReaction(value: unknown): value is Reaction {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Reaction).emoji === 'string' &&
    typeof (value as Reaction).count === 'number'
  );
}

/**
 * A message on the server's front page. It behaves like the message it is:
 * the text is the timeline's markdown, a poll votes in place, a reaction chip
 * toggles your reaction, and a picture opens the lightbox.
 */
export const FeedItemMessage = memo(function FeedItemMessage({
  item,
  guildId,
  when,
  mentionNames,
  onOpen,
  onToggleReaction,
  compact = false,
}: FeedItemMessageProps) {
  const { message } = item;
  const author: FeedUser = {
    id: message.author.id,
    username: message.author.username,
    display_name: message.author.display_name ?? null,
    avatar_hash: message.author.avatar_hash ?? null,
  };
  const raw = message.content?.trim() ?? '';
  // A poll's message carries its question as text too; the card already says it.
  const content = message.poll && raw === message.poll.question.trim() ? '' : raw;
  const nodes = useMemo(() => (content ? parseMarkdown(content, guildId, mentionNames) : []), [content, guildId, mentionNames]);
  const attachments = message.attachments ?? [];
  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((attachment) => !isImageAttachment(attachment));
  const reactions = (message.reactions as unknown[]).filter(isReaction);

  return (
    <article aria-label={`${displayName(author)} in ${item.channel_name}`} className="pc-home-card flex flex-col gap-3 px-4 pb-4 pt-3">
      <FeedCardHeader channelName={item.channel_name} when={when} onOpen={onOpen} aside={<ReasonTag reason={item.reason} />} />
      <div className={cn('flex gap-3', compact && 'flex-col gap-2.5')}>
        {compact ? (
          <div className="flex items-center gap-2.5">
            <FeedAvatar user={author} size={28} />
            <span className="pc-display min-w-0 truncate text-name text-text-primary">{displayName(author)}</span>
          </div>
        ) : (
          <FeedAvatar user={author} size={36} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {!compact && (
            <span className="pc-display truncate pt-[7px] text-name leading-none text-text-primary">{displayName(author)}</span>
          )}
          {nodes.length > 0 && <ClampedText>{nodes}</ClampedText>}
          <PhotoGrid images={images} />
          <FileChips files={files} onOpen={onOpen} />
          {message.poll && (
            <div className="pc-home-poll -mt-1 [&>div]:mt-0 [&>div]:max-w-none [&>div]:border-transparent [&>div]:bg-bg-well [&>div]:shadow-[var(--shadow-well)]">
              <PollMessageCard channelId={message.channel_id} poll={message.poll} canVote />
            </div>
          )}
          {reactions.length > 0 && (
            <Reactions
              reactions={reactions}
              guildId={guildId}
              channelId={message.channel_id}
              messageId={message.id}
              onToggle={onToggleReaction}
            />
          )}
        </div>
      </div>
    </article>
  );
});

/** Six lines, then "Show more" — only when the text actually runs over. */
function ClampedText({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [children, open]);
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        ref={ref}
        className={cn('w-full break-words text-body text-text-body', !open && 'pc-home-clamp')}
        style={{ '--clamp-lines': CLAMP } as React.CSSProperties}
      >
        {children}
      </div>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="pc-focusable rounded-[var(--radius-chip)] text-label text-text-link hover:underline"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function Reactions({
  reactions,
  guildId,
  channelId,
  messageId,
  onToggle,
}: {
  reactions: readonly Reaction[];
  guildId: string;
  channelId: string;
  messageId: string;
  onToggle: (reaction: Reaction) => void;
}) {
  // A custom emoji is an authenticated image; redraw when its ticket lands.
  useDownloadTicket();
  return (
    <div className="flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const custom = parseCustomEmojiToken(reaction.emoji);
        return (
          <ReactionChip
            key={reaction.emoji}
            emoji={reaction.emoji}
            count={reaction.count}
            me={reaction.me}
            channelId={channelId}
            messageId={messageId}
            onToggle={() => onToggle(reaction)}
            glyph={
              custom ? (
                <CustomEmojiImage
                  guildId={guildId}
                  emojiId={custom.id}
                  alt={custom.name}
                  title={`:${custom.name}:`}
                  style={{ width: 18, height: 18, objectFit: 'contain' }}
                  loading="lazy"
                  fallback={<>{reaction.emoji}</>}
                />
              ) : (
                reaction.emoji
              )
            }
          />
        );
      })}
    </div>
  );
}
