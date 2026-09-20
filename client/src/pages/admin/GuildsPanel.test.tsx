import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildsPanel } from './GuildsPanel';

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock('../../api/admin', () => ({ adminApi: { getGuilds: mocks.list, updateGuild: mocks.update } }));
vi.mock('../../api/client', () => ({ extractApiError: (error: Error) => error.message }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ data: { guilds: [{ id: '12', name: 'Peer mirror', description: null, owner_id: '0', visibility: 'private', created_at: '2026-09-19T00:00:00Z' }] } });
  mocks.update.mockResolvedValue({ data: {} });
});

describe('operator mirror admission', () => {
  it('preserves private admission when editing only the name', async () => {
    const user = userEvent.setup();
    render(<GuildsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Edit server Peer mirror' }));
    expect(screen.getByRole('combobox', { name: 'Local admission' })).toHaveValue('private');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.update).toHaveBeenCalledWith('12', { name: 'Peer mirror', description: undefined });
  });

  it('sends public admission only after the operator chooses it', async () => {
    const user = userEvent.setup();
    render(<GuildsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Edit server Peer mirror' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Local admission' }), 'public');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.update).toHaveBeenCalledWith('12', { name: 'Peer mirror', description: undefined, visibility: 'public' });
  });
});
