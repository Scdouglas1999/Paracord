import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

import { useConversationActions } from '../../../hooks/useConversationActions';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useGuild } from '../../../hooks/useGuilds';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { entityScopeKey } from '../../../lib/serverScope';
import type { Message } from '../../../types';
import { displayName } from '../../../lib/displayName';
import { ErrorBoundary } from '../../ErrorBoundary';
import { MessageInput } from '../../message/MessageInput';
import { MessageList } from '../../message/MessageList';
import { IxGlyph } from '../glyphs';
import { LargeTitle, useTitleFold } from '../page';
import { PEOPLE_PLACE, serverPlace, useOptionalIxShell, useToolbar, usePlaceHue } from '../shell';
import { openChannelMenu, openProfileCard } from '../menus';
import { DmCallButton } from './DmCallButton';
import { DropTarget } from './DropTarget';
import { EmptyConversation, LockedConversation } from './EmptyConversation';
import { JoinerCard } from './JoinerCard';
import { isWelcomed, markWelcomed, useOnboardingRoles } from './joinerWelcome';
import { subtitleFor } from './subtitle';
import type { ConversationSubject } from './types';
import { useComposerFlip } from './useComposerFlip';
import { useLandingChannelId } from './useWelcomeFacts';
import { useWelcomeActions } from './useWelcomeActions';
import { joinerActions } from './welcomeModel';

export interface IxConversationProps {
  subject: ConversationSubject;
  /** Under the large title, scrolling with it: a pinned score, a stage channel's session. */
  notices?: ReactNode;
  /** A pushed page (a thread, §6.1): the toolbar's back chevron. Esc and Alt+Left are the host's to bind. */
  onBack?: () => void;
  backLabel?: string;
  /** Brings the server's onboarding page back ("Pick roles" in the joiner welcome). */
  onPickRoles?: () => void;
}

/**
 * A conversation in main (docs/index-spec.md §3, §4.11-4.13, §5.6, §5.12, §5.14;
 * IX-15): replaces the Glass `ConversationPane`. It composes the timeline
 * (`MessageList`) and the message box (`MessageInput`), and adds what is neither:
 *
 *   title      the large title (36/700) is the timeline's `header`, the first item
 *              of its scroller, so it scrolls away with the oldest messages and
 *              folds into the toolbar as it goes (`useTitleFold`, §5.14). The
 *              toolbar says the folded title, the DM call button and the back
 *              chevron of a pushed page (`useToolbar`). The title opens the
 *              channel menu (a DM: the person's profile card).
 *   welcome    `emptyState`: "Fuel is ready", a channel's, a joiner's, a new
 *              message's, with the cards that fit and "Plan a night"'s draft.
 *   feed       follows the message box as it opens, grows and closes
 *              (`useComposerFlip`, §5.12).
 *   drop       files dragged over main land in the box (`DropTarget`, §4.12).
 *
 * Reply state lives here; the page that hosts it builds the subject and nothing else.
 */
export function IxConversation(props: IxConversationProps) {
  const scope = useCurrentAccountScope();
  const key = scope ? entityScopeKey(scope, props.subject.channelId) : `unavailable:${props.subject.channelId}`;
  return <OwnedConversation key={key} {...props} />;
}

