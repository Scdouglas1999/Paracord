import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import { IxGlyph } from '../glyphs';
import { anchorFromEvent, openServerMenu } from '../menus';
import { useIxShell } from '../shell/IxShellContext';
import { usePlaceKeys } from '../shell/placeKeys';
import type { DockSlotProps } from '../shell/slots';
import { AddServerSheet } from './AddServerSheet';
import { useAddServerStore } from './addServerStore';
import { DockItem } from './DockItem';
import { PEOPLE_KEY, rovingTarget } from './dockModel';
import { useDockEntries } from './useDockEntries';
import { useDockIndicator } from './useDockIndicator';
import { useDockOverflow } from './useDockOverflow';
import { useDockPings } from './useDockPings';
import { useDockTooltip } from './useDockTooltip';
import { useGoToPlace } from './usePlaceNavigation';

const ADD_STOP = 'add';

/** The closest element carrying `data-tip` (an item, or the `+`). */
const tipTarget = (event: { target: EventTarget | null }) =>
  (event.target as Element | null)?.closest<HTMLElement>('[data-tip]') ?? null;

/**
 * The dock (docs/index-spec.md §4.8): People first, a separator, the servers in
 * the order the client has them, then `+`. It sits at the foot of the sidebar
 * and carries the one thing that is not about this server: where else you could
 * be, and what is waiting there.
 *
 *   one toolbar named "Servers", one Tab stop (roving: Left and Right, Home and
 *   End, Enter); the stop starts on the current place
 *   one indicator under the current place that glides to the next
 *   amber live dot, white unread dot or mention count, a ping the first time a
 *   server you are not in goes live
 *   name tooltips above the item after 400ms
 *   the servers scroll sideways when they do not fit (People and `+` stay put)
 *   right-click on a server: the server menu (IX-9's `openServerMenu`; the sheet slot mounts it)
 *   `+`: the Add a server sheet
 *
 * Switching is navigating (`useGoToPlace`); the shell follows the route and plays
 * the slide, the tint and (here) the glide. Place shortcuts live in
 * `hooks/useKeyboardNavigation` and use the same `useGoToPlace`.
 */
