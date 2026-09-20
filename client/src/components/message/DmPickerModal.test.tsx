import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../../api/dms';
import { DmPickerModal } from './DmPickerModal';
import type { Relationship } from '../../api/relationships';

// Render the Modal shell synchronously in jsdom (no presence hold).

vi.mock('../../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
    createGroup: vi.fn(),
  },
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {} as Record<string, unknown[]>,
  setDmChannels: vi.fn(),
  createDm: vi.fn(),
  createGroupDm: vi.fn(),
  selectChannel: vi.fn(),
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [] as Relationship[],
  fetchRelationships: vi.fn(),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: Object.assign((selector: (state: typeof mockChannelState) => unknown) => selector(mockChannelState), { getState: () => mockChannelState }),
}));

vi.mock('../../stores/relationshipStore', () => ({
  useRelationshipStore: (selector: (state: typeof mockRelationshipState) => unknown) =>
    selector(mockRelationshipState),
}));

function friend(id: string, username: string): Relationship {
  return {
    id: `rel-${id}`,
    type: 1,
    // Minimal User shape sufficient for the picker.
    user: { id, username } as Relationship['user'],
  };
}

function renderPicker(props?: Partial<React.ComponentProps<typeof DmPickerModal>>) {
  const onClose = props?.onClose ?? vi.fn();
  const onCreated = props?.onCreated ?? vi.fn();
  render(
    <MemoryRouter>
      <DmPickerModal open onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

describe('DmPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelState.createDm.mockImplementation(async (id, scope) => {
      const { data } = await dmApi.create(id);
      return { ...data, scope, key: JSON.stringify([scope.serverId, scope.userId, data.id]) };
    });
    mockChannelState.channelsByGuild = {};
    mockRelationshipState.relationships = [];
    mockRelationshipState.fetchRelationships.mockResolvedValue(undefined);
  });

  it('refreshes and renders only eligible (friend-type) relationships', async () => {
    mockRelationshipState.relationships = [
      friend('u1', 'Ada'),
      friend('u2', 'Grace'),
      { id: 'rel-blocked', type: 2, user: { id: 'u3', username: 'Blocked' } as Relationship['user'] },
      { id: 'rel-pending', type: 3, user: { id: 'u4', username: 'Pending' } as Relationship['user'] },
    ];

    renderPicker();

    expect(mockRelationshipState.fetchRelationships).toHaveBeenCalled();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Direct' })).toHaveAttribute('aria-selected', 'true');
  });

  it('filters friends and explains an empty search result', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada'), friend('u2', 'Grace')];
    renderPicker();

    await user.type(screen.getByRole('searchbox', { name: 'Search friends' }), 'gra');
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search friends' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search friends' }), 'nobody');
    expect(screen.getByText('No friends found')).toBeInTheDocument();
  });

  it('creates a group from the selected friends', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada'), friend('u2', 'Grace')];
    const created = { id: 'gd-7', type: 3 };
    mockChannelState.createGroupDm.mockImplementation(async (ids, name, scope) =>
      ({ ...created, recipient_ids: ids, name, scope, key: JSON.stringify([scope.serverId, scope.userId, created.id]) }));
    const { onCreated, onClose } = renderPicker();

    await user.click(screen.getByRole('tab', { name: 'Group' }));
    expect(screen.getByRole('tab', { name: 'Group' })).toHaveAttribute('aria-selected', 'true');
    // Selecting is not sending: the button stays refused until somebody is in
    // the group, and the count says who will be.
    expect(screen.getByRole('button', { name: 'Create group conversation' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Ada/i }));
    await user.click(screen.getByRole('button', { name: /Grace/i }));
    expect(screen.getByText('2 friends selected')).toBeInTheDocument();
    expect(screen.getByText('3 total')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Three of us');
    await user.click(screen.getByRole('button', { name: 'Create group conversation' }));

    expect(mockChannelState.createGroupDm).toHaveBeenCalledWith(['u1', 'u2'], 'Three of us',
      { serverId: '__local__', userId: 'me' });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'gd-7' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a DM on selection, updates the store, fires onCreated and closes', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada')];
    const created = { id: 'dm-99', type: 1 };
    vi.mocked(dmApi.create).mockResolvedValue({ data: created } as never);

    const { onClose, onCreated } = renderPicker();

    await user.click(screen.getByText('Ada'));

    await waitFor(() => expect(dmApi.create).toHaveBeenCalledWith('u1'));
    expect(mockChannelState.createDm).toHaveBeenCalledWith('u1', { serverId: '__local__', userId: 'me' });
    expect(mockChannelState.selectChannel).toHaveBeenCalledWith('dm-99');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining(created));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an empty state when the viewer has no friends', () => {
    mockRelationshipState.relationships = [];
    renderPicker();
    expect(screen.getByText('No friends to message yet')).toBeInTheDocument();
    expect(dmApi.create).not.toHaveBeenCalled();
  });

  it('surfaces an error and keeps the dialog open when creation fails', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada')];
    vi.mocked(dmApi.create).mockRejectedValue(new Error('nope'));

    const { onClose } = renderPicker();

    await user.click(screen.getByText('Ada'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});

vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});

vi.mock('../../lib/channelNavigation', () => ({ activateChannel: (channel: { id: string }) => mockChannelState.selectChannel(channel.id) }));

vi.mock('../../hooks/useCurrentUser', () => ({ useCurrentAccountScope: () => ({ serverId: '__local__', userId: 'me' }) }));
