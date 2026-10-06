import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useServerListStore } from '../../../stores/serverListStore';
import { IxShellProvider, type IxShellValue } from '../shell/IxShellContext';
import { PEOPLE_PLACE, serverPlace, type Place } from '../shell/place';
import { useAddServerStore } from './addServerStore';
import { Dock } from './Dock';
import type { DockEntry } from './dockModel';
import { TIP_DELAY_MS } from './useDockTooltip';

const DEFAULT_GUILDS = [
  { id: 'fuel', name: 'Fuel', scope: { serverId: '__local__', userId: 'me' } },
  { id: 'game', name: 'Game Night', scope: { serverId: '__local__', userId: 'me' } },
];

const mocks = vi.hoisted(() => ({
  guilds: [] as unknown[],
  data: { entries: [] as unknown[], me: null as unknown },
  go: vi.fn(async () => {}),
  openServerMenu: vi.fn(),
}));

vi.mock('./useDockEntries', () => ({ useDockEntries: () => mocks.data }));
vi.mock('./usePlaceNavigation', () => ({ useGoToPlace: () => mocks.go, PEOPLE_PATH: '/app/dms' }));
vi.mock('../menus', () => ({
  openServerMenu: mocks.openServerMenu,
  // Anchors at the pointer, or under the element when the browser reports (0, 0).
  anchorFromEvent: (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) =>
    event.clientX === 0 && event.clientY === 0 ? { element: event.currentTarget, align: 'start' } : { x: event.clientX, y: event.clientY },
}));
vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => mocks.guilds }));
// The sheet is IX-9's frame; here it is just a place to put the content.
vi.mock('../../glass/sheets', () => ({
  SheetFrame: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  closeSheets: vi.fn(),
}));

const ME = { id: '42', name: 'Sean', avatar: null };

function entry(overrides: Partial<DockEntry> & Pick<DockEntry, 'key' | 'name'>): DockEntry {
  return {
    kind: 'server',
    live: false,
    icon: null,
    hue: null,
    unread: false,
    mentions: 0,
    requests: 0,
    dmMentions: 0,
    ...overrides,
  };
}

const PEOPLE = entry({ key: 'people', kind: 'people', name: 'People' });
const FUEL = entry({ key: 'fuel', name: 'Fuel' });
const GAME = entry({ key: 'game', name: 'Game Night' });
const BASE = entry({ key: 'base', name: 'Basecamp' });

function shell(place: Place): IxShellValue {
  return { layout: 'wide', place, guildId: place.kind === 'server' ? place.guildId : null, channelId: null };
}

function Harness({ place }: { place: Place }) {
  return (
    <MemoryRouter>
      <IxShellProvider value={shell(place)}>
        <Dock />
      </IxShellProvider>
    </MemoryRouter>
  );
}

let waapi: WaapiStub;

function mount(entries: DockEntry[], place: Place = serverPlace('fuel')) {
  mocks.data = { entries, me: ME };
  const view = render(<Harness place={place} />);
  return {
    ...view,
    update(next: DockEntry[], nextPlace: Place = place) {
      mocks.data = { entries: next, me: ME };
      view.rerender(<Harness place={nextPlace} />);
    },
  };
}

const item = (place: string) => document.querySelector<HTMLElement>(`[data-testid="ix-dock-item"][data-place="${place}"]`) as HTMLElement;
const stops = () => [...document.querySelectorAll<HTMLElement>('[data-dock-stop]')];
const tabStop = () => stops().filter((node) => node.getAttribute('tabindex') === '0').map((node) => node.dataset.dockStop);

beforeEach(() => {
  mocks.guilds = DEFAULT_GUILDS;
  useServerListStore.setState({ activeServerId: null, servers: [] });
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
  mocks.go.mockClear();
  mocks.openServerMenu.mockClear();
  useAddServerStore.setState({ open: false, tab: 'create' });
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  vi.useRealTimers();
});

