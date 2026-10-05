import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

import { activityLine, currentItem } from '../../../lib/together/model';
import { useTogetherActivity, useTogetherStore } from '../../../stores/togetherStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { UserProfilePopup } from '../../user/UserProfile';
import { showCall, watchStream, type PillActionTarget } from '../../glass/pill/pillActions';
import { toggleSheet } from '../../glass/sheets';
import { IxGlyph } from '../glyphs';
import { onSettle } from '../motion';
import { CardActions } from './CardActions';
import {
  inLeavingPane,
  playEnter,
  playFlight,
  playLeave,
  playPinGhost,
  playPinMove,
  rememberYours,
  takeYours,
} from './cardMotion';
import { useMinuteTick } from './minuteTick';
import { cardLabel, cardRows, headLabel, type CardPerson, type RoomCardModel } from './model';
import { PeopleRows } from './PeopleRows';
import type { CardPosition } from '../shell/slots';

/**
 * The live room card (docs/index-spec.md §3.1 "Room card", §4.3, §5.4, §5.5,
 * §5.7): who is in a room right now, who is talking, and the one thing to do.
 *
 *   ┌ speaker  General                         live 34 min ┐
 *   │ Fuel                              (pinned elsewhere) │
 *   │ (J) Jeremy                                    ▌▍▌▍   │
 *   │ (S) You                                               │
 *   │ [mic] [camera] [screen] [  Open call  ] [x]          │
 *   └──────────────────────────────────────────────────────┘
 *
 * Two background layers: the live tint, and "yours" (stronger tint, edge and
 * glow) that fades in over it when you join (400ms, opacity only). Every move
 * is in `cardMotion.ts`.
 */

export interface RoomCardProps {
  card: RoomCardModel;
  position: CardPosition;
  /** Whether arriving may move (false on the slot's first commit, and in a pane sliding out). */
  mayAnimate: () => boolean;
  /** The room emptied: play the exit, then call `onExited`. */
  exiting?: boolean;
  onExited?: () => void;
}

/** Your call: yours, or listening in (it is what moves between the two places, §5.4). */
const isYourCall = (card: RoomCardModel) => card.state === 'yours' || card.state === 'listening';

/** The toolbar's avatar: where your face flies from (§5.7). */
function toolbarAvatarRect(): DOMRect | null {
  if (typeof document === 'undefined') return null;
  const anchor = document.querySelector('[data-ix-account-anchor]');
  const face = anchor?.querySelector('.ix-av') ?? anchor;
  if (!face || !face.isConnected) return null;
  const rect = face.getBoundingClientRect();
  return rect.width > 0 ? rect : null;
}

