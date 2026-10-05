import { memo, useEffect, useRef, useState } from 'react';

import { IX_EASE, canAnimate, ixReduced } from '../motion';
import { Avatar, ServerMark } from '../identity';
import { cappedCount, dockLabel, type DockEntry } from './dockModel';

/** The ping: an amber ring leaves the live dot and fades, once (§5.5). */
export const PING_MS = 545;
export const PING_SCALE = 2.2;

export interface DockItemProps {
  entry: DockEntry;
  /** Your own face, for People's mark. */
  me: { id: string; name: string; avatar: string | null } | null;
  current: boolean;
  /** The roving stop: 0 for the one item in the Tab order, -1 for the rest. */
  tabIndex: 0 | -1;
  /** Counts up each time this server goes live while you are not looking at it. */
  pingToken: number;
  onSelect: (key: string) => void;
}

/**
 * One place in the dock (§4.8): a 42x42 target holding a 34px mark, with the
 * amber live dot at its top right and, at its top left, a white dot for unread
 * or a white count for mentions. The current place's mark is at scale 1.08 and
 * the others sit at .82 (CSS, `ix-dock.css`); hover lifts it 2px.
 *
 * The dots are always in the DOM and scale in and out (transform only); the
 * ring that pings is a second element inside the live dot, animated by the Web
 * Animations API on `transform` and `opacity` and nothing else.
 */
export const DockItem = memo(DockItemView, sameItem);

function DockItemView({ entry, me, current, tabIndex, pingToken, onSelect }: DockItemProps) {
  const ring = useRef<HTMLSpanElement>(null);
  const seenToken = useRef(pingToken);

  useEffect(() => {
    if (pingToken === seenToken.current) return;
    seenToken.current = pingToken;
    const element = ring.current;
    // Reduced motion removes pings (§5); jsdom has no animations to play.
    if (!canAnimate(element) || ixReduced()) return;
    element.animate(
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: `scale(${PING_SCALE})`, opacity: 0 },
      ],
      { duration: PING_MS, easing: IX_EASE, id: 'ix-dock:ping' },
    );
  }, [pingToken]);

  // The count stays readable while its chip scales away.
  const [lastCount, setLastCount] = useState(entry.mentions);
  if (entry.mentions > 0 && entry.mentions !== lastCount) setLastCount(entry.mentions);

  // The place you are in carries no dots but live: its own rows say the rest.
  const attention = current ? null : entry.mentions > 0 ? 'count' : entry.unread ? 'dot' : null;

  return (
    <button
      type="button"
      className="ix-dock__item"
      data-dock-item=""
      data-testid="ix-dock-item"
      data-place={entry.key}
      data-dock-stop={entry.key}
      data-tip={entry.name}
      data-kind={entry.kind}
      data-current={current ? '' : undefined}
      data-live={entry.live ? '' : undefined}
      data-attention={attention ?? undefined}
      aria-label={dockLabel(entry, current)}
      aria-current={current ? 'page' : undefined}
      tabIndex={tabIndex}
      onClick={() => onSelect(entry.key)}
    >
      {entry.kind === 'people' && me ? (
        <Avatar userId={me.id} name={me.name} avatar={me.avatar} size={34} className="ix-dock__mark" />
      ) : (
        <ServerMark guildId={entry.key} name={entry.name} icon={entry.icon} hue={entry.hue} size={34} className="ix-dock__mark" />
      )}
      <span className="ix-dock__live" aria-hidden="true">
        <span ref={ring} className="ix-dock__ping" />
      </span>
      <span className="ix-dock__unread" aria-hidden="true" />
      <span className="ix-dock__chip" aria-hidden="true">
        {cappedCount(entry.mentions > 0 ? entry.mentions : lastCount)}
      </span>
    </button>
  );
}

/**
 * The dock rebuilds its entries whenever anything it reads changes (a message in
 * another server, somebody speaking up in a room); an item re-renders only when
 * something it draws did.
 */
function sameItem(a: DockItemProps, b: DockItemProps): boolean {
  if (a.current !== b.current || a.tabIndex !== b.tabIndex || a.pingToken !== b.pingToken) return false;
  if (a.onSelect !== b.onSelect || a.me !== b.me) return false;
  const x = a.entry;
  const y = b.entry;
  return (
    x.key === y.key &&
    x.kind === y.kind &&
    x.name === y.name &&
    x.live === y.live &&
    x.icon === y.icon &&
    x.hue === y.hue &&
    x.unread === y.unread &&
    x.mentions === y.mentions &&
    x.requests === y.requests &&
    x.dmMentions === y.dmMentions
  );
}
