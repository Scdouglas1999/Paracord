import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Mock, describe, expect, it, vi } from 'vitest';
import type { Guild, Member, Role } from '../../types';
import { InvitesSection, OverviewSection, RolesSection } from './GuildSettingsSections';

const guild: Guild = {
  id: 'guild-1',
  name: 'Test Guild',
  owner_id: 'owner-1',
  member_count: 2,
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

const deleteConfirmButton = () => screen.getByRole('button', { name: 'Delete server' });

describe('OverviewSection danger zone', () => {
  it('hides the danger zone for non-owners', () => {
    renderOverview({ authUserId: 'user-2' });
    expect(screen.queryByRole('button', { name: 'Delete space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
  });

  it('opens the delete confirmation dialog from the trigger', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview();
    await user.click(screen.getByRole('button', { name: 'Delete space' }));
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
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled();
  });
});

// ── Roles ────────────────────────────────────────────────────────────────────
//
// The space's default role carries the id of the space itself. It used to be
// filtered out of the list entirely whenever it was the only role — which is
// every brand-new space — and it never got an Edit control even once other
// roles existed. Between the two, the permission bitmask that governs what
// every member of a space may do was unreachable from this screen.

const defaultRole: Role = {
  id: 'guild-1',
  guild_id: 'guild-1',
  name: 'Member',
  color: 0,
  hoist: false,
  position: 1,
  permissions: 104189505,
  mentionable: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const customRole: Role = {
  ...defaultRole,
  id: 'role-2',
  name: 'Moderators',
  position: 2,
  permissions: 8,
};

function renderRoles(overrides: Partial<React.ComponentProps<typeof RolesSection>> = {}) {
  const onStartEditingRole = vi.fn<(role: Role) => void>();
  render(
    <RolesSection
      roles={[defaultRole]}
      canManage
      guildId="guild-1"
      newRoleName=""
      newRoleColor="#5865f2"
      editingRoleId={null}
      editingRolePermissions={0}
      editingRoleColor="#5865f2"
      editingRoleHoist={false}
      editingRoleMentionable={false}
      onNewRoleNameChange={vi.fn()}
      onNewRoleColorChange={vi.fn()}
      onEditingRoleColorChange={vi.fn()}
      onEditingRolePermissionsToggle={vi.fn()}
      onEditingRoleHoistChange={vi.fn()}
      onEditingRoleMentionableChange={vi.fn()}
      onCreateRole={vi.fn()}
      onRenameRole={vi.fn()}
      onStartEditingRole={onStartEditingRole}
      onSaveRoleEdits={vi.fn()}
      onCancelRoleEditing={vi.fn()}
      onDeleteRole={vi.fn()}
      roleColorHex={() => '#99aab5'}
      {...overrides}
    />,
  );
  return { onStartEditingRole };
}

describe('RolesSection', () => {
  it('lists the default role on a space that has no custom roles yet', () => {
    renderRoles();
    expect(screen.getByDisplayValue('Member')).toBeTruthy();
    expect(screen.getByText('Everyone')).toBeTruthy();
    expect(screen.queryByText('No roles yet')).toBeNull();
  });

  it('opens the default role for editing and never offers to delete it', async () => {
    const user = userEvent.setup();
    const { onStartEditingRole } = renderRoles({ roles: [defaultRole, customRole] });

    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    expect(editButtons).toHaveLength(2);
    await user.click(editButtons[0]);
    expect(onStartEditingRole).toHaveBeenCalledWith(defaultRole);

    expect(screen.queryByRole('button', { name: 'Delete role Member' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete role Moderators' })).toBeTruthy();
  });

  it('names the real default role rather than a Discord-ism', () => {
    renderRoles();
    expect(screen.getByText(/Everyone holds Member/)).toBeTruthy();
    expect(screen.queryByText(/@everyone/)).toBeNull();
  });

  it('switches every permission bit the server enforces', () => {
    renderRoles({ roles: [defaultRole], editingRoleId: 'guild-1' });
    // Bits 29, 30, 27, 10 and 16 had no switch at all before.
    for (const label of [
      'Manage Webhooks',
      'Manage Emojis',
      'Manage Nicknames',
      'View Channel',
      'Read Message History',
      'Use External Emojis',
      'Priority Speaker',
      'Move Members',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

// ── Invites ──────────────────────────────────────────────────────────────────
//
// Anyone who can create an invite can open this section, but *listing* a
// space's invites needs Manage Space. That request comes back 403, the settings
// loader swallows it, and the section used to render "No invite links yet" —
// which is false for every ordinary member of every space that has invites.

describe('InvitesSection', () => {
  it('says the list is out of reach rather than claiming it is empty', () => {
    render(
      <InvitesSection
        invites={[]}
        canListInvites={false}
        onCreateInvite={vi.fn()}
        onRevokeInvite={vi.fn()}
      />,
    );
    expect(screen.getByText('Existing links are not yours to see')).toBeTruthy();
    expect(screen.queryByText('No invite links yet')).toBeNull();
    // Making one is still on offer — that is why they can reach this screen.
    expect(screen.getByRole('button', { name: /Make a link/ })).toBeTruthy();
  });

  it('keeps the genuine empty state for someone who can see the list', () => {
    render(
      <InvitesSection
        invites={[]}
        canListInvites
        onCreateInvite={vi.fn()}
        onRevokeInvite={vi.fn()}
      />,
    );
    expect(screen.getByText('No invite links yet')).toBeTruthy();
  });
});