export function RoomCard({ card, position, mayAnimate, exiting = false, onExited }: RoomCardProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const now = useMinuteTick();
  const systemAudio = useVoiceStore((state) => state.systemAudioCaptureActive);
  const together = useTogetherStore((state) => state.calls[card.channelId]?.session ?? null);
  const activity = useTogetherActivity(card.channelId);

  const action = useMemo<PillActionTarget>(
    () => ({ serverId: card.serverId, guildId: card.guildId, channelId: card.channelId, title: card.title }),
    [card.serverId, card.guildId, card.channelId, card.title],
  );
  const { rows, overflow } = useMemo(() => cardRows(card.people), [card.people]);
  const self = card.people.find((person) => person.self) ?? null;

  /* ---- Join: your face flies in (§5.7) ----------------------------------- */
  // A change of state into "yours" while this card is on screen is a join.
  const [seenState, setSeenState] = useState(card.state);
  const [flights, setFlights] = useState(0);
  if (seenState !== card.state) {
    setSeenState(card.state);
    if (card.state === 'yours' && seenState !== 'yours') setFlights((count) => count + 1);
  }
  const flown = useRef(0);
  const flight = useRef<{ done: () => void; dispose: () => void } | null>(null);

  const fly = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    flight.current?.dispose();
    flight.current?.done();
    const face = root.querySelector<HTMLElement>('[data-self="true"] .ix-card-row__face');
    // Your name waits for your face; the new controls do not (IX-18, as the
    // prototype draws them: joining answers at once with the controls you now
    // have, while the face is still on its way).
    const holds = [root.querySelector<HTMLElement>('[data-self="true"] .ix-card-row__name')].filter(
      (element): element is HTMLElement => element !== null,
    );
    const played = playFlight(face, toolbarAvatarRect(), holds);
    const record = { done: played.done, dispose: () => {} };
    flight.current = record;
    record.dispose = onSettle(played.animations, () => {
      played.done();
      if (flight.current === record) flight.current = null;
    });
  }, []);

  useLayoutEffect(() => {
    if (flights === flown.current) return;
    flown.current = flights;
    if (mayAnimate() && !inLeavingPane(rootRef.current)) fly();
  }, [flights, fly, mayAnimate]);

  /* ---- Arriving, moving, going ------------------------------------------- */
  const pin = useRef<{ done: () => void } | null>(null);
  // Mount: the card arrives (§5.5), or your card moved between its two places
  // (§5.4). Decided once per card: development's StrictMode runs this effect,
  // its cleanup and this effect again on mount, and only a real unmount (the
  // card is still gone a microtask later) ends a running move.
  const decided = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    const root = rootRef.current;
    const yours = isYourCall(card);
    if (root && !decided.current) {
      decided.current = true;
      let moved = false;
      if (yours && position === 'pinned') {
        const copy = document.querySelector<HTMLElement>(
          `.ix-pane[data-leaving] [data-ix-call-card][data-card-key="${CSS.escape(card.key)}"]`,
        );
        if (copy) {
          moved = true;
          playPinMove(root, copy.getBoundingClientRect());
        }
      } else if (yours && position === 'inline' && !inLeavingPane(root)) {
        const snapshot = takeYours(card.key, 'pinned');
        if (snapshot) {
          moved = true;
          const played = playPinGhost(snapshot, root);
          pin.current = played;
          onSettle(played.animations, () => {
            played.done();
            pin.current = null;
          });
        }
      }
      if (!moved && mayAnimate()) {
        // Measure the flight's landing before the card starts moving.
        if (card.state === 'yours') fly();
        playEnter(root, 'card');
      }
    }
    const key = card.key;
    return () => {
      mounted.current = false;
      // Where your card was, for the other slot to travel from (§5.4).
      if (yours) rememberYours(key, position, root);
      queueMicrotask(() => {
        if (mounted.current) return;
        pin.current?.done();
        flight.current?.dispose();
        flight.current?.done();
      });
    };
    // Mount and unmount only: a card is keyed by its room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The room emptied: the card reverses, then the slot removes it (the list closes up).
  useLayoutEffect(() => {
    if (!exiting) return undefined;
    const animation = mayAnimate() && !inLeavingPane(rootRef.current) ? playLeave(rootRef.current, 'card') : null;
    return onSettle([animation], () => onExited?.());
  }, [exiting, mayAnimate, onExited]);

  /* ---- People: profile card and menu ------------------------------------- */
  const [profile, setProfile] = useState<{ person: CardPerson; position: { x: number; y: number } } | null>(null);
  const [menu, setMenu] = useState<{ person: CardPerson; position: { x: number; y: number } } | null>(null);
  const openProfile = useCallback((person: CardPerson, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setProfile({ person, position: { x: rect.right + 8, y: rect.top } });
  }, []);
  const openMenu = useCallback((person: CardPerson, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenu({ person, position: { x: event.clientX, y: event.clientY } });
  }, []);
  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          label: 'View profile',
          action: () => setProfile({ person: menu.person, position: menu.position }),
        },
        ...(menu.person.sharing && !menu.person.self
          ? [{ label: `Watch ${menu.person.name}'s screen`, action: () => watchStream(action, menu.person.userId) }]
          : []),
      ]
    : [];

  const joined = card.state === 'yours';
  const onMore = () => {
    if (joined) showCall(action);
    else toggleSheet('people');
  };

  // Under the head, what the room plays together (§7.2, §8.5). In a call you hear, the
  // listen-together "now playing" line from the call's own session (a watch plays in the
  // call view); for a room you are not in, the server's summary: "Watching ..." or
  // "Listening to ...".
  const playing = card.heard && together ? currentItem(together) : null;
  const nowPlaying = card.heard
    ? playing && together?.kind === 'listen'
      ? activityLine('listen', playing.title)
      : null
    : activity
      ? activityLine(activity.kind, activity.title)
      : null;
  const label = cardLabel(card, now);

  return (
    <section
      ref={rootRef}
      className="ix-room-card"
      data-testid="ix-room-card"
      data-state={card.state}
      data-position={position}
      data-card-key={card.key}
      data-ix-call-card={isYourCall(card) ? '' : undefined}
      data-exiting={exiting ? 'true' : undefined}
      aria-label={label}
      inert={exiting || undefined}
    >
      <span className="ix-room-card__layer ix-room-card__layer--live" aria-hidden="true" />
      <span className="ix-room-card__layer ix-room-card__layer--yours" aria-hidden="true" />
      <div className="ix-room-card__head">
        <IxGlyph name={card.isDm ? 'phone' : card.stage ? 'stage' : 'speaker'} size={16} className="ix-room-card__glyph" />
        <span className="ix-room-card__title">{card.title}</span>
        <span className="ix-room-card__when">{headLabel(card, now)}</span>
      </div>
      {card.serverLine && <div className="ix-room-card__from">{card.serverLine}</div>}
      {nowPlaying && <div className="ix-room-card__line">{nowPlaying}</div>}
      {joined && systemAudio && (
        <div className="ix-room-card__line ix-room-card__line--privacy" role="status">
          Your computer’s sound is shared
        </div>
      )}
      <PeopleRows
        rows={rows}
        overflow={overflow}
        heard={card.heard}
        animate={mayAnimate}
        noEnterFor={joined ? self?.userId ?? null : null}
        onOpenPerson={openProfile}
        onPersonMenu={openMenu}
        onWatch={(person) => watchStream(action, person.userId)}
        onMore={onMore}
        moreLabel={joined ? 'Open the call' : 'See who is here'}
      />
      <CardActions ref={actionsRef} card={card} />
      {/* On the document: a transformed pane (mid-slide) would otherwise hold the fixed card. */}
      {typeof document !== 'undefined'
        && createPortal(
          <UserProfilePopup
            user={
              profile
                ? { id: profile.person.userId, username: profile.person.name, display_name: profile.person.name, avatar_hash: profile.person.avatar }
                : null
            }
            position={profile?.position ?? null}
            onClose={() => setProfile(null)}
          />,
          document.body,
        )}
      <ContextMenu
        open={menu !== null}
        items={menuItems}
        position={menu?.position}
        label={menu ? menu.person.name : 'Person'}
        onClose={() => setMenu(null)}
      />
    </section>
  );
}
