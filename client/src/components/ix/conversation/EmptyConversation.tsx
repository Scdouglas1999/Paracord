import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';

import { useGuildChannels } from '../../../hooks/useChannels';
import { useGuild } from '../../../hooks/useGuilds';
import { EventFormModal } from '../../guild/EventList';
import { IxGlyph } from '../glyphs';
import { Avatar, ServerMark } from '../identity';
import { IX_EASE, IX_REDUCED_MS, canAnimate, ixReduced, measureRect, onSettle } from '../motion';
import { EmptyPage } from '../page';
import { CreamButton } from '../primitives';
import { DraftEventCard } from './DraftEventCard';
import { markWelcomed, useOnboardingRoles } from './joinerWelcome';
import type { ConversationSubject } from './types';
import { useDraftEvent } from './useDraftEvent';
import { useWelcomeActions } from './useWelcomeActions';
import { useWelcomeFacts } from './useWelcomeFacts';
import { Welcome } from './Welcome';
import { buildWelcome } from './welcomeModel';

/** §5.6: the welcome crossfades out while the draft grows in, 300ms. */
export const WELCOME_OUT_MS = 300;

export interface EmptyConversationProps {
  subject: ConversationSubject;
  /** The conversation's own send decision. */
  canSend: boolean;
  /** The first visit to a server you did not make (decided once, when the conversation opened). */
  joiner: boolean;
  /** The conversation's root, for the message box Say hello fills. */
  root: RefObject<HTMLElement | null>;
  /** Brings the onboarding page back; without it "Pick roles" is not offered. */
  onPickRoles?: () => void;
}

/**
 * What a conversation with no messages says (docs/index-spec.md §4.13): the welcome
 * and, once "Plan a night" is pressed, the draft event card that grew out of its
 * card. It is `MessageList`'s `emptyState`, so it exists only while the channel is
 * empty, and the first message (the send flight ghosts this element out) ends it.
 *
 * `data-ix-anchor` tells the feed's FLIP how this block sits: `center` (the
 * welcome, which moves half as far as the message box grows) or `end` (the draft,
 * which sits on the box).
 */
export function EmptyConversation({ subject, canSend, joiner, root, onPickRoles }: EmptyConversationProps) {
  const guildId = subject.kind === 'channel' ? subject.guildId : null;
  const guild = useGuild(guildId);
  const channels = useGuildChannels(guildId);
  const { hasRoles } = useOnboardingRoles(guildId, joiner && Boolean(onPickRoles));
  const facts = useWelcomeFacts({ subject, canSend, joiner, hasRoles: hasRoles && Boolean(onPickRoles) });
  const model = buildWelcome(facts);
  const draft = useDraftEvent({ guildId: guildId ?? '', channelId: subject.channelId, channels });

  const { plan, start } = draft;
  const onPlan = useCallback((card: HTMLElement) => start(measureRect(card)), [start]);
  const actions = useWelcomeActions({
    subject,
    serverName: facts.serverName,
    joiner,
    root,
    onPlan,
    onPickRoles,
  });

  // The joiner welcome is shown once: seeing it is being welcomed.
  useEffect(() => {
    if (joiner && guildId) markWelcomed(guildId);
  }, [joiner, guildId]);

  // The welcome leaves as the draft arrives (a crossfade), then it is gone.
  const [welcomeGone, setWelcomeGone] = useState(false);
  const welcome = useRef<HTMLDivElement | null>(null);
  const planned = plan !== null;
  useLayoutEffect(() => {
    if (!planned) return;
    const element = welcome.current;
    if (!element || !canAnimate(element)) {
      setWelcomeGone(true);
      return;
    }
    const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: ixReduced() ? IX_REDUCED_MS : WELCOME_OUT_MS,
      easing: IX_EASE,
      fill: 'forwards',
    });
    fade.id = 'ix-conversation:welcome-out';
    return onSettle([fade], () => setWelcomeGone(true));
  }, [planned]);

  const mark =
    subject.kind === 'dm' ? (
      subject.isGroup ? (
        <span className="ix-welcome__tile ix-hue-tile" aria-hidden>
          <IxGlyph name="people" size={32} />
        </span>
      ) : (
        <Avatar
          userId={subject.recipient?.id ?? subject.channelId}
          name={subject.title}
          avatar={subject.recipient?.avatar_hash ?? null}
          size={76}
        />
      )
    ) : (
      <ServerMark
        guildId={subject.guildId}
        name={facts.serverName ?? subject.channelName}
        icon={guild?.icon_hash ?? guild?.icon ?? null}
        hue={guild?.hue ?? null}
        size={76}
        radius={22}
        fontSize={34}
      />
    );

  return (
    <div className="ix-conv-empty" data-ix-anchor={planned ? 'end' : 'center'} data-testid="ix-conv-empty">
      {!welcomeGone && (
        <div
          ref={welcome}
          className="ix-conv-empty__welcome ix-tl-col"
          data-leaving={planned ? '' : undefined}
          inert={planned || undefined}
          aria-hidden={planned || undefined}
        >
          <Welcome model={model} mark={mark} onPick={actions.pick} copied={actions.copied} busy={actions.busy} />
        </div>
      )}
      {plan && (
        <div className="ix-conv-empty__draft ix-tl-col">
          <DraftEventCard plan={plan} posting={draft.posting} error={draft.error} onPost={() => void draft.post()} onEdit={draft.openEdit} />
        </div>
      )}
      {plan && draft.editing && guildId && (
        <EventFormModal
          guildId={guildId}
          defaults={{ name: plan.name, start: plan.start, channelId: plan.voice?.id ?? null, entityType: plan.voice ? 1 : 2 }}
          onClose={draft.closeEdit}
          onSaved={(event) => void draft.postCreated(event)}
        />
      )}
    </div>
  );
}

/**
 * "Locked: unlock your vault to read" (docs/index-spec.md §4.11): an encrypted
 * conversation on a device whose encryption is locked. The empty-state layout, one
 * cream "Unlock" (the unlock page, which brings you back here).
 */
export function LockedConversation({ hue }: { hue?: number }) {
  const navigate = useNavigate();
  return (
    <div className="ix-conv-empty" data-ix-anchor="center" data-testid="ix-conv-locked">
      <div className="ix-conv-empty__welcome ix-tl-col">
        <EmptyPage
          inline
          glyph="lock"
          hue={hue}
          title="Locked"
          line="Unlock your vault to read this conversation."
          action={
            <CreamButton
              onClick={() =>
                navigate(`/unlock?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`)
              }
            >
              Unlock
            </CreamButton>
          }
        />
      </div>
    </div>
  );
}
