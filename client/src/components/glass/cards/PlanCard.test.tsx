import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuildEventResult, GuildEventView } from './useGuildEvent';
import { EventPlanCard } from './EventPlanCard';
import { PlanAction, PlanCard } from './PlanCard';

const mocks = vi.hoisted(() => ({
  event: {
    status: 'ready',
    event: null,
    error: null,
    busy: false,
    toggleRsvp: vi.fn(),
  } as unknown as GuildEventResult,
  me: { id: '42', avatar_hash: null } as { id: string; avatar_hash: null } | null,
  members: [
    { user: { id: '101', username: 'brendan', display_name: 'Brendan', avatar_hash: null }, nick: null, roles: [] },
  ],
  channels: { '2002': { id: '2002', name: 'Lounge', type: 2 } } as Record<string, { id: string; name: string; type: number }>,
}));

vi.mock('./useGuildEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useGuildEvent')>()),
  useGuildEvent: () => mocks.event,
}));
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.me,
  useCurrentAccountScope: () => ({ serverId: 'srv', userId: '42' }),
}));
vi.mock('../../../hooks/useChannels', () => ({
  useCurrentChannelStore: (selector: (view: { channelsById: typeof mocks.channels }) => unknown) =>
    selector({ channelsById: mocks.channels }),
}));
vi.mock('../../../stores/memberStore', () => ({
  useMemberStore: (selector: (state: { members: Map<string, unknown> }) => unknown) =>
    selector({ members: new Map([[JSON.stringify(['srv', '42', 'g1']), mocks.members]]) }),
}));
vi.mock('../../../lib/serverScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/serverScope')>()),
  entityScopeKey: (scope: { serverId: string; userId: string }, id: string) => JSON.stringify([scope.serverId, scope.userId, id]),
}));

const soon = () => new Date(Date.now() + 3 * 60 * 60 * 1000);

const event = (over: Partial<GuildEventView> = {}): GuildEventView => ({
  id: '7001',
  guildId: 'g1',
  name: 'Haz 5 run',
  startsAt: soon(),
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
  mocks.me = { id: '42', avatar_hash: null };
  // The time line reads the wall clock ("Today at", "Tonight at", "Tomorrow at"):
  // pin it to the afternoon so an event three hours out is always today.
  // Only Date is faked; timers stay real for Testing Library.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 30, 14, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlanCard', () => {
  it('is a titled group with the time line, the decision and the slots', () => {
    render(
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
    expect(within(card).getByText('Tonight at 9:30 PM in Lounge')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Take the spot' })).toBeInTheDocument();
    expect(card.querySelectorAll('.glass-plan__slot')).toHaveLength(3);
    // An open slot is the dashed circle, not a face.
    expect(card.querySelector('[data-open] .glass-plan__open')).not.toBeNull();
  });

  it('keeps every slot’s name for assistive tech, since the visible names hide when the card is narrow', () => {
    render(<PlanCard title="Plan" slots={[{ key: 'l', name: 'Luke', detail: '10 min', face: { userId: '102' } }]} />);
    expect(screen.getByText('Luke, 10 min')).toHaveClass('sr-only');
    // The visible copy is decoration for the same words.
    expect(document.querySelector('.glass-plan__name')).toHaveAttribute('aria-hidden', 'true');
  });

  it('joins the top corner only when it follows a bubble of its group', () => {
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

describe('EventPlanCard', () => {
  it('shows the event: name, when and where, the host, and your spot open', () => {
    show();
    const card = screen.getByRole('group', { name: 'Event: Haz 5 run' });
    expect(card).toHaveTextContent(/Tonight at|Today at/);
    expect(card).toHaveTextContent('in Lounge');
    expect(card).toHaveTextContent('3 going');
    expect(within(card).getByText('Brendan, Host')).toBeInTheDocument();
    expect(within(card).getAllByText('Your spot')).toHaveLength(2);
    expect(card.querySelector('[data-open]')).not.toBeNull();
  });

  it('takes the spot when the decision is pressed', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Take the spot' }));
    expect(mocks.event.toggleRsvp).toHaveBeenCalledOnce();
  });

  it('puts you in a slot, ringed, once you are in', () => {
    show({ youAreGoing: true });
    const card = screen.getByRole('group', { name: 'Event: Haz 5 run' });
    expect(within(card).getByRole('button', { name: 'You’re in' })).toBeInTheDocument();
    expect(card.querySelector('[data-you]')).not.toBeNull();
    expect(card.querySelector('[data-open]')).toBeNull();
  });

  it('is you in the host’s slot when you are the host', () => {
    show({ creatorId: '42' });
    const card = screen.getByRole('group', { name: 'Event: Haz 5 run' });
    expect(within(card).getByText('You, Host')).toBeInTheDocument();
    expect(within(card).queryByText('Brendan, Host')).toBeNull();
  });

  it('offers no spot in an event that is over', () => {
    show({ startsAt: new Date(Date.now() - 5 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 4 * 60 * 60 * 1000) });
    expect(screen.queryByRole('button', { name: /spot|in/i })).toBeNull();
  });

  it('says when it is canceled', () => {
    show({ status: 4 });
    expect(screen.getByRole('group', { name: 'Event: Haz 5 run' })).toHaveTextContent('Canceled');
    expect(screen.queryByRole('button', { name: 'Take the spot' })).toBeNull();
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
