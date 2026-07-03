import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Mock, describe, expect, it, vi } from 'vitest';
import type { Guild, Member } from '../../types';
import { OverviewSection } from './GuildSettingsSections';

const guild: Guild = {
  id: 'guild-1',
  name: 'Test Guild',
  owner_id: 'owner-1',
  member_count: 2,
  features: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

const candidate: Member = {
  user: {
    id: 'user-2',
    username: 'Grace',
    discriminator: 2,
    bot: false,
    system: false,
    flags: 0,
    created_at: '2026-01-01T00:00:00.000Z',
  },
  roles: [],
  joined_at: '2026-01-01T00:00:00.000Z',
  deaf: false,
  mute: false,
};

type Handlers = {
  onDeleteGuild: Mock<() => void>;
  onHideDeleteDialog: Mock<() => void>;
  onShowDeleteDialog: Mock<() => void>;
  onTransferOwnership: Mock<() => void>;
};

function renderOverview(
  overrides: Partial<React.ComponentProps<typeof OverviewSection>> = {},
): Handlers {
  const handlers: Handlers = {
    onDeleteGuild: vi.fn<() => void>(),
    onHideDeleteDialog: vi.fn<() => void>(),
    onShowDeleteDialog: vi.fn<() => void>(),
    onTransferOwnership: vi.fn<() => void>(),
  };
  render(
    <OverviewSection
      guild={guild}
      // authUserId matches guild.owner_id so the owner-only Danger Zone renders.
      authUserId="owner-1"
      name="Test Guild"
      description=""
      vanityCode=""
      savingVanity={false}
      iconDataUrl={null}
      ownershipTargetUserId="user-2"
      ownershipCandidates={[candidate]}
      transferringOwnership={false}
      members={[candidate]}
      roles={[]}
      channels={[]}
      invites={[]}
      showDeleteGuildDialog={false}
      deleteGuildConfirmName=""
      deletingGuild={false}
      onNameChange={vi.fn()}
      onDescriptionChange={vi.fn()}
      onVanityCodeChange={vi.fn()}
      onIconChange={vi.fn()}
      onOwnershipTargetChange={vi.fn()}
      onDeleteGuildConfirmNameChange={vi.fn()}
      onSave={vi.fn()}
      onSaveVanity={vi.fn()}
      onLeave={vi.fn()}
      onTransferOwnership={handlers.onTransferOwnership}
      onShowDeleteDialog={handlers.onShowDeleteDialog}
      onHideDeleteDialog={handlers.onHideDeleteDialog}
      onDeleteGuild={handlers.onDeleteGuild}
      {...overrides}
    />,
  );
  return handlers;
}

// The dialog's confirm button and the trigger button both read "Delete Server";
// the trigger renders first in the DOM, the dialog confirm second.
const deleteConfirmButton = () => screen.getAllByRole('button', { name: 'Delete Server' })[1];

describe('OverviewSection danger zone', () => {
  it('hides the danger zone for non-owners', () => {
    renderOverview({ authUserId: 'user-2' });
    expect(screen.queryByRole('button', { name: 'Delete Server' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
  });

  it('opens the delete confirmation dialog from the trigger', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview();
    await user.click(screen.getByRole('button', { name: 'Delete Server' }));
    expect(handlers.onShowDeleteDialog).toHaveBeenCalledTimes(1);
    expect(handlers.onDeleteGuild).not.toHaveBeenCalled();
  });

  it('gates deletion until the confirmation name matches', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview({
      showDeleteGuildDialog: true,
      deleteGuildConfirmName: 'Wrong Name',
    });
    const confirmBtn = deleteConfirmButton();
    expect(confirmBtn).toBeDisabled();
    await user.click(confirmBtn);
    expect(handlers.onDeleteGuild).not.toHaveBeenCalled();
  });

  it('confirms deletion once the name matches exactly', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview({
      showDeleteGuildDialog: true,
      deleteGuildConfirmName: 'Test Guild',
    });
    const confirmBtn = deleteConfirmButton();
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);
    expect(handlers.onDeleteGuild).toHaveBeenCalledTimes(1);
  });

  it('cancel dismisses the dialog without deleting', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview({
      showDeleteGuildDialog: true,
      deleteGuildConfirmName: 'Test Guild',
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onHideDeleteDialog).toHaveBeenCalledTimes(1);
    expect(handlers.onDeleteGuild).not.toHaveBeenCalled();
  });
});

describe('OverviewSection ownership transfer', () => {
  it('gates transfer until a target member is selected', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview({ ownershipTargetUserId: '' });
    const transferBtn = screen.getByRole('button', { name: 'Transfer' });
    expect(transferBtn).toBeDisabled();
    await user.click(transferBtn);
    expect(handlers.onTransferOwnership).not.toHaveBeenCalled();
  });

  it('transfers to the selected member on confirm', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview();
    const transferBtn = screen.getByRole('button', { name: 'Transfer' });
    expect(transferBtn).toBeEnabled();
    await user.click(transferBtn);
    expect(handlers.onTransferOwnership).toHaveBeenCalledTimes(1);
  });

  it('disables the transfer button while a transfer is in flight', () => {
    renderOverview({ transferringOwnership: true });
    expect(screen.getByRole('button', { name: 'Transferring...' })).toBeDisabled();
  });
});