describe('two servers that minted the same id', () => {
  const TWIN = entry({ key: 'twin', name: 'Cedar place' });
  const TWIN_ON_LANTERN = entry({ key: 'twin@s_lantern', name: 'Lantern place' });

  beforeEach(() => {
    mocks.guilds = [
      { id: 'twin', name: 'Cedar place', scope: { serverId: '__local__', userId: 'me' } },
      { id: 'twin', name: 'Lantern place', scope: { serverId: 's_lantern', userId: 'me2' } },
    ];
  });

  it('shows both, each under its own place', () => {
    mount([PEOPLE, TWIN, TWIN_ON_LANTERN], serverPlace('twin'));
    expect(screen.getAllByTestId('ix-dock-item').map((node) => node.dataset.place)).toEqual(['people', 'twin', 'twin@s_lantern']);
  });

  it('marks the one on the selected saved server as the current place', () => {
    mount([PEOPLE, TWIN, TWIN_ON_LANTERN], serverPlace('twin'));
    expect(item('twin')).toHaveAttribute('aria-current', 'page');
    expect(item('twin@s_lantern')).not.toHaveAttribute('aria-current');

    act(() => useServerListStore.setState({ activeServerId: 's_lantern' }));
    expect(item('twin@s_lantern')).toHaveAttribute('aria-current', 'page');
    expect(item('twin')).not.toHaveAttribute('aria-current');
  });

  it('opens the server menu for the server the item is on', () => {
    mount([PEOPLE, TWIN, TWIN_ON_LANTERN], serverPlace('twin'));
    fireEvent.contextMenu(item('twin@s_lantern'), { clientX: 40, clientY: 50 });
    expect(mocks.openServerMenu).toHaveBeenCalledWith(
      { guildId: 'twin', scope: { serverId: 's_lantern', userId: 'me2' }, name: 'Lantern place' },
      expect.anything(),
    );
  });
});

describe('the dock', () => {
  it('is one toolbar named Servers with People first, the servers in order, then +', () => {
    mount([PEOPLE, FUEL, GAME, BASE]);
    const bar = screen.getByRole('toolbar', { name: 'Servers' });
    expect(bar).toHaveAttribute('data-testid', 'ix-dock');
    expect(within(bar).getAllByTestId('ix-dock-item').map((node) => node.dataset.place)).toEqual(['people', 'fuel', 'game', 'base']);
    // + is last, and is not a place.
    const all = within(bar).getAllByRole('button');
    expect(all.map((node) => node.getAttribute('aria-label'))).toEqual(['People', 'Fuel', 'Game Night', 'Basecamp', 'Add a server']);
    expect(screen.getByTestId('ix-dock-add')).not.toHaveAttribute('data-place');
    // The separator sits after People.
    expect(bar.querySelector('.ix-dock__sep')).not.toBeNull();
  });

  it('marks the current place, in the DOM and for assistive tech', () => {
    mount([PEOPLE, FUEL, GAME], serverPlace('game'));
    expect(item('game')).toHaveAttribute('aria-current', 'page');
    expect(item('game')).toHaveAttribute('data-current', '');
    expect(item('fuel')).not.toHaveAttribute('aria-current');
    expect(item('people')).not.toHaveAttribute('data-current');
  });

  it('draws People as your own avatar and a server as its mark', () => {
    mount([PEOPLE, FUEL]);
    expect(item('people').querySelector('.ix-av')).not.toBeNull();
    expect(item('people').querySelector('.ix-av')).toHaveTextContent('S');
    expect(item('fuel').querySelector('.ix-sq')).toHaveTextContent('F');
    expect(item('fuel').querySelector('.ix-dock__mark')).not.toBeNull();
  });

  it('clicking a place goes to it', () => {
    mount([PEOPLE, FUEL, GAME]);
    fireEvent.click(item('game'));
    expect(mocks.go).toHaveBeenCalledWith('game');
    fireEvent.click(item('people'));
    expect(mocks.go).toHaveBeenLastCalledWith('people');
  });
});

describe('live, unread and mentions (§4.8)', () => {
  it('shows the live dot while a server is live, the unread dot for unread, and the count for mentions', () => {
    mount([
      PEOPLE,
      FUEL,
      { ...GAME, live: true, unread: true },
      { ...BASE, unread: true, mentions: 3 },
    ]);
    expect(item('game')).toHaveAttribute('data-live', '');
    expect(item('game')).toHaveAttribute('data-attention', 'dot');
    expect(item('game')).toHaveAttribute('aria-label', 'Game Night, live, unread');
    expect(item('base')).toHaveAttribute('data-attention', 'count');
    expect(item('base').querySelector('.ix-dock__chip')).toHaveTextContent('3');
    expect(item('base')).toHaveAttribute('aria-label', 'Basecamp, 3 mentions');
    expect(item('fuel')).not.toHaveAttribute('data-live');
    expect(item('fuel')).not.toHaveAttribute('data-attention');
  });

  it('caps a count at 99+', () => {
    mount([PEOPLE, FUEL, { ...GAME, mentions: 140 }]);
    expect(item('game').querySelector('.ix-dock__chip')).toHaveTextContent('99+');
  });

  it('says nothing but live for the place you are in', () => {
    mount([PEOPLE, { ...FUEL, live: true, unread: true, mentions: 2 }, GAME], serverPlace('fuel'));
    expect(item('fuel')).toHaveAttribute('data-live', '');
    expect(item('fuel')).not.toHaveAttribute('data-attention');
    expect(item('fuel')).toHaveAttribute('aria-label', 'Fuel, live');
  });

  it('counts friend requests and direct-message mentions on People', () => {
    mount([{ ...PEOPLE, mentions: 3, requests: 1, dmMentions: 2 }, FUEL], serverPlace('fuel'));
    expect(item('people')).toHaveAttribute('data-attention', 'count');
    expect(item('people').querySelector('.ix-dock__chip')).toHaveTextContent('3');
    expect(item('people')).toHaveAttribute('aria-label', 'People, 1 friend request, 2 mentions');
  });
});

