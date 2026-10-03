import { useRef, useState, type CSSProperties } from 'react';
import { Phone, PhoneOff, Search, Users } from 'lucide-react';
import { useConversationActions } from '../../../hooks/useConversationActions';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useCurrentReadStates } from '../../../hooks/useReadStates';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import { entityScopeKey } from '../../../lib/serverScope';
import { ContextMenu } from '../../ui/ContextMenu';
import { Tooltip } from '../../ui/Tooltip';
import { VoiceConnectionCheck } from '../../voice/VoiceConnectionCheck';
import { CallPill } from '../pill';
import { PlacesToggle } from '../shell/PlacesToggle';
import { useGlassLayout } from '../shell/useGlassLayout';
import type { ConversationSubject } from '../shell/slots';
import { HeaderAvatar } from './HeaderAvatar';
import { toggleHeaderSheet, useHeaderSheetOpen } from './sheetBridge';
import { attentionCaption, useChannelMenu } from './useChannelMenu';
import { useDmCall } from './useDmCall';

/**
 * The conversation header (docs/glass-spec.md §3.2, §8; WP-G11).
 *
 * Wide and compact (76px): the title (20/600) with its topic under it starts
 * at the column's left edge; the call pill's slot is right-aligned to the
 * column's right edge; search, members and your face sit at the pane's right
 * edge. The title opens the channel menu. No `#`, no dot.
 *
 * Phone (§8, `screens/07`): the pill sits above the header (the pane mounts it
 * there); the header is the title (17/600), the server under it, and how many
 * messages are new, with search and members as quiet icons. Its first button
 * is "Back to places" (`PlacesToggle`): on a phone places is its own screen.
 */
export function ConversationHeader({ subject }: { subject: ConversationSubject }) {
  const scope = useCurrentAccountScope();
  return (
    <OwnedConversationHeader
      key={scope ? entityScopeKey(scope, subject.channelId) : `unavailable:${subject.channelId}`}
      subject={subject}
    />
  );
}

/** Width of the right-edge cluster, so the flow area can stop short of it. */
function toolsWidth(count: number): number {
  const gutter = 16;
  const button = 40;
  const gap = 6;
  const avatarNudge = 4;
  return gutter + count * button + Math.max(0, count - 1) * gap + avatarNudge;
}

/** How many messages from other people were new when this conversation opened. */
function useNewOnEntry(channelId: string, enabled: boolean): number {
  const me = useCurrentUser()?.id;
  const readStates = useCurrentReadStates();
  const messages = useCurrentMessageStore((s) => s.messages[channelId]);
  const [snapshot, setSnapshot] = useState<{ channelId: string; count: number } | null>(null);

  // Taken once per conversation, the first time both the messages and the read
  // marker are known (React's "adjust state while rendering" form: it settles
  // in the same pass, with no effect and no extra commit).
  const read = readStates[channelId];
  if (enabled && snapshot?.channelId !== channelId && messages?.length && read) {
    setSnapshot({
      channelId,
      count: messages.filter(
        (message) => message.author?.id !== me && isMessageUnread(message.id, read.last_message_id),
      ).length,
    });
  }

  return snapshot?.channelId === channelId ? snapshot.count : 0;
}

function encryptionCaption(encrypted: boolean, encryption: string): string {
  if (!encrypted) return 'Not encrypted';
  if (encryption === 'ready') return 'End-to-end encrypted';
  if (encryption === 'unlock') return 'Encryption locked on this device';
  if (encryption === 'identity_mismatch') return 'Encryption keys do not match';
  return 'Encryption needs setup';
}

