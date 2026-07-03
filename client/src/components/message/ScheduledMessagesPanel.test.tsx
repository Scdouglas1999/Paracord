import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi, type ScheduledMessage } from '../../api/channels';
import { ScheduledMessagesPanel } from './ScheduledMessagesPanel';

const editScheduledMessage = vi.hoisted(() => vi.fn());

vi.mock('../../api/channels', () => ({
  channelApi: {
    listScheduledMessages: vi.fn(),
    deleteScheduledMessage: vi.fn(),
  },
}));

vi.mock('../../stores/messageStore', () => ({
  useMessageStore: { getState: vi.fn(() => ({ editScheduledMessage })) },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../stores/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../api/client', () => ({
  extractApiError: vi.fn(() => 'request failed'),
}));

vi.mock('../../hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }));

function makeItem(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 'sched-1',
    channel_id: 'chan-1',
    author_id: 'user-1',
    content: 'Hello later',
    send_at: '2999-01-01T10:00:00.000Z',
    status: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScheduledMessagesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editScheduledMessage.mockResolvedValue(undefined);
    vi.mocked(channelApi.listScheduledMessages).mockResolvedValue({
      data: [makeItem()],
    } as never);
  });

  it('lists pending scheduled messages on open', async () => {
    render(<ScheduledMessagesPanel channelId="chan-1" onClose={() => {}} />);
    expect(channelApi.listScheduledMessages).toHaveBeenCalledWith('chan-1');
    expect(await screen.findByText('Hello later')).toBeInTheDocument();
  });

  it('edits and reschedules a message, calling editScheduledMessage with the new send_at', async () => {
    const user = userEvent.setup();
    render(<ScheduledMessagesPanel channelId="chan-1" onClose={() => {}} />);

    await user.click(await screen.findByLabelText('Edit scheduled message'));

    const contentBox = screen.getByLabelText('Scheduled message content');
    await user.clear(contentBox);
    await user.type(contentBox, 'Rescheduled body');

    const sendAt = screen.getByLabelText('Scheduled send time') as HTMLInputElement;
    await user.clear(sendAt);
    await user.type(sendAt, '2999-06-15T14:30');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editScheduledMessage).toHaveBeenCalledTimes(1));
    const [channelId, id, content, sendAtIso] = editScheduledMessage.mock.calls[0];
    expect(channelId).toBe('chan-1');
    expect(id).toBe('sched-1');
    expect(content).toBe('Rescheduled body');
    expect(sendAtIso).toBe(new Date('2999-06-15T14:30').toISOString());
  });
});