function OwnedConversation({ subject, notices, onBack, backLabel, onPickRoles }: IxConversationProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const channelId = subject.channelId;
  const guildId = subject.kind === 'channel' ? subject.guildId : null;
  const isDm = subject.kind === 'dm';
  const isGroup = subject.kind === 'dm' && subject.isGroup;
  const isThread = subject.kind === 'channel' && Boolean(subject.isThread);

  const { actions, encrypted, encryption, loading, error } = useConversationActions(channelId);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const { folded, titleRef } = useTitleFold(scroller);
  useComposerFlip(column, scroller, channelId);

  const hue = usePlaceHue(guildId ? serverPlace(guildId) : PEOPLE_PLACE);
  const guild = useGuild(guildId);
  const me = useCurrentUser();
  const landingId = useLandingChannelId(guildId);

  // The title, and the line under it.
  const title = subject.kind === 'dm' ? subject.title || 'Direct message' : subject.channelName || 'Channel';
  const known = !loading && !error;
  const subtitle = subtitleFor(subject, {
    serverName: guild?.name ?? (subject.kind === 'channel' ? subject.guildName : undefined),
    isLanding: landingId !== null && landingId === channelId,
    known,
    encrypted,
    encryption,
  });

  // What the title opens: the channel menu, or (a one-to-one message) the person's profile card (§4.11).
  // The handlers read the latest subject, summary and fold from a ref, so the toolbar is told once
  // and not on every render.
  const profileUser = subject.kind === 'dm' && !subject.isGroup ? (subject.recipient ?? null) : null;
  const latest = useRef({ subject, summary: actions.summary, folded });
  useLayoutEffect(() => {
    latest.current = { subject, summary: actions.summary, folded };
  });
  const titleElement = useCallback((): HTMLElement | null => {
    const main = root.current?.closest('.ix-main') ?? document;
    const selector = latest.current.folded ? '.ix-toolbar__title' : '.ix-large-title__button';
    return main.querySelector<HTMLElement>(selector) ?? root.current;
  }, []);
  const channelMenu = useCallback(
    (at: { x: number; y: number } | null) => {
      const { subject: current, summary } = latest.current;
      const request = {
        subject:
          current.kind === 'dm'
            ? ({ kind: 'dm', channelId: current.channelId, title: current.title, isGroup: current.isGroup } as const)
            : ({ kind: 'channel', guildId: current.guildId, channelId: current.channelId, channelName: current.channelName } as const),
        summary,
      };
      const element = titleElement();
      openChannelMenu(request, at ?? (element ? { element, align: 'start' } : { x: 0, y: 0 }));
    },
    [titleElement],
  );
  const profileId = profileUser?.id ?? null;
  const openTitle = useCallback(() => {
    const current = latest.current.subject;
    if (profileId && current.kind === 'dm' && current.recipient) {
      const recipient = current.recipient;
      const rect = titleElement()?.getBoundingClientRect();
      openProfileCard(
        {
          id: recipient.id,
          username: recipient.username,
          display_name: recipient.display_name ?? undefined,
          avatar_hash: recipient.avatar_hash ?? null,
        },
        { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 6 },
      );
      return;
    }
    channelMenu(null);
  }, [profileId, titleElement, channelMenu]);
  // A one-to-one message's title is the profile; its pins and media stay reachable by right click (or the menu key).
  const onHeadContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!profileId) return;
      event.preventDefault();
      channelMenu(event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY });
    },
    [profileId, channelMenu],
  );

  // The toolbar: the folded title, the DM call, the back chevron. On a phone a
  // one-to-one message also gets "…" for its channel menu (pins, media, catch
  // up): there is no right click on glass, and its title is the profile (IX-16).
  const phone = useOptionalIxShell()?.layout === 'phone';
  const call = useMemo(
    () =>
      isDm ? (
        <>
          <DmCallButton channelId={channelId} title={title} allowed={actions.voice.allowed} reason={actions.voice.reason} />
          {phone && profileId && (
            <button
              type="button"
              className="ix-tool"
              aria-label="Conversation options"
              title="Conversation options"
              aria-haspopup="menu"
              data-testid="ix-conversation-more"
              onClick={() => channelMenu(null)}
            >
              <IxGlyph name="dots" size={18} />
            </button>
          )}
        </>
      ) : undefined,
    [isDm, channelId, title, actions.voice.allowed, actions.voice.reason, phone, profileId, channelMenu],
  );
  useToolbar({
    title,
    onTitleClick: openTitle,
    titleHasPopup: profileUser ? 'dialog' : 'menu',
    folded,
    onBack: onBack ?? null,
    backLabel,
    call,
    search: true,
    members: true,
  });

  // A server you did not make, the first time: welcomed once (decided when both are known).
  const [joinerKnown, setJoinerKnown] = useState<boolean | null>(null);
  if (joinerKnown === null && guildId && guild && me) setJoinerKnown(guild.owner_id !== me.id && !isWelcomed(guildId));
  const joiner = joinerKnown === true;
  const [dismissed, setDismissed] = useState(false);
  const hasMessages = useCurrentMessageStore((state) => (state.messages[channelId]?.length ?? 0) > 0);
  const canSend = actions.send.allowed;
  const showJoinerCard = joiner && !dismissed && hasMessages && !isThread && Boolean(guildId);
  const { hasRoles } = useOnboardingRoles(guildId, showJoinerCard && Boolean(onPickRoles));
  const cardActions = useWelcomeActions({
    subject,
    serverName: guild?.name,
    joiner: true,
    root,
    onPlan: () => undefined,
    onPickRoles,
  });
  const dismissJoiner = useCallback(() => {
    if (guildId) markWelcomed(guildId);
    setDismissed(true);
  }, [guildId]);

  // The header: the large title, then what the page pins under it.
  const header = (
    <div className="ix-tl-col ix-conv-head" onContextMenu={onHeadContextMenu}>
      <LargeTitle
        title={title}
        subtitle={
          subtitle.text || subtitle.lock ? (
            <span className="ix-conv-sub">
              {subtitle.text && <span>{subtitle.text}</span>}
              {subtitle.lock && (
                <span className="ix-conv-sub__lock" data-testid="ix-encrypted-line">
                  <IxGlyph name="lock" size={12} />
                  {subtitle.lock}
                </span>
              )}
            </span>
          ) : undefined
        }
        onTitleClick={openTitle}
        titleHasPopup={profileUser ? 'dialog' : 'menu'}
        foldRef={titleRef}
      />
      {notices != null && <div className="ix-conv-notices">{notices}</div>}
    </div>
  );

  const locked = encrypted && encryption === 'unlock' && known;
  const emptyState = isThread ? undefined : locked ? (
    <LockedConversation hue={hue} />
  ) : (
    <EmptyConversation subject={subject} canSend={canSend} joiner={joiner} root={root} onPickRoles={onPickRoles} />
  );

  const hostStyle = { '--ix-hue': hue, '--ix-timeline-top': 'var(--ix-toolbar-h)' } as CSSProperties;
  return (
    <div ref={root} className="ix-conv" data-testid="ix-conversation" data-subject={subject.kind} style={hostStyle}>
      <ErrorBoundary variant="section" label="messages">
        <MessageList
          channelId={channelId}
          onReply={(message: Message) =>
            setReplyingTo({ id: message.id, author: displayName(message.author), content: message.content || '' })
          }
          header={header}
          emptyState={emptyState}
          onScroller={setScroller}
        />
      </ErrorBoundary>
      <div ref={setColumn} className="ix-composer-column">
        {showJoinerCard && guildId && (
          <JoinerCard
            guildId={guildId}
            name={guild?.name ?? 'this server'}
            icon={guild?.icon_hash ?? guild?.icon ?? null}
            hue={guild?.hue ?? null}
            description={guild?.description}
            actions={joinerActions({ canSend, hasRoles: hasRoles && Boolean(onPickRoles) })}
            onPick={(action, element) => {
              cardActions.pick(action, element);
              dismissJoiner();
            }}
            onDismiss={dismissJoiner}
          />
        )}
        <MessageInput
          channelId={channelId}
          guildId={guildId ?? undefined}
          channelName={title}
          conversationKind={subject.kind === 'dm' ? (isGroup ? 'group' : 'person') : 'channel'}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
      </div>
      <DropTarget root={root} channelId={channelId} name={title} />
    </div>
  );
}