function OwnedConversationHeader({ subject }: { subject: ConversationSubject }) {
  const layout = useGlassLayout();
  const phone = layout === 'phone';
  const isDM = subject.kind === 'dm';
  const isGroupDm = subject.kind === 'dm' && subject.isGroup;

  const { actions, encrypted, encryption, loading, error } = useConversationActions(subject.channelId);
  const menu = useChannelMenu({ subject, summary: actions.summary });
  const dmCall = useDmCall(isDM ? subject.channelId : undefined, actions.voice.allowed, actions.voice.reason);

  const searchOpen = useHeaderSheetOpen('search');
  const peopleOpen = useHeaderSheetOpen('people', { isGroupDm });
  const newCount = useNewOnEntry(subject.channelId, phone && !isDM);

  // The title's menu opens under the title and hands focus to what it opened.
  const titleRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const restoreFocus = useRef(true);
  const openMenu = () => {
    if (menuPosition) {
      setMenuPosition(null);
      return;
    }
    // Under the whole heading (the topic too), lined up with the title button.
    const title = titleRef.current?.getBoundingClientRect();
    const heading = titleRef.current?.closest('.glass-header__heading')?.getBoundingClientRect();
    if (!title) return;
    restoreFocus.current = true;
    setMenuPosition({ x: title.left, y: Math.max(title.bottom, heading?.bottom ?? 0) + 6 });
  };
  const closeMenu = () => {
    setMenuPosition(null);
    if (restoreFocus.current) titleRef.current?.focus({ preventScroll: true });
  };
  const menuItems = menu.items.map((item) => ({
    ...item,
    action: () => {
      // The destination panel or dialog owns focus after a choice; giving it
      // back to the title here would steal it.
      restoreFocus.current = false;
      item.action();
    },
  }));

  const title = subject.kind === 'dm' ? subject.title || 'Direct message' : subject.channelName || 'Channel';
  // How the conversation is protected is only said once the server has said it:
  // before that, "not encrypted" would be a guess, and a wrong one.
  const known = !loading && !error;
  const subtitle = subject.kind === 'dm'
    ? (known ? encryptionCaption(encrypted, encryption) : undefined)
    : phone
      ? subject.guildName
      : subject.topic?.trim() || subject.guildName || (known && encrypted ? encryptionCaption(encrypted, encryption) : undefined);
  const subtitleTitle = subject.kind === 'channel' && subject.topic?.trim() ? subject.topic.trim() : undefined;

  const searchLabel = 'Search messages';
  const peopleLabel = isDM ? 'People in this message' : 'Members';

  const toolCount = 3 + (isDM ? 1 : 0);
  const style = { '--glass-header-tools-w': `${toolsWidth(toolCount)}px` } as CSSProperties;

  const descriptionId = `${subject.channelId}-attention`;

  return (
    <div className="glass-header" data-layout={layout} data-subject={subject.kind} style={style}>
      {/* Phone: places is its own screen and this is the way back to it; compact:
          it opens the places overlay; wide: nothing (places is a pane). */}
      <PlacesToggle className={phone ? 'glass-header__btn glass-header__nav' : 'glass-header__places'} />

      <div ref={headingRef} className="glass-header__heading">
        <h1 className="glass-header__name">
          <button
            ref={titleRef}
            type="button"
            className="glass-header__title glass-focusable"
            aria-haspopup="menu"
            aria-expanded={menuPosition != null}
            aria-describedby={descriptionId}
            onClick={openMenu}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (!menuPosition) openMenu();
              }
            }}
          >
            {title}
          </button>
        </h1>
        <span id={descriptionId} className="sr-only">
          {attentionCaption(menu.attention.unread, menu.attention.mentions)}
        </span>
        {subtitle && (
          <p className="glass-header__sub" title={subtitleTitle}>
            {subtitle}
          </p>
        )}
      </div>

      {phone && newCount > 0 && <span className="glass-kicker glass-header__new">{newCount} new</span>}

      {!phone && (
        <div className="glass-header__pill">
          <CallPill
            guildId={subject.kind === 'channel' ? subject.guildId : null}
            channelId={subject.kind === 'channel' ? subject.channelId : null}
            layout="row"
          />
        </div>
      )}

      <div className="glass-header__tools" aria-label="Conversation actions" role="group">
        {isDM && (
          <Tooltip content={dmCall.reason ?? (dmCall.inCall ? 'End direct message call' : 'Start direct message voice call')} side="bottom">
            <button
              type="button"
              className="glass-header__btn glass-focusable"
              aria-label={dmCall.inCall ? 'End direct message call' : 'Start direct message voice call'}
              aria-pressed={dmCall.inCall}
              disabled={dmCall.disabled}
              onClick={dmCall.toggle}
            >
              {dmCall.inCall ? <PhoneOff size={18} aria-hidden /> : <Phone size={18} aria-hidden />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={searchLabel} side="bottom">
          <button
            type="button"
            className="glass-header__btn glass-focusable"
            aria-label={searchLabel}
            aria-expanded={searchOpen}
            onClick={() => toggleHeaderSheet('search')}
          >
            <Search size={18} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content={peopleLabel} side="bottom">
          <button
            type="button"
            className="glass-header__btn glass-focusable"
            aria-label={peopleLabel}
            aria-expanded={peopleOpen}
            onClick={() => toggleHeaderSheet('people', { isGroupDm })}
          >
            <Users size={18} aria-hidden />
          </button>
        </Tooltip>
        {!phone && <HeaderAvatar />}
      </div>

      <ContextMenu
        label="Channel actions"
        anchorRef={headingRef}
        anchorAlign="start"
        open={menuPosition != null}
        position={menuPosition ?? undefined}
        items={menuItems}
        onClose={closeMenu}
      />
      {menu.dialogs}
      {isDM && <VoiceConnectionCheck open={dmCall.showCheck} onClose={dmCall.closeCheck} autoStart />}
    </div>
  );
}
