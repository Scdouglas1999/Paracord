import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
import { getIdentityColor } from '../../../lib/colors';
import { guildInitials, resolveGuildIconUrl } from '../../../lib/guildIcon';
import type { AccountScope } from '../../../lib/serverScope';
import { GlassChip } from '../primitives/Chip';
import { PlaceGlyph } from './Lead';
import type { RowFocus } from './PlaceRows';

/**
 * The server row (docs/glass-spec.md §3.1, screens 01, 02):
 *
 *   [tray + count]  |  ( )  ( )  ( )  ( + )
 *
 * Home and direct messages (the tray, with its unread count), a hairline, one
 * 40px circle per server (its uploaded icon), and `+` to add or join. The server
 * you are in has a 14 x 3 white bar 11px under it, not a ring; another server
 * with something live has a 2px amber ring; mentions are white chips and plain
 * unread counts are gray ones. More servers than fit scroll sideways, with the
 * one you are in kept in view.
 */

export interface ServerCircle {
  key: string;
  scope: AccountScope;
  guildId: string;
  name: string;
  /** The stored icon value; null draws the server's initials. */
  icon: string | null;
  current: boolean;
  /** Somebody is in a voice channel there. */
  live: boolean;
  /** Mentions across the server's channels. */
  mentions: number;
  /** Channels with something unread. */
  unreadChannels: number;
}

export interface ServerRowProps {
  circles: readonly ServerCircle[];
  /** You are on Home, Messages or Friends: the tray is the current place. */
  homeActive: boolean;
  /** Unread conversations, and friend requests, waiting in Home. */
  homeUnread: number;
  /** The one roving stop. */
  stopId: string;
  onStop: (id: string) => void;
  onOpenHome: () => void;
  onOpenServer: (circle: ServerCircle) => void;
  onAdd: () => void;
  onServerMenu?: (event: MouseEvent<HTMLElement>, circle: ServerCircle) => void;
}

export const HOME_ID = 'server:home';
export const ADD_ID = 'server:add';
export const serverIdOf = (circle: Pick<ServerCircle, 'key'>) => `server:${circle.key}`;

function serverWords(circle: ServerCircle): string {
  const parts = [circle.name];
  if (circle.live) parts.push('live');
  if (circle.mentions > 0) parts.push(circle.mentions === 1 ? '1 mention' : `${circle.mentions} mentions`);
  else if (circle.unreadChannels > 0) parts.push(circle.unreadChannels === 1 ? '1 unread channel' : `${circle.unreadChannels} unread channels`);
  return parts.join(', ');
}

const capped = (count: number) => (count > 99 ? '99+' : String(count));

function ServerIcon({ circle }: { circle: ServerCircle }) {
  const src = useAuthenticatedImage(resolveGuildIconUrl({ icon: circle.icon }));
  return (
    <span
      className="glass-server__icon"
      style={src ? undefined : { background: getIdentityColor(circle.guildId) }}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" draggable={false} /> : guildInitials(circle.name)}
    </span>
  );
}

export function ServerRow({
  circles,
  homeActive,
  homeUnread,
  stopId,
  onStop,
  onOpenHome,
  onOpenServer,
  onAdd,
  onServerMenu,
}: ServerRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setFade((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, circles.length]);

  // The server you are in stays in view when the row scrolls.
  const currentKey = circles.find((circle) => circle.current)?.key ?? null;
  useEffect(() => {
    if (!currentKey) return;
    const element = scrollRef.current?.querySelector<HTMLElement>('[data-current]');
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [currentKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-place-row]') ?? []);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    const last = items.length - 1;
    const next =
      event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : event.key === 'ArrowLeft' ? (at <= 0 ? last : at - 1)
      : at >= last ? 0 : at + 1;
    event.preventDefault();
    items[next]?.focus();
  };

  const focusOf = (id: string): RowFocus => ({
    tabIndex: stopId === id ? 0 : -1,
    onFocus: () => onStop(id),
  });

  const home = focusOf(HOME_ID);
  const add = focusOf(ADD_ID);

  return (
    <nav
      className="glass-places-servers"
      aria-label="Servers"
      data-fade-start={fade.start ? '' : undefined}
      data-fade-end={fade.end ? '' : undefined}
    >
      <div ref={scrollRef} className="glass-places-servers__scroll" onKeyDown={onKeyDown}>
        <button
          type="button"
          className="glass-server glass-server--tray glass-focusable"
          data-place-row=""
          data-row-id={HOME_ID}
          data-current={homeActive ? '' : undefined}
          aria-current={homeActive ? 'true' : undefined}
          aria-label={homeUnread > 0 ? `Home and direct messages, ${homeUnread} unread` : 'Home and direct messages'}
          tabIndex={home.tabIndex}
          onFocus={home.onFocus}
          onClick={onOpenHome}
        >
          <PlaceGlyph name="tray" size={19} />
          {homeUnread > 0 && (
            <GlassChip tone="count" className="glass-server__badge glass-server__badge--count" aria-hidden="true">
              {capped(homeUnread)}
            </GlassChip>
          )}
          {homeActive && <span className="glass-server__bar" aria-hidden="true" />}
        </button>
        <span className="glass-places-servers__rule" aria-hidden="true" />

        {circles.map((circle) => {
          const focus = focusOf(serverIdOf(circle));
          return (
            <button
              key={circle.key}
              type="button"
              className="glass-server glass-focusable"
              data-place-row=""
              data-row-id={serverIdOf(circle)}
              data-current={circle.current ? '' : undefined}
              data-live={circle.live ? '' : undefined}
              aria-current={circle.current ? 'true' : undefined}
              aria-label={serverWords(circle)}
              title={circle.name}
              tabIndex={focus.tabIndex}
              onFocus={focus.onFocus}
              onClick={() => onOpenServer(circle)}
              onContextMenu={onServerMenu ? (event) => onServerMenu(event, circle) : undefined}
            >
              <ServerIcon circle={circle} />
              {/* The server you are in has no badge (screen 01): its own rows carry them. */}
              {circle.current ? null : circle.mentions > 0 ? (
                <GlassChip tone="mention" className="glass-server__badge glass-server__badge--mention" aria-hidden="true">
                  {circle.mentions === 1 ? '@' : `@${capped(circle.mentions)}`}
                </GlassChip>
              ) : circle.unreadChannels > 0 ? (
                <GlassChip tone="count" className="glass-server__badge glass-server__badge--count" aria-hidden="true">
                  {capped(circle.unreadChannels)}
                </GlassChip>
              ) : null}
              {circle.current && <span className="glass-server__bar" aria-hidden="true" />}
            </button>
          );
        })}

        <button
          type="button"
          className="glass-server glass-server--add glass-focusable"
          data-place-row=""
          data-row-id={ADD_ID}
          aria-label="Add or join a server"
          tabIndex={add.tabIndex}
          onFocus={add.onFocus}
          onClick={onAdd}
        >
          <PlaceGlyph name="plus" size={17} />
        </button>
      </div>
    </nav>
  );
}
