import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { compareMessageIds } from '../../../hooks/useChannelPreviews';
import { displayName } from '../../../lib/displayName';
import { messagePreviewText } from '../../../lib/markdown';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import type { Message } from '../../../types';
import { messageMentionsUser } from '../../message/MessageList';
import { Face } from '../places/Lead';
import type { FaceModel } from '../places/model';

/**
 * Messages surfacing over the stream while the chat is hidden (docs/glass-spec.md
 * §6.2): "While hidden, new messages surface over the stream at the bottom left
 * (bubble tone at 92% with a 12px blur; a mention of you gets a 1.5px white
 * edge) for a few seconds; clicking one brings the chat back."
 *
 * Which messages: the ones that arrive in the conversation you hid (the
 * route's channel, the one beside the stage) after you hid it, from anyone but
 * you. Each stays `SURFACE_MS`, at most `SURFACE_MAX` at once (the oldest goes
 * first). "Nick in General"; a mention of you reads "Jeremy mentioned you".
 * Showing the chat again (H, the chat button, or a click here) clears them: the
 * conversation itself has them now.
 *
 * For a screen reader each one is announced once, politely, since the chat that
 * would carry it is hidden.
 */

export const SURFACE_MS = 6000;
export const SURFACE_MAX = 3;

export interface SurfacedMessage {
  id: string;
  face: FaceModel;
  name: string;
  /** "in General", or "mentioned you". */
  where: string;
  text: string;
  mention: boolean;
}

export interface SurfacingMessagesProps {
  /** Theater with the chat hidden, and not browsing. */
  active: boolean;
  /** Bring the chat back. */
  onShowChat: () => void;
}

const NONE: readonly Message[] = [];

/** A message as a surfacing bubble says it, or null for one that should not surface. Pure. */
export function surfaced(
  message: Message,
  context: { selfUserId: string | null; channelName: string; names: ReadonlyMap<string, string> },
): SurfacedMessage | null {
  const author = message.author;
  if (!author || author.id === context.selfUserId) return null;
  const kind = message.message_type ?? (typeof message.type === 'number' ? message.type : 0);
  if (kind !== 0 && kind !== 19) return null;
  const name = message.anonymous?.is_anonymous ? message.anonymous.alias : displayName(author);
  const mention = messageMentionsUser(message, context.selfUserId);
  let text: string;
  if (message.e2ee && !message.content) text = 'Encrypted message';
  else if (message.content?.trim()) text = messagePreviewText(message.content, context.names);
  else if (message.attachments?.length) text = message.attachments.length === 1 ? 'Shared a file' : `Shared ${message.attachments.length} files`;
  else if (message.stickers?.length) text = 'Sent a sticker';
  else return null;
  return {
    id: message.id,
    face: { userId: author.id, name, avatar: message.anonymous?.is_anonymous ? null : author.avatar_hash ?? null },
    name,
    where: mention ? 'mentioned you' : `in ${context.channelName}`,
    text,
    mention,
  };
}

export function SurfacingMessages({ active, onShowChat }: SurfacingMessagesProps) {
  const { guildId, channelId } = useParams();
  const scope = useCurrentAccountScope();
  const me = useCurrentUser();
  const messages = useCurrentMessageStore((state) => (channelId ? state.messages[channelId] ?? NONE : NONE));
  const channelName = useChannelStore((state) =>
    scope && channelId ? state.channelsById[entityScopeKey(scope, channelId)]?.name ?? null : null,
  );
  const roster = useMemberStore((state) => (scope && guildId ? state.members.get(entityScopeKey(scope, guildId)) : undefined));
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of roster ?? []) map.set(member.user.id, displayName(member.user, member.nick));
    // "@Sean" in a mention of you, even before the roster has loaded.
    if (me && !map.has(me.id)) map.set(me.id, displayName(me));
    return map;
  }, [roster, me]);

  const [shown, setShown] = useState<Array<SurfacedMessage & { until: number }>>([]);
  const [announcement, setAnnouncement] = useState('');
  /** The newest message already in the conversation when the chat was hidden. */
  const baseline = useRef<string | null>(null);
  const armed = useRef(false);

  // Hiding the chat draws the line: only what arrives after it surfaces.
  // Showing it again clears what surfaced (the conversation has them now).
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && shown.length > 0) setShown([]);
  }
  useEffect(() => {
    if (!active) {
      armed.current = false;
      return;
    }
    if (!armed.current) {
      armed.current = true;
      baseline.current = messages.length > 0 ? messages[messages.length - 1].id : null;
      return;
    }
    const since = baseline.current;
    const fresh = messages.filter((message) => since === null || compareMessageIds(message.id, since) > 0);
    if (fresh.length === 0) return;
    baseline.current = fresh[fresh.length - 1].id;
    const context = { selfUserId: me?.id ?? null, channelName: channelName ?? 'the chat', names };
    const next = fresh.map((message) => surfaced(message, context)).filter((item): item is SurfacedMessage => item !== null);
    if (next.length === 0) return;
    const until = Date.now() + SURFACE_MS;
    setShown((current) => [...current, ...next.map((item) => ({ ...item, until }))].slice(-SURFACE_MAX));
    const last = next[next.length - 1];
    setAnnouncement(`${last.name} ${last.where}: ${last.text}`);
  }, [active, messages, me?.id, channelName, names]);

  // Each bubble stays a few seconds from when it surfaced.
  useEffect(() => {
    if (shown.length === 0) return;
    const soonest = Math.min(...shown.map((item) => item.until));
    const timer = setTimeout(() => {
      const now = Date.now();
      setShown((current) => current.filter((item) => item.until > now));
    }, Math.max(0, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [shown]);

  if (!active) return null;
  return (
    <div className="glass-surfacing" data-glass-move="surfacing">
      {shown.length > 0 && (
        <button
          type="button"
          className="glass-surfacing__stack glass-focusable"
          aria-label={`Show chat, ${shown.length} new ${shown.length === 1 ? 'message' : 'messages'}`}
          onClick={onShowChat}
        >
          {shown.map((item) => (
            <span key={item.id} className="glass-surfacing__bubble" data-mention={item.mention ? 'true' : undefined}>
              <Face face={item.face} size={28} className="glass-surfacing__face" />
              <span className="glass-surfacing__text">
                <span className="glass-surfacing__who">
                  {item.name} <span className="glass-surfacing__where">{item.where}</span>
                </span>
                <span className="glass-surfacing__body">{item.text}</span>
              </span>
            </span>
          ))}
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
