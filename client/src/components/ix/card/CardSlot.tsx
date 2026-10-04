import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useIncomingDmCall } from '../../../hooks/useIncomingDmCall';
import { displayName } from '../../../lib/displayName';
import { useVoiceStore } from '../../../stores/voiceStore';
import { placeKey, type Place } from '../shell/place';
import type { CardSlotProps } from '../shell/slots';
import { CARD_IN_MS, PUSH_UP_MS, ROW_IN_MS, contentBelow, inLeavingPane, playPush } from './cardMotion';
import { IncomingCallCard } from './IncomingCallCard';
import { heldBelongsTo, inlineCard, pinnedCard, type CardWorld, type IncomingCallModel, type RoomCardModel } from './model';
import { RoomCard } from './RoomCard';
import { useCardWorld } from './useCardWorld';

/**
 * The card slot (contract: `CardSlotProps`, components/ix/shell/slots.ts;
 * docs/design/index-checkpoints/IX-4.md "CardSlot").
 *
 *   inline   rendered by the sidebar under its search field: the place's own
 *            card (your call here, else the busiest room, index-spec §4.3).
 *            A `div.ix-card-slot` that is empty when there is no card.
 *   pinned   mounted by the shell above the panes: an incoming call (§4.10),
 *            then your call when it belongs to another place, with its server
 *            line. Renders null when there is nothing, so the host collapses.
 *
 * Content below a slot is pushed with a FLIP when the slot grows or shrinks
 * (a card arriving or going, a person joining or leaving, §5.5); never on the
 * slot's first commit, in a pane that is sliding out, or when the place
 * changed (the panes are sliding then).
 */
export function CardSlot({ place, position }: CardSlotProps) {
  const world = useCardWorld();
  return position === 'inline' ? <InlineSlot place={place} world={world} /> : <PinnedSlot place={place} world={world} />;
}

/* ---- Presence: a card stays for its exit -------------------------------------- */

interface Present<T> {
  shown: T | null;
  exiting: boolean;
  /** The exit played: drop the card. */
  gone: () => void;
}

/**
 * The card to draw: the current one, or the last one while its exit plays.
 * `exit` false drops a vanished card at once (your call moved to the other
 * slot, where it travels instead).
 */
function usePresent<T extends { key: string }>(next: T | null, exit: boolean): Present<T> {
  const [shown, setShown] = useState<T | null>(next);
  const [exiting, setExiting] = useState(false);
  if (next && next !== shown) {
    setShown(next);
    if (exiting) setExiting(false);
  } else if (!next && shown && !exiting) {
    if (exit) setExiting(true);
    else setShown(null);
  }
  const gone = useCallback(() => {
    setShown(null);
    setExiting(false);
  }, []);
  return { shown: next ?? shown, exiting: !next && exiting, gone };
}

/** True from the slot's second commit on: nothing moves on the first. */
function usePrimed(): () => boolean {
  const primed = useRef(false);
  useEffect(() => {
    primed.current = true;
  }, []);
  return useCallback(() => primed.current, []);
}

/**
 * Push what is below the slot when its height changes (§5.5): down with the
 * card's arrival (600ms) or a row's (500ms), up when something left (450ms).
 */
function usePushBelow(box: () => HTMLElement | null, mayAnimate: () => boolean, place: string, shownKey: string | null) {
  const last = useRef<{ height: number; place: string; key: string | null } | null>(null);
  useLayoutEffect(() => {
    const element = box();
    const height = element ? element.offsetHeight : 0;
    const previous = last.current;
    last.current = { height, place, key: shownKey };
    if (!element || !previous || previous.place !== place || !mayAnimate()) return;
    const delta = height - previous.height;
    if (Math.abs(delta) < 0.5) return;
    const arrived = previous.key !== shownKey && shownKey !== null;
    playPush(contentBelow(element), delta, delta < 0 ? PUSH_UP_MS : arrived ? CARD_IN_MS : ROW_IN_MS);
  });
}

/* ---- Inline -------------------------------------------------------------------- */

function InlineSlot({ place, world }: { place: Place; world: CardWorld | null }) {
  const card = useMemo(() => (world ? inlineCard(world, place) : null), [world, place]);
  const { shown, exiting, gone } = usePresent<RoomCardModel>(card, true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const primed = usePrimed();
  const mayAnimate = useCallback(() => primed() && !inLeavingPane(rootRef.current), [primed]);
  usePushBelow(() => rootRef.current, mayAnimate, placeKey(place), shown?.key ?? null);

  return (
    <div ref={rootRef} className="ix-card-slot" data-position="inline">
      {shown && <RoomCard key={shown.key} card={shown} position="inline" mayAnimate={mayAnimate} exiting={exiting} onExited={gone} />}
    </div>
  );
}

/* ---- Pinned -------------------------------------------------------------------- */

const pinnedHost = () =>
  typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.ix-side__pinned');

function useIncomingCard(): { call: IncomingCallModel | null; decline: () => void } {
  const { call, decline } = useIncomingDmCall();
  const participants = useVoiceStore((state) => (call ? state.channelParticipants.get(call.channelId) : undefined));
  const model = useMemo<IncomingCallModel | null>(() => {
    if (!call) return null;
    const first = (participants ?? []).find((state) => !state.guild_id);
    return {
      key: `incoming:${call.channelId}`,
      channelId: call.channelId,
      callerName: call.callerName,
      caller: first ? { userId: first.user_id, name: displayName(first), avatar: first.avatar_hash ?? null } : null,
      participantCount: call.participantCount,
    };
  }, [call, participants]);
  return { call: model, decline };
}

function PinnedSlot({ place, world }: { place: Place; world: CardWorld | null }) {
  const card = useMemo(() => (world ? pinnedCard(world, place) : null), [world, place]);
  // Your call vanishing from here because this IS its place now: it travels to
  // the inline slot (§5.4) instead of playing an exit.
  const moving = world ? heldBelongsTo(world, place) : false;
  const call = usePresent<RoomCardModel>(card, !moving);
  const { call: incoming, decline } = useIncomingCard();
  const ring = usePresent<IncomingCallModel>(incoming, true);

  const mayAnimate = usePrimed();
  usePushBelow(pinnedHost, mayAnimate, placeKey(place), `${ring.shown?.key ?? ''}|${call.shown?.key ?? ''}`);

  if (!call.shown && !ring.shown) return null;
  return (
    <>
      {ring.shown && (
        <IncomingCallCard
          key={ring.shown.key}
          call={ring.shown}
          onDecline={decline}
          mayAnimate={mayAnimate}
          exiting={ring.exiting}
          onExited={ring.gone}
        />
      )}
      {call.shown && (
        <RoomCard
          key={call.shown.key}
          card={call.shown}
          position="pinned"
          mayAnimate={mayAnimate}
          exiting={call.exiting}
          onExited={call.gone}
        />
      )}
    </>
  );
}
