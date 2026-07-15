import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../../api/dms';
import { DmPickerModal } from './DmPickerModal';
import type { Relationship } from '../../api/relationships';

// Render framer-motion's Modal shell synchronously in jsdom.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        ),
      ),
      button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
        ({ children, ...props }, ref) => (
          <button ref={ref} {...props}>
            {children}
          </button>
        ),
      ),
    },
  };
});

vi.mock('../../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
    createGroup: vi.fn(),
  },
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {} as Record<string, unknown[]>,
  setDmChannels: vi.fn(),
  selectChannel: vi.fn(),
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [] as Relationship[],
  fetchRelationships: vi.fn(),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: typeof mockChannelState) => unknown) =>
    selector(mockChannelState),
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

  it('makes group mode explicit and shows selection progress', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada'), friend('u2', 'Grace')];
    renderPicker();

    await user.click(screen.getByRole('tab', { name: 'Group' }));
    expect(screen.getByRole('tab', { name: 'Group' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Create group conversation' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Ada/i }));
    expect(screen.getByText('1 friend selected')).toBeInTheDocument();
    expect(screen.getByText('2 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group conversation' })).toBeEnabled();
  });

  it('creates a DM on selection, updates the store, fires onCreated and closes', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [friend('u1', 'Ada')];
    const created = { id: 'dm-99', type: 1 };
    vi.mocked(dmApi.create).mockResolvedValue({ data: created } as never);

    const { onClose, onCreated } = renderPicker();

    await user.click(screen.getByText('Ada'));

    await waitFor(() => expect(dmApi.create).toHaveBeenCalledWith('u1'));
    expect(mockChannelState.setDmChannels).toHaveBeenCalledWith([created]);
    expect(mockChannelState.selectChannel).toHaveBeenCalledWith('dm-99');
    expect(onCreated).toHaveBeenCalledWith(created);
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
