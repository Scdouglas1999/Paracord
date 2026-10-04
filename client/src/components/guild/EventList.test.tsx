import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EventList, defaultEventWindow } from './EventList';
import { apiClient } from '../../api/client';
import { toast } from '../../stores/toastStore';

const mockState = vi.hoisted(() => ({
  canManageEvents: true,
}));

vi.mock('../../api/client', () => ({
  apiClient: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
  extractApiError: vi.fn((err: { response?: { data?: { error?: string; message?: string } } }) =>
    err?.response?.data?.message || err?.response?.data?.error || 'request failed',
  ),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: 0n,
    isAdmin: mockState.canManageEvents,
    isOwner: mockState.canManageEvents,
    isLoading: false,
  }),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('../../stores/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

const scheduledEvent = {
  id: 'event-1',
  guild_id: 'guild-1',
  channel_id: 'channel-1',
  event_channel_id: null,
  creator_id: 'user-1',
  name: 'Release Planning',
  description: 'Plan the public release.',
  scheduled_start: '2026-06-01T16:00:00.000Z',
  scheduled_end: null,
  recurrence_rule: 'weekly',
  reminder_minutes: 30,
  event_channel_created: false,
  reminder_sent_at: null,
  status: 1,
  entity_type: 2,
  location: 'Online',
  image_url: null,
  user_count: 2,
  user_rsvp: false,
  created_at: '2026-05-01T00:00:00.000Z',
};

const getMock = vi.mocked(apiClient.get);
const putMock = vi.mocked(apiClient.put);
const patchMock = vi.mocked(apiClient.patch);
const deleteMock = vi.mocked(apiClient.delete);
const openMock = vi.fn();

describe('EventList', () => {
  beforeEach(() => {
    mockState.canManageEvents = true;
    vi.clearAllMocks();
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: openMock,
      writable: true,
    });
    getMock.mockResolvedValue({ data: [scheduledEvent] });
    putMock.mockResolvedValue({ data: null });
    patchMock.mockResolvedValue({
      data: { ...scheduledEvent, status: 2 },
    });
    deleteMock.mockResolvedValue({ data: null });
  });

  afterEach(() => {
    openMock.mockReset();
  });

  it('shows scheduled event management actions to event managers', async () => {
    render(<EventList guildId="guild-1" />);

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ical$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^start$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();

    patchMock.mockResolvedValueOnce({
      data: { ...scheduledEvent, name: 'Release Postmortem' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText(/event name/i), {
      target: { value: 'Release Postmortem' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText(/location/i), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText(/repeat/i), {
      target: { value: 'none' },
    });
    fireEvent.change(screen.getByLabelText(/reminder/i), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/guilds/guild-1/events/event-1',
        expect.objectContaining({
          name: 'Release Postmortem',
          description: null,
          entity_type: 2,
          location: null,
          recurrence_rule: null,
          reminder_minutes: null,
        }),
      );
    });

    patchMock.mockResolvedValueOnce({
      data: { ...scheduledEvent, status: 2 },
    });

    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/guilds/guild-1/events/event-1', {
        status: 2,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/guilds/guild-1/events/event-1');
    });
  });

  it('hides management actions from regular members while preserving RSVP', async () => {
    mockState.canManageEvents = false;

    render(<EventList guildId="guild-1" />);

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /i.m in/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/guilds/guild-1/events/event-1/rsvp');
    });
    expect(await screen.findByText('3 interested')).toBeInTheDocument();
  });

  it('encodes calendar export path segments before opening same-origin URLs', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        {
          ...scheduledEvent,
          id: 'event/1?download=1',
        },
      ],
    });

    render(<EventList guildId="guild/1?next=https://evil.test" />);

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(openMock).toHaveBeenCalledWith(
      '/api/v1/guilds/guild%2F1%3Fnext%3Dhttps%3A%2F%2Fevil.test/events.ics',
      '_blank',
      'noopener,noreferrer',
    );

    fireEvent.click(screen.getByRole('button', { name: /^ical$/i }));
    expect(openMock).toHaveBeenLastCalledWith(
      '/api/v1/guilds/guild%2F1%3Fnext%3Dhttps%3A%2F%2Fevil.test/events/event%2F1%3Fdownload%3D1/ical',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('does not render unsafe event cover URLs', async () => {
    getMock.mockResolvedValueOnce({
      data: [{ ...scheduledEvent, image_url: 'javascript:alert(1)' }],
    });

    const { container } = render(<EventList guildId="guild-1" />);

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('shows a retryable load error with API details instead of an empty event list', async () => {
    getMock.mockRejectedValueOnce({
      response: { data: { message: 'Calendar database is offline.' } },
    });

    render(<EventList guildId="guild-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load events: Calendar database is offline.',
    );
    expect(screen.queryByText('No events yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();
  });

  it('shows API details when event actions fail', async () => {
    putMock.mockRejectedValueOnce({
      response: { data: { message: 'RSVPs are closed.' } },
    });
    patchMock.mockRejectedValueOnce({
      response: { data: { message: 'Event already started.' } },
    });
    getMock.mockResolvedValueOnce({ data: [scheduledEvent] });

    render(<EventList guildId="guild-1" />);

    expect(await screen.findByText('Release Planning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /i.m in/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update RSVP: RSVPs are closed.');
    });

    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update event: Event already started.');
    });
  });
});

