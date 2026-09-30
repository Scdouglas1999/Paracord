import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../lib/serverScope';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import type { Member } from '../../types';
import { RoleMentionChip } from './RoleMentionChip';

/**
 * A role mention says who holds the role and who is here now: a Glass face and
 * name for each person present, with how they are here (a dot, a ring, a dot
 * with a bar) and the same in words.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../hooks/useCurrentUser', () => ({ useCurrentAccountScope: () => SCOPE }));
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));
vi.mock('../../lib/permissionDataCache', () => ({
  fetchGuildRoles: vi.fn().mockResolvedValue([
    { id: 'r1', guild_id: 'g1', name: 'Drivers', color: 0x3366ff, hoist: false, position: 1, permissions: '0', managed: false, mentionable: true },
  ]),
}));

function member(id: string, username: string, roles: string[]): Member {
  return {
    user: { id, username, display_name: null, avatar_hash: null } as never,
    roles,
    joined_at: '2026-01-01T00:00:00Z',
    deaf: false,
    mute: false,
  };
}

beforeEach(() => {
  useMemberStore.getState().reset?.();
  usePresenceStore.getState().reset();
  useMemberStore.setState({
    members: new Map([
      [
        entityScopeKey(SCOPE, 'g1'),
        [
          member('1', 'mara', ['r1']),
          member('2', 'tomas', ['r1']),
          member('3', 'ren', ['r1']),
          member('4', 'aisha', []),
        ],
      ],
    ]),
    loading: {},
  });
  usePresenceStore.getState().setPresences(
    [
      { user_id: '1', status: 'online', activities: [] },
      { user_id: '2', status: 'idle', activities: [] },
      { user_id: '4', status: 'online', activities: [] },
    ] as never,
    SCOPE.serverId,
  );
});

describe('RoleMentionChip', () => {
  it('names the role on the chip', async () => {
    render(<RoleMentionChip guildId="g1" roleId="r1" />);
    expect(await screen.findByRole('button', { name: '@Drivers' })).toBeInTheDocument();
  });

  it('lists the holders who are here now, each with a face, a name and how they are here', async () => {
    render(<RoleMentionChip guildId="g1" roleId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: '@Drivers' }));
    const card = await screen.findByRole('dialog', { name: 'Drivers' });
    expect(within(card).getByText('3 members')).toBeInTheDocument();
    expect(within(card).getByText('Here now · 2')).toBeInTheDocument();
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('mara');
    expect(rows[0]).toHaveTextContent('Online');
    expect(rows[0].querySelector('.glass-face')).toHaveTextContent('M');
    expect(rows[1]).toHaveTextContent('tomas');
    expect(rows[1]).toHaveTextContent('Away');
    expect(rows[1].querySelector('.glass-sheet-presence')).toHaveAttribute('data-status', 'idle');
    // Holders who are offline and people without the role are not listed.
    expect(within(card).queryByText('ren')).not.toBeInTheDocument();
    expect(within(card).queryByText('aisha')).not.toBeInTheDocument();
  });

  it('says so when nobody with the role is here', async () => {
    usePresenceStore.getState().reset();
    render(<RoleMentionChip guildId="g1" roleId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: '@Drivers' }));
    expect(await screen.findByText('Nobody with this role is here right now.')).toBeInTheDocument();
  });
});