export function Dock(_props: DockSlotProps) {
  const { place } = useIxShell();
  const { keys } = usePlaceKeys();
  // The place's key among the dock's: the server's id, qualified only when two servers share one.
  const current = keys.currentKey(place);
  const { entries, me } = useDockEntries();
  const goToPlace = useGoToPlace();
  const addOpen = useAddServerStore((state) => state.open);
  const toggleAdd = useAddServerStore((state) => state.toggleSheet);

  const people = entries.find((entry) => entry.key === PEOPLE_KEY) ?? null;
  const servers = useMemo(() => entries.filter((entry) => entry.key !== PEOPLE_KEY), [entries]);
  const stops = useMemo(() => [...entries.map((entry) => entry.key), ADD_STOP], [entries]);

  // The indicator owns the three elements it measures: the dock, its scroller and the bar.
  const { dock: rootRef, scroller: scrollRef, indicator: indicatorRef } = useDockIndicator(
    stops.includes(current) ? current : null,
    stops.join('|'),
  );
  const tipRef = useRef<HTMLSpanElement>(null);

  /* ---- Switching ---------------------------------------------------------------- */

  // Items are memoized; they call the latest `goToPlace` (it changes with the route).
  const goRef = useRef(goToPlace);
  useLayoutEffect(() => {
    goRef.current = goToPlace;
  }, [goToPlace]);
  const onSelect = useCallback((key: string) => {
    void goRef.current(key);
  }, []);

  /* ---- The Tab stop ------------------------------------------------------------- */

  // What was focused last, for the place it was focused in: a new current place
  // takes the Tab stop back, whatever was focused before it.
  const [focused, setFocused] = useState<{ place: string; stop: string } | null>(null);
  const lastStop = focused && focused.place === current ? focused.stop : null;
  const stop = lastStop && stops.includes(lastStop) ? lastStop : stops.includes(current) ? current : (stops[0] ?? '');

  /* ---- Tooltip -------------------------------------------------------------------- */

  const tooltip = useDockTooltip(rootRef);
  const { leave: leaveTip, reach: reachTip } = tooltip;
  const tip = tooltip.tip;
  // Centered over its item, and never closer than 8px to the sidebar's edges.
  useLayoutEffect(() => {
    const element = tipRef.current;
    const frame = rootRef.current;
    if (!element || !frame || !tip) return;
    const room = frame.clientWidth - element.offsetWidth - 8;
    element.style.left = `${Math.max(8, Math.min(tip.center - element.offsetWidth / 2, room))}px`;
  }, [tip, rootRef]);
  // The bubble would point at an item that has scrolled away.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const hide = () => leaveTip();
    element.addEventListener('scroll', hide, { passive: true });
    return () => element.removeEventListener('scroll', hide);
  }, [leaveTip, scrollRef]);

  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const target = tipTarget(event);
    if (target) reachTip(target, 'hover');
    else leaveTip();
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = tipTarget(event);
    if (!target) return;
    const stopKey = target.dataset.dockStop;
    if (stopKey) setFocused({ place: current, stop: stopKey });
    // Keyboard focus names the item; a click's focus must not (it knows what it pressed).
    if (target.matches(':focus-visible')) reachTip(target, 'focus');
  };

  /* ---- Roving focus ------------------------------------------------------------- */

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') leaveTip();
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-dock-stop]') ?? []);
    const at = items.findIndex((item) => item === document.activeElement);
    const target = rovingTarget(items.length, at, event.key);
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };

  /* ---- Right-click: the server menu --------------------------------------------- */

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const item = (event.target as Element).closest<HTMLElement>('[data-dock-item][data-kind="server"]');
    if (!item) return;
    const guild = keys.guildOf(item.dataset.place ?? '');
    if (!guild) return;
    event.preventDefault();
    leaveTip();
    // At the pointer; a keyboard-opened context menu reports (0, 0) and hangs under the item.
    openServerMenu(
      { guildId: guild.id, scope: guild.scope, name: guild.name },
      anchorFromEvent({ clientX: event.clientX, clientY: event.clientY, currentTarget: item }),
    );
  };

  /* ---- Overflow, indicator, pings --------------------------------------------------- */

  const fade = useDockOverflow(scrollRef, servers.length);
  const pings = useDockPings(entries, current);

  const itemFor = (entry: (typeof entries)[number]) => (
    <DockItem
      key={entry.key}
      entry={entry}
      me={me}
      current={entry.key === current}
      tabIndex={entry.key === stop ? 0 : -1}
      pingToken={pings[entry.key] ?? 0}
      onSelect={onSelect}
    />
  );

  return (
    <>
      <div
        ref={rootRef}
        className="ix-dock"
        role="toolbar"
        aria-label="Servers"
        aria-orientation="horizontal"
        data-testid="ix-dock"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={(event) => leaveTip(tipTarget(event))}
        onPointerOver={onPointerOver}
        onPointerLeave={() => leaveTip()}
        onPointerDown={() => leaveTip()}
        onContextMenu={onContextMenu}
      >
        <span ref={indicatorRef} className="ix-dock__ind" data-testid="ix-dock-indicator" aria-hidden="true" />
        {people && itemFor(people)}
        <span className="ix-dock__sep" aria-hidden="true" />
        <div
          ref={scrollRef}
          className="ix-dock__scroll"
          data-fade-start={fade.start ? '' : undefined}
          data-fade-end={fade.end ? '' : undefined}
        >
          {servers.map(itemFor)}
        </div>
        <button
          type="button"
          className="ix-dock__item ix-dock__add"
          data-testid="ix-dock-add"
          data-dock-stop={ADD_STOP}
          data-tip="Add a server"
          aria-label="Add a server"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          tabIndex={stop === ADD_STOP ? 0 : -1}
          onClick={toggleAdd}
        >
          <span className="ix-dock__plus" aria-hidden="true">
            <IxGlyph name="plus" size={16} />
          </span>
        </button>
        <span ref={tipRef} className="ix-dock__tip" data-open={tooltip.shown ? '' : undefined} aria-hidden="true">
          {tip?.label}
        </span>
      </div>
      <AddServerSheet />
    </>
  );
}