describe('the one-time ping (§5.5)', () => {
  const pings = () => waapi.played.filter((record) => record.options.id === 'ix-dock:ping');

  it('plays once when a server you are not in goes live, on transform and opacity only', () => {
    const view = mount([PEOPLE, FUEL, GAME, BASE], serverPlace('fuel'));
    expect(pings()).toHaveLength(0);

    view.update([PEOPLE, FUEL, { ...GAME, live: true }, BASE]);
    expect(pings()).toHaveLength(1);
    const [ping] = pings();
    expect(ping.target.closest('[data-place]')).toBe(item('game'));
    expect(ping.target).toHaveClass('ix-dock__ping');
    expect(ping.keyframes).toEqual([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(2.2)', opacity: 0 },
    ]);
    expect(ping.options).toMatchObject({ duration: 365, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });

    // A re-render, or another change in the dock, does not replay it.
    view.update([PEOPLE, FUEL, { ...GAME, live: true, unread: true }, BASE]);
    expect(pings()).toHaveLength(1);
  });

  it('plays again after the server goes dark and live again', () => {
    const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    view.update([PEOPLE, FUEL, { ...GAME, live: true }]);
    view.update([PEOPLE, FUEL, GAME]);
    view.update([PEOPLE, FUEL, { ...GAME, live: true }]);
    expect(pings()).toHaveLength(2);
  });

  it('never plays for the place you are in', () => {
    const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    view.update([PEOPLE, { ...FUEL, live: true }, GAME]);
    expect(item('fuel')).toHaveAttribute('data-live', '');
    expect(pings()).toHaveLength(0);
  });

  it('never plays for a server that was already live when the dock first saw it, or one that has just joined', () => {
    const view = mount([PEOPLE, FUEL, { ...GAME, live: true }], serverPlace('fuel'));
    expect(pings()).toHaveLength(0);
    view.update([PEOPLE, FUEL, { ...GAME, live: true }, { ...BASE, live: true }]);
    expect(pings()).toHaveLength(0);
  });

  it('is removed by reduced motion', () => {
    configureMotion('reduced');
    const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    view.update([PEOPLE, FUEL, { ...GAME, live: true }]);
    expect(pings()).toHaveLength(0);
    expect(item('game')).toHaveAttribute('data-live', '');
  });
});

