import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPanel } from './UsersPanel';

const mocks = vi.hoisted(() => ({ users: vi.fn() }));
vi.mock('../../api/admin', () => ({ adminApi: { getUsers: mocks.users } }));
vi.mock('../../api/client', () => ({ extractApiError: (error: Error) => error.message }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: '1001', flags: 1 }) }));

const row = (id: string, username: string, display_name: string | null, flags = 0) => ({
  id,
  username,
  discriminator: 1,
  email: `${username}@example.test`,
  display_name,
  avatar_hash: null,
  flags,
  created_at: '2026-02-03T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.mockResolvedValue({
    data: {
      users: [row('1001', 'sean', 'Sean', 1), row('1002', 'jeremy', 'Jeremy'), row('1003', 'ari', null)],
      total: 3,
      cursor: null,
      next_cursor: null,
      offset: null,
      limit: 25,
    },
  });
});

describe('UsersPanel', () => {
  it('draws each person as a flat tonal Avatar with one letter, never initials on an identity color', async () => {
    const { container } = render(<UsersPanel />);
    await screen.findByText('Jeremy');
    const faces = Array.from(container.querySelectorAll('table .ix-av'));
    expect(faces.map((face) => face.textContent).sort()).toEqual(['A', 'J', 'S']);
    // The Index recipe carries the fill (hue from the id); nothing sets a background inline.
    for (const face of faces) expect(face.getAttribute('style')).not.toMatch(/background/);
  });

  it('says "instance" for the accounts total, and keeps the row actions named', async () => {
    render(<UsersPanel />);
    expect(await screen.findByText(/accounts on this instance, bots included/)).toBeInTheDocument();
    const jeremy = screen.getByText('Jeremy').closest('tr')!;
    expect(within(jeremy).getByRole('button', { name: 'Make admin Jeremy' })).toBeInTheDocument();
    expect(within(jeremy).getByRole('button', { name: 'Delete user Jeremy' })).toBeInTheDocument();
    // You cannot change your own role.
    const you = screen.getByText('Sean').closest('tr')!;
    expect(within(you).getByText('You')).toBeInTheDocument();
  });
});