describe('EventList on the Events page', () => {
  beforeEach(() => {
    mockState.canManageEvents = true;
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: [scheduledEvent, { ...scheduledEvent, id: 'event-2', name: 'Retro', status: 2, user_rsvp: true, scheduled_start: '2026-05-30T16:00:00.000Z' }, { ...scheduledEvent, id: 'event-3', name: 'Old news', status: 3 }] });
    putMock.mockResolvedValue({ data: null });
    deleteMock.mockResolvedValue({ data: null });
  });

  it('leaves its heading to the page, reports how many are coming, and keeps the actions', async () => {
    const onUpcomingCount = vi.fn();
    render(<EventList guildId="guild-1" variant="page" onUpcomingCount={onUpcomingCount} />);
    expect(await screen.findByText('Release Planning')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Events' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new event/i })).toHaveClass('ix-cream');
    expect(screen.getByRole('button', { name: /^export$/i })).toBeInTheDocument();
    // Scheduled and active are still to come; the completed one is not.
    await waitFor(() => expect(onUpcomingCount).toHaveBeenLastCalledWith(2));
  });

  it('brings its own heading in Server settings, where no page has a title', async () => {
    render(<EventList guildId="guild-1" />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Events' })).toBeInTheDocument();
    expect(screen.getByText(/events are/)).toHaveTextContent('2');
  });

  it('is I’m in (cream) until you are, then a pressed You’re in; a past event has neither', async () => {
    render(<EventList guildId="guild-1" variant="page" />);
    const planning = await screen.findByRole('article', { name: 'Event: Release Planning' });
    expect(within(planning).getByRole('button', { name: /i.m in/i })).toHaveClass('ix-cream');
    const retro = screen.getByRole('article', { name: 'Event: Retro' });
    const mine = within(retro).getByRole('button', { name: /you.re in/i });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(mine).not.toHaveClass('ix-cream');
    const old = screen.getByRole('article', { name: 'Event: Old news' });
    expect(within(old).queryByRole('button', { name: /i.m in|you.re in/i })).toBeNull();
    fireEvent.click(within(retro).getByRole('button', { name: /you.re in/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/guilds/guild-1/events/event-2/rsvp'));
  });

  it('says the state in words, not only by color, and marks the live and the over', async () => {
    render(<EventList guildId="guild-1" variant="page" />);
    const retro = await screen.findByRole('article', { name: 'Event: Retro' });
    expect(retro).toHaveAttribute('data-tone', 'live');
    expect(retro).toHaveTextContent('Active');
    expect(retro).toHaveTextContent('Happening now');
    const old = screen.getByRole('article', { name: 'Event: Old news' });
    expect(old).toHaveAttribute('data-tone', 'over');
    expect(old).toHaveTextContent('Completed');
  });

  it('offers a manager the first event on an empty calendar, and a member only the words', async () => {
    getMock.mockResolvedValue({ data: [] });
    const { unmount } = render(<EventList guildId="guild-1" variant="page" />);
    expect(await screen.findByText('No events on the calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create event' })).toHaveClass('ix-cream');
    unmount();
    mockState.canManageEvents = false;
    render(<EventList guildId="guild-1" variant="page" />);
    expect(await screen.findByText('No events on the calendar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create event' })).toBeNull();
    expect(screen.getByText(/organizers will post events here/)).toBeInTheDocument();
  });
});

describe('defaultEventWindow', () => {
  it('opens a new event on the next round hour, an hour long', () => {
    // Local wall-clock, because that is what a datetime-local input speaks.
    const now = new Date(2026, 5, 1, 14, 37, 12);
    const { start, end } = defaultEventWindow(now);
    expect(start).toBe('2026-06-01T15:00');
    expect(end).toBe('2026-06-01T16:00');
  });

  it('rolls over midnight rather than producing an hour of 24', () => {
    const { start, end } = defaultEventWindow(new Date(2026, 5, 1, 23, 5));
    expect(start).toBe('2026-06-02T00:00');
    expect(end).toBe('2026-06-02T01:00');
  });
});
