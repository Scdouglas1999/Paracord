import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/reminders', () => ({
  remindersApi: { list: vi.fn(), put: vi.fn(), remove: vi.fn() },
}));

import { remindersApi } from '../api/reminders';
import { ApiContractError } from '../api/responseContracts';
import { useReminderStore } from './reminderStore';

describe('reminder store', () => {
  beforeEach(() => {
    useReminderStore.getState().reset();
    vi.mocked(remindersApi.list).mockReset();
  });

  it('keeps a list it cannot read out of the store and says so', async () => {
    vi.mocked(remindersApi.list).mockRejectedValue(new ApiContractError('reminder list'));
    await useReminderStore.getState().load();
    const state = useReminderStore.getState();
    expect(state.items).toEqual([]);
    expect(state.loaded).toBe(false);
    expect(state.error).toBe('Failed to load reminders: The server returned an invalid reminder list response. Update the server and try again.');
  });

  it('stores a list the server sends', async () => {
    vi.mocked(remindersApi.list).mockResolvedValue({ data: { items: [] } } as never);
    await useReminderStore.getState().load();
    const state = useReminderStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
  });
});
