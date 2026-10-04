import { memo, useRef, type ReactNode } from 'react';

import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { parseCustomEmojiToken } from '../../../lib/customEmoji';
import { RollingNumber, useFlipList } from '../../../lib/motion';
import { ReactionPeopleList, useReactionPeople } from '../../message/ReactionPeople';
import { CustomEmojiImage } from '../../ui/ResourceImage';
import { HeartMark } from './CardGlyphs';
import { Glyph } from '../primitives';

/**
 * A message's reactions as ONE chip biting the corner of what they are on
 * (docs/glass-spec.md §3.2): `#34353a`, a 3px ring in the opaque pane color,
 * and an icon and a count for each reaction. Each reaction is still its own
 * button, so pressing one still toggles yours and resting on it still says who
 * reacted (that behavior and its list are `useReactionPeople` and
 * `ReactionPeopleList` in `message/ReactionPeople.tsx`, shared with the feed's
 * own chips).
 *
 * Where it bites is the caller's business: `placement="corner"` hangs it off
 * the top right of its (positioned) parent, the media's or the bubble's;
 * `placement="inline"` is the same chip in the flow, for a message that has
 * nothing to bite (a sticker, an embed).
 *
 * The flame and the heart are the two reactions the reference draws as Paracord's
 * own line marks; every other reaction is drawn as itself, an emoji or a custom
 * emoji's picture. Adding a reaction is the message's React action (hover or
 * focus, and the message menu), not a button in the chip.
 */

/**
 * What the chip is hung on. A picture is bitten at its corner, as in the
 * reference; a bubble or a card has words in its corner, so the chip rides above
 * it instead (and the row makes room), never over the text. `inline` is in the flow.
 */
export type ReactionPlacement = 'media' | 'bubble' | 'card' | 'inline';

export interface ReactionTally {
  emoji: string;
  count: number;
  me: boolean;
}

/** The reactions drawn as a line mark instead of an emoji (the reference's flame and heart). */
const FLAME = new Set(['\u{1F525}']);
const HEART = new Set(['❤️', '❤', '\u{1F90D}', '♥️']);

/** What a reaction looks like inside the chip. */
function reactionMark(emoji: string, guildId: string | null | undefined, size: number): ReactNode {
  if (FLAME.has(emoji)) return <Glyph name="flame" size={size} />;
  if (HEART.has(emoji)) return <HeartMark size={size} />;
  const custom = guildId ? parseCustomEmojiToken(emoji) : null;
  if (custom && guildId) {
    return (
      <CustomEmojiImage
        guildId={guildId}
        emojiId={custom.id}
        alt={custom.name}
        title={`:${custom.name}:`}
        style={{ width: size + 3, height: size + 3, objectFit: 'contain' }}
        loading="lazy"
        fallback={<>{emoji}</>}
      />
    );
  }
  return <span aria-hidden className="ix-bite__emoji">{emoji}</span>;
}

/** How a reaction reads to assistive tech: the emoji, how many, and whether one is yours. */
export function reactionLabel(reaction: ReactionTally): string {
  const custom = parseCustomEmojiToken(reaction.emoji);
  const what = custom ? `:${custom.name}:` : reaction.emoji;
  const many = reaction.count === 1 ? '1 reaction' : `${reaction.count} reactions`;
  return `${what}, ${many}${reaction.me ? ', including yours' : ''}`;
}

/**
 * One reaction inside the chip. Resting on it (or a long press on touch) opens a
 * short list of who reacted; right-clicking opens the whole list; clicking
 * toggles your own. The who-reacted behavior and its list are
 * `useReactionPeople` and `ReactionPeopleList`, shared with the feed's chips.
 */
function ReactionSegment({
  reaction,
  guildId,
  channelId,
  messageId,
  onToggle,
}: {
  reaction: ReactionTally;
  guildId: string | null | undefined;
  channelId: string;
  messageId: string;
  onToggle: () => void;
}) {
  const { emoji, count, me } = reaction;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const state = useReactionPeople({ channelId, messageId, emoji, count });

  return (
    <span
      ref={anchorRef}
      data-flip-key={emoji}
      data-flip-own={me || undefined}
      className="ix-bite__seg-wrap"
      {...state.triggerProps}
    >
      <button
        type="button"
        className="ix-bite__seg"
        data-me={me || undefined}
        aria-pressed={me}
        aria-label={reactionLabel(reaction)}
        title={state.title}
        onClick={() => {
          if (state.consumeSuppressedClick()) return;
          onToggle();
        }}
      >
        <span data-flip-glyph className="ix-bite__mark">
          {reactionMark(emoji, guildId, 13)}
        </span>
        <span className="ix-bite__count">
          <RollingNumber value={count} announce={false} />
        </span>
      </button>
      <ReactionPeopleList
        state={state}
        anchor={anchorRef}
        emoji={emoji}
        count={count}
        glyph={reactionMark(emoji, guildId, 22)}
      />
    </span>
  );
}

/**
 * The chip. Memoised so the flip list's layout pass (which measures every
 * segment) runs when THIS message's reactions change, not on every render of the
 * timeline: scrolling re-renders every visible row.
 */
export const ReactionBite = memo(function ReactionBite({
  reactions,
  guildId,
  channelId,
  messageId,
  onToggle,
  placement = 'media',
}: {
  reactions: readonly ReactionTally[];
  guildId: string | null | undefined;
  channelId: string;
  messageId: string;
  onToggle: (messageId: string, reaction: ReactionTally) => void;
  placement?: ReactionPlacement;
}) {
  // A reaction is something somebody put there, so it lands rather than
  // slides: it pops in. Nothing plays on the first commit, so a message
  // scrolling into view with six reactions on it is still.
  const rowRef = useFlipList<HTMLDivElement>({ enter: 'pop' });
  // A custom-emoji reaction is an authenticated image; re-render when the
  // download ticket its URL needs is minted.
  useDownloadTicket();
  return (
    <div ref={rowRef} className="ix-bite" role="group" aria-label="Reactions" data-placement={placement}>
      {reactions.map((reaction, index) => (
        <ReactionSegment
          key={`${reaction.emoji}-${index}`}
          reaction={reaction}
          guildId={guildId}
          channelId={channelId}
          messageId={messageId}
          onToggle={() => onToggle(messageId, reaction)}
        />
      ))}
    </div>
  );
});
