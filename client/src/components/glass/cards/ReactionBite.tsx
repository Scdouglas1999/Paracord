import { memo, useEffect, useRef, useState, type ReactNode } from 'react';

import { extractApiError } from '../../../api/client';
import { reactionUsersApi, type ReactionPerson } from '../../../api/reminders';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { parseCustomEmojiToken } from '../../../lib/customEmoji';
import { RollingNumber, useFlipList } from '../../../lib/motion';
import { reactionTitle } from '../../../lib/reactionPeople';
import { TimelineAvatar } from '../../message/TimelineParts';
import { CustomEmojiImage } from '../../ui/ResourceImage';
import { Popover } from '../../ui/Popover';
import { HeartMark } from './CardGlyphs';
import { Glyph } from '../primitives';

/**
 * A message's reactions as ONE chip biting the corner of what they are on
 * (docs/glass-spec.md §3.2): `#34353a`, a 3px ring in the opaque pane color,
 * and an icon and a count for each reaction. Each reaction is still its own
 * button, so pressing one still toggles yours and resting on it still says who
 * reacted (the list `ReactionChip` in `message/ReactionPeople.tsx` gives the
 * feed's own chips).
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

/** People shown before "and N more". */
const PREVIEW = 12;
/** How long a pointer rests on a reaction before the list opens. */
const HOVER_DELAY_MS = 400;
/** Grace period for crossing the gap between the reaction and its list. */
const LEAVE_GRACE_MS = 160;

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
  return <span aria-hidden className="glass-bite__emoji">{emoji}</span>;
}

const personName = (person: ReactionPerson): string => person.display_name?.trim() || person.username;

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
 * toggles your own.
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
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [people, setPeople] = useState<ReactionPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new tally means the list we have is stale.
  const [listedFor, setListedFor] = useState(count);
  if (listedFor !== count) {
    setListedFor(count);
    setPeople(null);
    setError(null);
  }

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const cancelOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelOpen();
    cancelClose();
    setOpen(false);
    setExpanded(false);
  };
  /** A hover-opened list closes when the pointer leaves; a right-click list stays. */
  const scheduleClose = () => {
    cancelOpen();
    if (!open || expanded) return;
    cancelClose();
    closeTimer.current = setTimeout(close, LEAVE_GRACE_MS);
  };

  const load = async () => {
    try {
      const { data } = await reactionUsersApi.list(channelId, messageId, emoji, 100);
      setPeople(data);
      setError(null);
    } catch (err) {
      setError(extractApiError(err));
    }
  };
  const show = (full: boolean) => {
    cancelClose();
    setExpanded(full);
    setOpen(true);
    if (!people) void load();
  };

  const title = error
    ? error
    : reactionTitle((people ?? []).slice(0, 2).map(personName), people?.length ?? count, emoji);
  const visible = expanded ? people ?? [] : (people ?? []).slice(0, PREVIEW);
  const hidden = Math.max(0, (people?.length ?? 0) - PREVIEW);

  return (
    <span
      ref={anchorRef}
      data-flip-key={emoji}
      data-flip-own={me || undefined}
      className="glass-bite__seg-wrap"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        cancelClose();
        if (open) return;
        cancelOpen();
        openTimer.current = setTimeout(() => show(false), HOVER_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return;
        scheduleClose();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch') return;
        cancelOpen();
        openTimer.current = setTimeout(() => {
          suppressClick.current = true;
          show(false);
        }, HOVER_DELAY_MS);
      }}
      onPointerUp={(event) => {
        if (event.pointerType === 'touch') cancelOpen();
      }}
      onPointerCancel={cancelOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        show(true);
      }}
    >
      <button
        type="button"
        className="glass-bite__seg glass-focusable"
        data-me={me || undefined}
        aria-pressed={me}
        aria-label={reactionLabel(reaction)}
        title={title}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onToggle();
        }}
      >
        <span data-flip-glyph className="glass-bite__mark">
          {reactionMark(emoji, guildId, 13)}
        </span>
        <span className="glass-bite__count">
          <RollingNumber value={count} announce={false} />
        </span>
      </button>
      <Popover
        anchor={anchorRef}
        open={open}
        onClose={close}
        side="top"
        align="start"
        label={`People who reacted with ${emoji}`}
        className="w-60 p-0"
      >
        <div onPointerEnter={cancelClose} onPointerLeave={scheduleClose} className="glass-bite__people">
          <div className="glass-bite__people-head">
            <span className="glass-bite__people-glyph" aria-hidden>
              {reactionMark(emoji, guildId, 22)}
            </span>
            <span className="glass-bite__people-count">
              {people ? (people.length === 1 ? '1 person' : `${people.length} people`) : `${count} ${count === 1 ? 'person' : 'people'}`}
            </span>
          </div>
          {error && <p role="alert" className="glass-bite__people-note" data-tone="error">{error}</p>}
          {!error && !people && <p className="glass-bite__people-note">Loading who reacted…</p>}
          {people && (
            <ul className="glass-bite__people-list" data-expanded={expanded || undefined}>
              {visible.map((person) => (
                <li key={person.id} className="glass-bite__person">
                  <TimelineAvatar userId={person.id} name={personName(person)} avatar={person.avatar_hash} size={22} />
                  <span className="glass-bite__person-name">{personName(person)}</span>
                </li>
              ))}
            </ul>
          )}
          {!expanded && hidden > 0 && (
            <button type="button" className="glass-bite__more glass-focusable" onClick={() => setExpanded(true)}>
              and {hidden} more
            </button>
          )}
        </div>
      </Popover>
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
    <div ref={rowRef} className="glass-bite" role="group" aria-label="Reactions" data-placement={placement}>
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