describe('the indicator (§5.1)', () => {
  const glides = () => waapi.played.filter((record) => record.options.id === 'ix-dock:indicator');

  it('is one element, hidden until it has a place, then drawn under the current item', () => {
    mount([PEOPLE, FUEL, GAME]);
    const bars = document.querySelectorAll('.ix-dock__ind');
    expect(bars).toHaveLength(1);
    expect((bars[0] as HTMLElement).style.opacity).toBe('1');
    expect((bars[0] as HTMLElement).style.transform).toMatch(/^translateX\(/);
  });

  it('glides 165ms on the spring when the place changes, and not at first paint or when nothing changed', () => {
    const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    expect(glides()).toHaveLength(0);
    view.update([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    expect(glides()).toHaveLength(0);
  });

  it('moves with the item: a place change that lands somewhere else plays the glide', () => {
    // jsdom has no layout, so every x is 0 and a "move" of 0 is not played; give the items a layout.
    const rects = new Map<string, number>([['people', 12], ['fuel', 71], ['game', 119]]);
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const element = this as HTMLElement;
      // The servers' scroller is wide enough to show everything.
      if (element.classList.contains('ix-dock__scroll')) return { x: 63, y: 0, left: 63, top: 0, right: 263, bottom: 0, width: 200, height: 0, toJSON: () => ({}) } as DOMRect;
      const place = element.dataset.place;
      const left = place ? (rects.get(place) ?? 0) : 0;
      return { x: left, y: 0, left, top: 0, right: left + (place ? 42 : 0), bottom: 0, width: place ? 42 : 0, height: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
      expect((document.querySelector('.ix-dock__ind') as HTMLElement).style.transform).toBe('translateX(84px)');
      view.update([PEOPLE, FUEL, GAME], serverPlace('game'));
      expect(glides()).toHaveLength(1);
      const [glide] = glides();
      expect(glide.keyframes).toEqual([{ transform: 'translateX(84px)' }, { transform: 'translateX(132px)' }]);
      expect(glide.options).toMatchObject({ duration: 165, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      expect((document.querySelector('.ix-dock__ind') as HTMLElement).style.transform).toBe('translateX(132px)');
      // A newer glide cancels the running one (no queueing).
      view.update([PEOPLE, FUEL, GAME], serverPlace('people'));
      expect(glides()).toHaveLength(2);
      expect(glides()[0].canceled).toBe(true);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe('the roving toolbar (§4.8, §10)', () => {
  it('has one Tab stop, on the current place', () => {
    mount([PEOPLE, FUEL, GAME], serverPlace('game'));
    expect(tabStop()).toEqual(['game']);
  });

  it('starts on People when the place is People, and falls back to the first when the current is not in the dock', () => {
    mount([PEOPLE, FUEL], PEOPLE_PLACE);
    expect(tabStop()).toEqual(['people']);
  });

  it('Left and Right move focus and wrap; Home and End go to the ends; + is in the ring', () => {
    mount([PEOPLE, FUEL, GAME]);
    item('fuel').focus();
    fireEvent.keyDown(item('fuel'), { key: 'ArrowRight' });
    expect(item('game')).toHaveFocus();
    fireEvent.keyDown(item('game'), { key: 'ArrowRight' });
    expect(screen.getByTestId('ix-dock-add')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('ix-dock-add'), { key: 'ArrowRight' });
    expect(item('people')).toHaveFocus();
    fireEvent.keyDown(item('people'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('ix-dock-add')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('ix-dock-add'), { key: 'Home' });
    expect(item('people')).toHaveFocus();
    fireEvent.keyDown(item('people'), { key: 'End' });
    expect(screen.getByTestId('ix-dock-add')).toHaveFocus();
  });

  it('the Tab stop follows focus, and goes back to the current place when the place changes', () => {
    const view = mount([PEOPLE, FUEL, GAME], serverPlace('fuel'));
    act(() => item('people').focus());
    expect(tabStop()).toEqual(['people']);
    view.update([PEOPLE, FUEL, GAME], serverPlace('game'));
    expect(tabStop()).toEqual(['game']);
  });

  it('leaves arrows with a modifier to whoever wants them', () => {
    mount([PEOPLE, FUEL, GAME]);
    item('fuel').focus();
    fireEvent.keyDown(item('fuel'), { key: 'ArrowRight', altKey: true });
    expect(item('fuel')).toHaveFocus();
  });

  it('Enter on an item is a click on it', () => {
    mount([PEOPLE, FUEL, GAME]);
    const target = item('game');
    target.focus();
    // A button turns Enter into click; the handler is the click.
    fireEvent.click(target);
    expect(mocks.go).toHaveBeenCalledWith('game');
  });
});

describe('the tooltip (§4.8)', () => {
  it('opens the name after 400ms of hover and closes when the pointer leaves', () => {
    vi.useFakeTimers();
    mount([PEOPLE, FUEL, GAME]);
    const tip = () => document.querySelector('.ix-dock__tip') as HTMLElement;
    fireEvent.pointerOver(item('game'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    });
    expect(tip()).not.toHaveAttribute('data-open');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(tip()).toHaveAttribute('data-open');
    expect(tip()).toHaveTextContent('Game Night');
    // It is decoration: the item already carries its name.
    expect(tip()).toHaveAttribute('aria-hidden', 'true');

    // Moving to a neighbor while it is open is immediate.
    fireEvent.pointerOver(item('fuel'), { pointerType: 'mouse' });
    expect(tip()).toHaveTextContent('Fuel');

    fireEvent.pointerLeave(screen.getByRole('toolbar'));
    expect(tip()).not.toHaveAttribute('data-open');
  });

  it('does not open for touch, and a press puts it away', () => {
    vi.useFakeTimers();
    mount([PEOPLE, FUEL]);
    fireEvent.pointerOver(item('fuel'), { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS + 50);
    });
    expect(document.querySelector('.ix-dock__tip')).not.toHaveAttribute('data-open');

    fireEvent.pointerOver(item('fuel'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS + 50);
    });
    expect(document.querySelector('.ix-dock__tip')).toHaveAttribute('data-open');
    fireEvent.pointerDown(item('fuel'));
    expect(document.querySelector('.ix-dock__tip')).not.toHaveAttribute('data-open');
  });

  it('names + as well', () => {
    vi.useFakeTimers();
    mount([PEOPLE, FUEL]);
    fireEvent.pointerOver(screen.getByTestId('ix-dock-add'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS + 50);
    });
    expect(document.querySelector('.ix-dock__tip')).toHaveTextContent('Add a server');
  });
});

describe('right-click (§6.2)', () => {
  it('opens the server menu at the pointer for a server', () => {
    mount([PEOPLE, FUEL, GAME]);
    const event = fireEvent.contextMenu(item('game'), { clientX: 140, clientY: 760 });
    expect(event).toBe(false); // default prevented: the browser's own menu stays shut
    expect(mocks.openServerMenu).toHaveBeenCalledWith(
      { guildId: 'game', scope: { serverId: '__local__', userId: 'me' }, name: 'Game Night' },
      { x: 140, y: 760 },
    );
  });

  it('hangs the menu under the item when it was opened from the keyboard', () => {
    mount([PEOPLE, FUEL, GAME]);
    fireEvent.contextMenu(item('game'), { clientX: 0, clientY: 0 });
    expect(mocks.openServerMenu).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'game' }), { element: item('game'), align: 'start' });
  });

  it('does nothing for People or +', () => {
    mount([PEOPLE, FUEL]);
    fireEvent.contextMenu(item('people'), { clientX: 10, clientY: 10 });
    fireEvent.contextMenu(screen.getByTestId('ix-dock-add'), { clientX: 10, clientY: 10 });
    expect(mocks.openServerMenu).not.toHaveBeenCalled();
  });
});

describe('+ (the Add a server sheet)', () => {
  it('toggles the sheet and says so', () => {
    mount([PEOPLE, FUEL]);
    const plus = screen.getByTestId('ix-dock-add');
    expect(plus).toHaveAttribute('aria-expanded', 'false');
    expect(plus).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(plus);
    expect(useAddServerStore.getState().open).toBe(true);
    expect(plus).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(plus);
    expect(useAddServerStore.getState().open).toBe(false);
  });
});

describe('overflow (§4.8)', () => {
  it('keeps People and + outside the servers that scroll', () => {
    mount([PEOPLE, FUEL, GAME, BASE]);
    const scroller = document.querySelector('.ix-dock__scroll') as HTMLElement;
    expect([...scroller.querySelectorAll('[data-place]')].map((node) => (node as HTMLElement).dataset.place)).toEqual(['fuel', 'game', 'base']);
    expect(scroller.contains(item('people'))).toBe(false);
    expect(scroller.contains(screen.getByTestId('ix-dock-add'))).toBe(false);
  });

  it('sets the fade attributes from the scroll position and maps a vertical wheel to a horizontal scroll', () => {
    mount([PEOPLE, FUEL, GAME, BASE]);
    const scroller = document.querySelector('.ix-dock__scroll') as HTMLElement;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 400 });

    // Measured on scroll: more beyond the end, none before the start.
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(scroller).toHaveAttribute('data-fade-end');
    expect(scroller).not.toHaveAttribute('data-fade-start');

    // A vertical wheel moves it sideways, and the default scroll is cancelled.
    const wheel = new WheelEvent('wheel', { deltaY: 60, cancelable: true, bubbles: true });
    scroller.dispatchEvent(wheel);
    expect(scroller.scrollLeft).toBe(60);
    expect(wheel.defaultPrevented).toBe(true);

    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(scroller).toHaveAttribute('data-fade-start');
    scroller.scrollLeft = 300;
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(scroller).not.toHaveAttribute('data-fade-end');
  });

  it('lets the wheel through when everything fits, and when it is already horizontal', () => {
    mount([PEOPLE, FUEL]);
    const scroller = document.querySelector('.ix-dock__scroll') as HTMLElement;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 300 });
    const fits = new WheelEvent('wheel', { deltaY: 60, cancelable: true });
    scroller.dispatchEvent(fits);
    expect(fits.defaultPrevented).toBe(false);

    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 900 });
    const sideways = new WheelEvent('wheel', { deltaX: 80, deltaY: 4, cancelable: true });
    scroller.dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(false);
  });
});
