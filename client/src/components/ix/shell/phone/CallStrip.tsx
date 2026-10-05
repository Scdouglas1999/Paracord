import { useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';

import { useIncomingDmCall } from '../../../../hooks/useIncomingDmCall';
import { LOCAL_SERVER_ID } from '../../../../lib/serverScope';
import { useServerListStore } from '../../../../stores/serverListStore';
import { useVoiceStore } from '../../../../stores/voiceStore';
import { joinCall, showCall, toggleJoinMute, toggleMic } from '../../../glass/pill/pillActions';
import { useJoinMuteStore } from '../../../glass/pill/muteStore';
import { DM_GUILD, heldCard, incomingLine, orderPeople, type RoomCardModel } from '../../card/model';
import { useCardWorld } from '../../card/useCardWorld';
import { Wave } from '../../card/Wave';
import { IxGlyph } from '../../glyphs';
import { AvatarStack } from '../../identity';
import { IX_SPRING, canAnimate, ixReduced } from '../../motion';
import { CreamButton, WideControl } from '../../primitives';

/**
 * The call strip (docs/index-spec.md §9; IX-16): on a phone, while you are in
 * a call, every pushed page carries a 40px strip under its toolbar, because the
 * card that holds the call lives on the root screen.
 *
 *   [speaker] General  (faces)  [wave]                    [mute]
 *
 * The amber speaker (a phone glyph for a direct call), the voice channel's
 * name, up to three faces, the waveform while somebody talks, and your
 * microphone. Tapping the strip (anywhere but the microphone) opens the call
 * as a sheet, which rises out of the strip (`CallSheet`). Somebody calling you
 * uses the same strip: "Jeremy is calling" with Decline and Accept.
 *
 * Mounted by the frame inside main on a phone only; it renders nothing when
 * there is no call. While it shows, the frame's toolbar height grows by 40
 * (ix-phone.css), so the page beneath lays itself out under both.
 *
 * Test id `ix-call-strip` (`data-state`: `yours` | `incoming`).
 */

export const CALL_STRIP_IN_MS = 110;

export function CallStrip() {
  const world = useCardWorld();
  const card = useMemo(() => (world ? heldCard(world, false) : null), [world]);
  const { call: incoming, decline } = useIncomingDmCall();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const kind = incoming ? 'incoming' : card ? 'yours' : null;

  // The strip arrives (a call started while this page is open): it slides down
  // from under the toolbar while the page beneath follows it down.
  const shownBefore = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const shown = kind !== null;
    const before = shownBefore.current;
    shownBefore.current = shown;
    if (!shown || before !== false || ixReduced()) return;
    const strip = rootRef.current;
    if (canAnimate(strip)) {
      const slide = strip.animate([{ transform: 'translateY(-100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
        duration: CALL_STRIP_IN_MS,
        easing: IX_SPRING,
      });
      slide.id = 'ix-call-strip:in';
    }
    const page = strip?.parentElement?.querySelector<HTMLElement>(':scope > .ix-main__content') ?? null;
    if (canAnimate(page)) {
      const follow = page.animate([{ transform: 'translateY(-40px)' }, { transform: 'none' }], {
        duration: CALL_STRIP_IN_MS,
        easing: IX_SPRING,
      });
      follow.id = 'ix-call-strip:page';
    }
  }, [kind]);

  if (incoming) {
    return (
      <div ref={rootRef} className="ix-callstrip" data-testid="ix-call-strip" data-state="incoming" data-ix-call-strip="">
        <IncomingStrip channelId={incoming.channelId} callerName={incoming.callerName} participantCount={incoming.participantCount} onDecline={decline} />
      </div>
    );
  }
  if (!card) return null;
  return (
    <div
      ref={rootRef}
      className="ix-callstrip"
      data-testid="ix-call-strip"
      data-state="yours"
      data-ix-call-strip=""
      data-channel-id={card.channelId}
    >
      <YourStrip card={card} />
    </div>
  );
}

function YourStrip({ card }: { card: RoomCardModel }) {
  const selfMute = useVoiceStore((state) => state.selfMute);
  const joinMuted = useJoinMuteStore((state) => state.joinMuted);
  const people = useMemo(() => orderPeople(card.people), [card.people]);
  const talker = card.talkers[0] ?? null;
  const listening = card.relation === 'listening';
  const muted = listening ? joinMuted : selfMute;
  const glyph = card.isDm ? 'phone' : card.stage ? 'stage' : 'speaker';
  const count = card.people.length;
  const openLabel = `Open call: ${card.title}, ${count === 1 ? '1 person' : `${count} people`}${talker ? `, ${talker.self ? 'you are' : `${talker.name} is`} talking` : ''}`;

  return (
    <>
      <button
        type="button"
        className="ix-callstrip__open"
        aria-label={openLabel}
        onClick={() => showCall({ serverId: card.serverId, guildId: card.guildId, channelId: card.channelId })}
      >
        <IxGlyph name={glyph} size={16} className="ix-callstrip__glyph" />
        <span className="ix-callstrip__name">{card.title}</span>
        <AvatarStack
          className="ix-callstrip__faces"
          people={people.map((person) => ({ userId: person.userId, name: person.faceName, avatar: person.avatar }))}
          size={22}
          overlap={6}
          max={3}
          ring="var(--ix-callstrip-ring)"
        />
        {talker && <Wave userId={talker.userId} real={card.heard} className="ix-callstrip__wave" />}
      </button>
      {!card.audience && (
        <button
          type="button"
          className="ix-callstrip__mic"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          data-muted={muted ? 'true' : 'false'}
          data-testid="ix-call-strip-mic"
          onClick={() => {
            if (listening) void toggleJoinMute(true);
            else void toggleMic();
          }}
        >
          <IxGlyph name={muted ? 'micOff' : 'mic'} size={18} />
        </button>
      )}
    </>
  );
}

function IncomingStrip({
  channelId,
  callerName,
  participantCount,
  onDecline,
}: {
  channelId: string;
  callerName: string;
  participantCount: number;
  onDecline: () => void;
}) {
  const navigate = useNavigate();
  const serverId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const line = incomingLine({ callerName, participantCount });
  return (
    <>
      <span className="ix-callstrip__open ix-callstrip__open--static" role="alert" aria-label={`${line}, direct call`}>
        <IxGlyph name="phone" size={16} className="ix-callstrip__glyph" />
        <span className="ix-callstrip__name">{line}</span>
      </span>
      <span className="ix-callstrip__answer">
        <WideControl className="ix-callstrip__btn" data-testid="ix-call-strip-decline" onClick={onDecline}>
          Decline
        </WideControl>
        <CreamButton
          className="ix-callstrip__btn"
          data-testid="ix-call-strip-accept"
          onClick={() => {
            navigate(`/app/dms/${channelId}`);
            void joinCall({ serverId, guildId: DM_GUILD, channelId, title: callerName });
          }}
        >
          Accept
        </CreamButton>
      </span>
    </>
  );
}
