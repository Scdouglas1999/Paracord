import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderItem } from '../../../api/reminders';
import { useReminderStore } from '../../../stores/reminderStore';
import { RemindersSheet } from './RemindersSheet';

/**
 * Reminders, from the account menu: due ones first with Done and Snooze, then
 * the upcoming with Change and Cancel; opening one goes to its message.
 */

vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => false }));
vi.mock('../../../lib/reminderNotify', () => ({
  reminderAuthor: (item: ReminderItem) => item.message.author.display_name,
  reminderPreviewLine: vi.fn(async (_scope: unknown, item: ReminderItem) => item.preview ?? ''),
}));
vi.mock('../../message/RemindMeMenu', () => ({ RemindMeMenu: () => null }));

const item = (id: string, remindAt: string, firedAt: string | null, guild: string | null): ReminderItem =>
  ({
    id,
    remind_at: remindAt,
    created_at: '2026-10-01T18:00:00.000Z',
    fired_at: firedAt,
    channel: { id: 'c1', name: 'General', guild_id: guild },
    message: {
      id: `m-${id}`,
      channel_id: 'c1',
      author: { id: 'u2', username: 'brendan', display_name: 'Brendan' },
      content: 'Haz 5 runs from 9.',
    },
    preview: 'Haz 5 runs from 9.',
  }) as unknown as ReminderItem;

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderSheet() {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <RemindersSheet open onClose={onClose} />
      <Probe />
    </MemoryRouter>,
  );
  return { onClose };
}

beforeEach(() => {
  useReminderStore.setState({
    items: [],
    loaded: true,
    loading: false,
    error: null,
    serverId: '__local__',
    load: vi.fn().mockResolvedValue(undefined),
  } as never);
});

describe('RemindersSheet', () => {
  it('is a dialog named Reminders, and says so when there are none', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Reminders' })).toBeInTheDocument();
    expect(screen.getByText('No reminders')).toBeInTheDocument();
  });

  it('lists what is due before what is coming, each with its own decisions', () => {
    useReminderStore.setState({
      items: [
        item('up', '2999-01-01T09:00:00.000Z', null, 'g1'),
        item('due', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z', 'g1'),
      ],
    } as never);
    renderSheet();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Due', 'Upcoming']);
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 1 h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('opens the message a reminder is for, in its server, and closes', async () => {
    const user = userEvent.setup();
    useReminderStore.setState({ items: [item('due', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z', 'g1')] } as never);
    const { onClose } = renderSheet();
    const sheet = screen.getByRole('dialog', { name: 'Reminders' });
    await user.click(within(sheet).getByText('Haz 5 runs from 9.'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1/channels/c1?message=m-due');
  });

  it('opens a reminder from a direct message in the messages', async () => {
    const user = userEvent.setup();
    useReminderStore.setState({ items: [item('dm', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z', null)] } as never);
    renderSheet();
    await user.click(screen.getByText('Haz 5 runs from 9.'));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/dms/c1?message=m-dm');
  });

  it('says why reminders could not be loaded', () => {
    useReminderStore.setState({ error: 'Failed to load reminders: offline' } as never);
    renderSheet();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load reminders: offline');
  });
});
