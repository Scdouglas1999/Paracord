import { useMemo, useRef, type MouseEvent } from 'react';

import { compareMessageIds, previewFromMessage, snowflakeTime } from '../../../hooks/useChannelPreviews';
import { useAccountMessageStore } from '../../../hooks/useMessageStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { dmCompanions } from '../../../lib/dmTitle';
import { displayName } from '../../../lib/displayName';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { formatRowTime } from '../../glass/places/model';
import { withLocalDecryption } from '../../glass/places/usePlacesData';
import { IxGlyph } from '../glyphs';
import { Avatar } from '../identity';
import { FLIP_ATTRIBUTE } from '../sidebar/useCollapse';
import { SELECTED_ATTRIBUTE } from '../sidebar/useSelectionGlide';
import type { RowFocus } from '../sidebar/useRovingList';
import { usePreviewRoll } from '../sidebar/usePreviewRoll';
import { dmPreviewLine, dmStateWords } from './peopleModel';
import { useConversationPreview } from './useConversationPreview';
import { useNearViewport } from './useNearViewport';

export interface DmRowProps extends RowFocus {
  entry: ConversationEntry;
  href: string;
  selected: boolean;
  /** The pane is sliding out: nothing plays. */
  leaving: boolean;
  nowMs: number;
  onOpen: () => void;
}

interface Face {
  userId: string;
  name: string;
  avatar: string | null;
}

/** Is a plain primary click (a modifier click or a middle click is the browser's)? */
function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * A conversation (docs/index-spec.md §6.6): a channel row with a 38px face. A group
 * has two overlapped 26px faces. The name, the time of the last message, its line
 * and a white dot when something is unread; a mention is the white count under the
 * time. State is in the accessible name ("Jeremy, unread").
 *
 * The line is read per row and only once the row is near the screen: the newest
 * message from the message store when it holds the conversation's real tail, else
 * one request for it.
 */
export function DmRow({ entry, href, selected, leaving, nowMs, tabIndex, onFocus, onOpen }: DmRowProps) {
  const rowRef = useRef<HTMLAnchorElement>(null);
  const near = useNearViewport(rowRef);
  const group = entry.kind === 'group_dm';
  const channel = useChannelStore((state) => state.channelsById[entityScopeKey(entry.scope, entry.channelId)]);

  const tail = useAccountMessageStore(entry.scope, (state) => {
    const loaded = state.messages[entry.channelId];
    return loaded && loaded.length > 0 ? loaded[loaded.length - 1] : undefined;
  });
  // The store speaks for the newest message only when it holds the conversation's real tail.
  const tailIsCurrent = tail && (!entry.lastActivityId || compareMessageIds(tail.id, entry.lastActivityId) >= 0);
  const fetched = useConversationPreview(entry, 'latest', near && !tailIsCurrent);
  const message = tailIsCurrent ? tail : (fetched.preview?.message ?? null);

  const people = useMemo(() => dmCompanions(channel, entry.scope.userId), [channel, entry.scope.userId]);
  const faces = useMemo<Face[]>(() => {
    const list: Face[] = people.slice(0, 2).map((person) => ({
      userId: person.id,
      name: displayName(person),
      avatar: (person as { avatar_hash?: string | null }).avatar_hash ?? null,
    }));
    if (list.length === 0) list.push({ userId: entry.userId ?? entry.channelId, name: entry.title, avatar: entry.avatar ?? null });
    return list;
  }, [people, entry.userId, entry.channelId, entry.title, entry.avatar]);

  const line = useMemo(() => {
    if (!message) return null;
    const asEntry = previewFromMessage(message);
    const shown = withLocalDecryption(new Map([[entry.channelId, asEntry]]), { [entry.channelId]: [message] }).get(entry.channelId) ?? asEntry;
    if (shown.encrypted) return { text: 'Encrypted', encrypted: true };
    const names = new Map<string, string>(people.map((person) => [person.id, displayName(person)]));
    names.set(entry.scope.userId, 'you');
    const text = dmPreviewLine(
      shown,
      { selfUserId: entry.scope.userId, memberNames: names, channelNames: new Map(), eventNames: new Map() },
      group,
    );
    return text ? { text, encrypted: false } : null;
  }, [message, people, entry.channelId, entry.scope.userId, group]);

  const empty = !entry.lastActivityId || entry.lastActivityId === '0';
  const lineText = line?.text ?? (empty ? 'No messages yet' : fetched.failed ? 'Preview unavailable' : null);
  const when = snowflakeTime(entry.lastActivityId);
  const time = formatRowTime(when, nowMs);
  const [lineRef, timeRef] = usePreviewRoll(lineText, time, !leaving);

  // The conversation you are reading is read as you read it.
  const mentions = selected ? 0 : entry.mentionCount;
  const unread = !selected && (entry.isDMUnread || entry.mentionCount > 0);
  const state = dmStateWords(unread, mentions);

  return (
    <li>
      <a
        ref={rowRef}
        href={href}
        className="ix-ch ix-dm"
        data-testid="ix-dm-row"
        data-channel-id={entry.channelId}
        data-place-row=""
        data-row-id={`dm:${entry.key}`}
        data-group={group || undefined}
        data-unread={unread || undefined}
        data-mentions={mentions > 0 || undefined}
        {...{ [FLIP_ATTRIBUTE]: '', ...(selected ? { [SELECTED_ATTRIBUTE]: '' } : null) }}
        aria-current={selected ? 'page' : undefined}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="ix-ch__dot" aria-hidden="true" />
        <span className="ix-dm__lead" data-group={group && faces.length > 1 ? '' : undefined} aria-hidden="true">
          {group && faces.length > 1 ? (
            <>
              <span className="ix-dm__face ix-dm__face--a">
                <Avatar userId={faces[0].userId} name={faces[0].name} avatar={faces[0].avatar} size={26} />
              </span>
              <span className="ix-dm__face ix-dm__face--b">
                <Avatar userId={faces[1].userId} name={faces[1].name} avatar={faces[1].avatar} size={26} />
              </span>
            </>
          ) : (
            <Avatar userId={faces[0].userId} name={faces[0].name} avatar={faces[0].avatar} size={38} />
          )}
        </span>
        <span className="ix-ch__name">
          <span className="ix-ch__name-text">{entry.title}</span>
          {state.length > 0 && <span className="sr-only">, {state.join(', ')}</span>}
        </span>
        {time && (
          <time ref={timeRef} className="ix-ch__time" dateTime={when !== null ? new Date(when).toISOString() : undefined}>
            {time}
          </time>
        )}
        <span ref={lineRef} className="ix-ch__line">
          {line?.encrypted && <IxGlyph name="lock" size={12} />}
          {lineText && <span className="ix-ch__line-text">{lineText}</span>}
        </span>
        {mentions > 0 && (
          <span className="ix-ch__mention" aria-hidden="true">
            {mentions > 99 ? '99+' : mentions}
          </span>
        )}
      </a>
    </li>
  );
}
