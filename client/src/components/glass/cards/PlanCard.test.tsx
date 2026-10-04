import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuildEventResult, GuildEventView } from './useGuildEvent';
import { EventButton, EventCard } from './EventCard';
import { useEventMaybeStore } from './eventMaybe';
import { EventPlanCard, EventPlanView, eventMetaParts, isEventOver } from './EventPlanCard';
import { PlanAction, PlanCard } from './PlanCard';

const mocks = vi.hoisted(() => ({
  event: {
    status: 'ready',
    event: null,
    error: null,
    busy: false,
    toggleRsvp: vi.fn(),
  } as unknown as GuildEventResult,
  channels: { '2002': { id: '2002', name: 'Lounge', type: 2 } } as Record<string, { id: string; name: string; type: number }>,
}));

vi.mock('./useGuildEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useGuildEvent')>()),
  useGuildEvent: () => mocks.event,
}));
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => ({ serverId: 'srv', userId: '42' }),
}));
vi.mock('../../../hooks/useChannels', () => ({
  useCurrentChannelStore: (selector: (view: { channelsById: typeof mocks.channels }) => unknown) =>
    selector({ channelsById: mocks.channels }),
}));

/** Thursday 1 October 2026, 2:00 PM, local. */
const NOW = new Date(2026, 9, 1, 14, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const event = (over: Partial<GuildEventView> = {}): GuildEventView => ({
  id: '7001',
  guildId: 'g1',
  name: 'Haz 5 run',
  startsAt: new Date(NOW + 3 * 60 * 60 * 1000),
  endsAt: null,
  channelId: '2002',
  location: null,
  creatorId: '101',
  going: 3,
  youAreGoing: false,
  status: 1,
  ...over,
});

function show(over: Partial<GuildEventView> = {}, result: Partial<GuildEventResult> = {}) {
  mocks.event = { status: 'ready', event: event(over), error: null, busy: false, toggleRsvp: vi.fn(), ...result };
  return render(<EventPlanCard guildId="g1" eventId="7001" />);
}

beforeEach(() => {
  // The time line reads the wall clock ("Today at", "Tonight at", "Tomorrow at"):
  // pin it to the afternoon so an event three hours out is always today.
  // Only Date is faked; timers stay real for Testing Library.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useEventMaybeStore.setState({ marks: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlanCard (the card family: a title, a line, and what goes under them)', () => {
  it('is a titled group with the line, the decision and the faces', () => {
    const { container } = render(
      <PlanCard
        title="Haz 5 run"
        meta="Tonight at 9:30 PM in Lounge"
        action={<PlanAction taken={false} onToggle={() => {}} />}
        slots={[
          { key: 'a', name: 'Brendan', face: { userId: '101' } },
          { key: 'b', name: 'Luke', detail: '10 min', face: { userId: '102' } },
          { key: 'c', name: '1 open', open: true },
        ]}
      />,
    );
    const card = screen.getByRole('group', { name: 'Plan: Haz 5 run' });
    expect(card).toHaveClass('ix-card');
    expect(within(card).getByText('Tonight at 9:30 PM in Lounge')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Take the spot' })).toBeInTheDocument();
    expect(card.querySelectorAll('.ix-plan__slot')).toHaveLength(3);
    // A face is an Index avatar (one letter), an open slot is the dashed circle.
    expect(container.querySelectorAll('.ix-plan__slot .ix-av')).toHaveLength(2);
    expect(card.querySelector('[data-open] .ix-plan__open')).not.toBeNull();
  });

  it('keeps every slot’s name for assistive tech, since the visible names hide when the card is narrow', () => {
    render(<PlanCard title="Plan" slots={[{ key: 'l', name: 'Luke', detail: '10 min', face: { userId: '102' } }]} />);
    expect(screen.getByText('Luke, 10 min')).toHaveClass('sr-only');
    // The visible copy is decoration for the same words.
    expect(document.querySelector('.ix-plan__name')).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks a card that follows a bubble of its group', () => {
    const { rerender } = render(<PlanCard title="Plan" />);
    expect(screen.getByRole('group')).not.toHaveAttribute('data-join-top');
    rerender(<PlanCard title="Plan" joinTop />);
    expect(screen.getByRole('group')).toHaveAttribute('data-join-top', 'true');
  });
});

describe('PlanAction', () => {
  it('takes the spot, and is “You’re in” with a check once taken', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PlanAction taken={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the spot' }));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<PlanAction taken onToggle={onToggle} />);
    const taken = screen.getByRole('button', { name: 'You’re in' });
    expect(taken.querySelector('svg')).not.toBeNull();
  });
});

describe('EventCard (the prototype’s .event)', () => {
  it('is a tile, a title, a line and the actions, and the tile is decoration', () => {
    const { container } = render(
      <EventCard weekday="Fri" day="9" title="Game night" meta="Friday at 9:00 PM · in General">
        <EventButton primary>Post it</EventButton>
        <EventButton>Edit</EventButton>
      </EventCard>,
    );
    const card = screen.getByRole('group', { name: 'Event: Game night' });
    expect(card).toHaveClass('ix-card', 'ix-event');
    expect(within(card).getByText('Friday at 9:00 PM · in General')).toBeInTheDocument();
    const tile = container.querySelector('.ix-event__day');
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile).toHaveClass('ix-hue-weekday');
    expect(tile).toHaveTextContent('Fri9');
  });

  it('has one cream button; the others are quiet', () => {
    const { container } = render(
      <EventCard weekday="Fri" day="9" title="Game night">
        <EventButton primary>Post it</EventButton>
        <EventButton>Edit</EventButton>
      </EventCard>,
    );
    expect(container.querySelectorAll('.ix-cream')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Post it' })).toHaveClass('ix-cream--sm');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveClass('ix-event__btn');
  });

  it('has no actions row when it has no actions', () => {
    const { container } = render(<EventCard weekday="Fri" day="9" title="Game night" />);
    expect(container.querySelector('.ix-event__acts')).toBeNull();
  });
});

describe('eventMetaParts and isEventOver', () => {
  it('says when, where and how many, and nothing about a canceled event but that it is', () => {
    expect(eventMetaParts(event(), NOW, 'Lounge')).toEqual({ when: 'Tonight at 5:00 PM', live: false, parts: ['in Lounge', '3 going'] });
    expect(eventMetaParts(event({ channelId: null, location: 'Garage', going: 0 }), NOW, null).parts).toEqual(['Garage']);
    expect(eventMetaParts(event({ status: 4 }), NOW, 'Lounge')).toEqual({ when: 'Canceled', live: false, parts: [] });
    expect(eventMetaParts(event({ startsAt: new Date(NOW - 30 * 60 * 1000), endsAt: new Date(NOW + 30 * 60 * 1000) }), NOW, 'Lounge')).toMatchObject({
      when: 'Happening now',
      live: true,
    });
  });

  it('is over when canceled, completed, or past', () => {
    expect(isEventOver(event({ status: 4 }), NOW)).toBe(true);
    expect(isEventOver(event({ status: 3 }), NOW)).toBe(true);
    expect(isEventOver(event({ startsAt: new Date(NOW - 5 * 60 * 60 * 1000), endsAt: new Date(NOW - 4 * 60 * 60 * 1000) }), NOW)).toBe(true);
    expect(isEventOver(event(), NOW)).toBe(false);
  });
});

describe('EventPlanView (the answer)', () => {
  const view = (over: Partial<GuildEventView> = {}, props: Partial<Parameters<typeof EventPlanView>[0]> = {}) => {
    const onToggleRsvp = vi.fn();
    const onSetMaybe = vi.fn();
    render(
      <EventPlanView
        event={event(over)}
        nowMs={NOW}
        channelName="Lounge"
        maybe={false}
        onToggleRsvp={onToggleRsvp}
        onSetMaybe={onSetMaybe}
        {...props}
      />,
    );
    return { onToggleRsvp, onSetMaybe, card: screen.getByRole('group', { name: 'Event: Haz 5 run' }) };
  };

  it('offers “I’m in” as the one cream button, and “Maybe” beside it', () => {
    const { card } = view();
    expect(card.querySelectorAll('.ix-cream')).toHaveLength(1);
    expect(within(card).getByRole('button', { name: 'I’m in' })).toHaveClass('ix-cream');
    expect(within(card).getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'false');
    expect(card.querySelector('.ix-event__meta')).toHaveTextContent('Tonight at 5:00 PM · in Lounge · 3 going');
    // The tile: the short weekday over the day of the month.
    expect(card.querySelector('.ix-event__day')).toHaveTextContent('Thu1');
  });

  it('“I’m in” gives the spot, clearing a Maybe', () => {
    const { card, onToggleRsvp, onSetMaybe } = view({}, { maybe: true });
    fireEvent.click(within(card).getByRole('button', { name: 'I’m in' }));
    expect(onSetMaybe).toHaveBeenCalledWith(false);
    expect(onToggleRsvp).toHaveBeenCalledOnce();
  });

  it('once you are in, “You’re in” is quiet with a check, and pressing it gives the spot back', () => {
    const { card, onToggleRsvp } = view({ youAreGoing: true });
    expect(card.querySelectorAll('.ix-cream')).toHaveLength(0);
    const taken = within(card).getByRole('button', { name: 'You’re in' });
    expect(taken.querySelector('svg')).not.toBeNull();
    fireEvent.click(taken);
    expect(onToggleRsvp).toHaveBeenCalledOnce();
  });

  it('Maybe marks; being a mark on this device, it sends nothing when you were not in', () => {
    const { card, onSetMaybe, onToggleRsvp } = view();
    fireEvent.click(within(card).getByRole('button', { name: 'Maybe' }));
    expect(onSetMaybe).toHaveBeenCalledWith(true);
    expect(onToggleRsvp).not.toHaveBeenCalled();
  });

  it('shows Maybe pressed, with “I’m in” still the cream one', () => {
    const { card, onSetMaybe } = view({}, { maybe: true });
    const maybe = within(card).getByRole('button', { name: 'Maybe' });
    expect(maybe).toHaveAttribute('aria-pressed', 'true');
    expect(maybe.querySelector('svg')).not.toBeNull();
    expect(card.querySelectorAll('.ix-cream')).toHaveLength(1);
    fireEvent.click(maybe);
    expect(onSetMaybe).toHaveBeenCalledWith(false);
  });

  it('Maybe while you are in withdraws the spot: Maybe is not going', () => {
    const { card, onSetMaybe, onToggleRsvp } = view({ youAreGoing: true });
    fireEvent.click(within(card).getByRole('button', { name: 'Maybe' }));
    expect(onSetMaybe).toHaveBeenCalledWith(true);
    expect(onToggleRsvp).toHaveBeenCalledOnce();
  });

  it('going wins over a Maybe left on this device', () => {
    const { card } = view({ youAreGoing: true }, { maybe: true });
    expect(within(card).getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'false');
    expect(card).toHaveAttribute('data-choice', 'in');
  });

  it('cannot be pressed while the answer is on its way', () => {
    const { card } = view({}, { busy: true });
    expect(within(card).getByRole('button', { name: 'I’m in' })).toBeDisabled();
  });

  it('offers no answer for an event that is over, and says when one is canceled', () => {
    const over = view({ startsAt: new Date(NOW - 5 * 60 * 60 * 1000), endsAt: new Date(NOW - 4 * 60 * 60 * 1000) });
    expect(within(over.card).queryByRole('button')).toBeNull();
    expect(over.card).toHaveAttribute('data-tone', 'over');
  });

  it('says it is happening now, in the live ink', () => {
    const { card } = view({ startsAt: new Date(NOW - 30 * 60 * 1000), endsAt: new Date(NOW + 60 * 60 * 1000) });
    expect(card.querySelector('.ix-event__live')).toHaveTextContent('Happening now');
    expect(card).toHaveAttribute('data-tone', 'live');
  });

  it('is struck through and silent when canceled', () => {
    const { card } = view({ status: 4 });
    expect(card).toHaveAttribute('data-tone', 'canceled');
    expect(card.querySelector('.ix-event__meta')).toHaveTextContent(/^Canceled$/);
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('adds no Details unless someone can open them', () => {
    const { card } = view();
    expect(within(card).queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('adds Details when someone can open them, and hands over the event', () => {
    const onOpenDetails = vi.fn();
    const { card } = view({}, { onOpenDetails });
    fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
    expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ id: '7001' }));
  });
});

describe('EventPlanCard (the stores behind the view)', () => {
  it('takes the spot when “I’m in” is pressed', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'I’m in' }));
    expect(mocks.event.toggleRsvp).toHaveBeenCalledOnce();
  });

  it('keeps a Maybe on this device, per account, and it survives the card being drawn again', () => {
    const { unmount } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    expect(Object.keys(useEventMaybeStore.getState().marks)).toEqual([JSON.stringify(['srv', '42', '7001'])]);
    // Nothing went to the server.
    expect(mocks.event.toggleRsvp).not.toHaveBeenCalled();
    unmount();
    show();
    expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    expect(useEventMaybeStore.getState().marks).toEqual({});
  });

  it('reads the channel’s name from the store', () => {
    show();
    expect(screen.getByRole('group', { name: 'Event: Haz 5 run' })).toHaveTextContent('in Lounge');
  });

  it('says so while loading, when it is gone, and when it could not be asked', () => {
    mocks.event = { status: 'loading', event: null, error: null, busy: false, toggleRsvp: vi.fn() };
    const { rerender } = render(<EventPlanCard guildId="g1" eventId="7001" />);
    expect(screen.getByRole('group', { name: 'Event, loading' })).toHaveAttribute('aria-busy', 'true');
    mocks.event = { status: 'missing', event: null, error: null, busy: false, toggleRsvp: vi.fn() };
    rerender(<EventPlanCard guildId="g1" eventId="7001" />);
    expect(screen.getByText('This event is no longer available')).toBeInTheDocument();
    mocks.event = { status: 'error', event: null, error: 'offline', busy: false, toggleRsvp: vi.fn() };
    rerender(<EventPlanCard guildId="g1" eventId="7001" />);
    expect(screen.getByText(/Could not load this event: offline/)).toBeInTheDocument();
  });
});

describe('the Maybe store', () => {
  it('drops a mark a week past its event, the next time one is written', () => {
    const { set } = useEventMaybeStore.getState();
    const day = 24 * 60 * 60 * 1000;
    set('old', at(1, 21).getTime(), true, at(1, 21).getTime());
    expect(Object.keys(useEventMaybeStore.getState().marks)).toEqual(['old']);
    set('new', at(20, 21).getTime(), true, at(20, 21).getTime() - day);
    expect(Object.keys(useEventMaybeStore.getState().marks)).toEqual(['new']);
  });
});
