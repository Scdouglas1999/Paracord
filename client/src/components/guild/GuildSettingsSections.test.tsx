import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Mock, describe, expect, it, vi } from 'vitest';
import type { Guild, Member, Role } from '../../types';
import { ACTION_LABELS, InvitesSection, OverviewSection, RolesSection, inviteExpiryLabel } from './GuildSettingsSections';

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

const deleteConfirmButton = () => screen.getByRole('button', { name: 'Delete permanently' });

describe('OverviewSection danger zone', () => {
  it('hides the danger zone for non-owners', () => {
    renderOverview({ authUserId: 'user-2' });
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
  });

  it('opens the delete confirmation dialog from the trigger', async () => {
    const user = userEvent.setup();
    const handlers = renderOverview();
    await user.click(screen.getByRole('button', { name: 'Delete server' }));
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
      editingRolePermissions={0n}
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
  it('lists the default role on a server that has no custom roles yet', () => {
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

  it('keeps the row actions visible where there is no hover', () => {
    // `opacity-0 ... group-hover:opacity-100` with no breakpoint prefix means a
    // touch device never reveals Edit or Delete at all: there is no hover to
    // give. The invites row already guards this with `sm:`; the role, member,
    // emoji, bot and ban rows did not.
    renderRoles({ roles: [defaultRole, customRole] });
    const actions = screen
      .getByRole('button', { name: 'Delete role Moderators' })
      .closest('div');
    expect(actions).not.toBeNull();
    const className = actions!.className;
    expect(className).toContain('sm:opacity-0');
    expect(className.split(/\s+/)).not.toContain('opacity-0');
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

// ── Audit log ────────────────────────────────────────────────────────────────

describe('audit log action labels', () => {
  it('names every action type the server writes', () => {
    // The server's `ACTION_*` constants are the whole vocabulary. Eight of them
    // had no label, so a log of webhook, emoji and AutoMod activity read as
    // "Action 50" / "Action 60" / "Action 100" — and since the filter dropdown
    // is built from this map, those entries could not be filtered for either.
    const serverActions = [
      1, 10, 11, 12, 20, 21, 22, 23, 30, 31, 32, 40, 41, 50, 51, 52, 60, 61, 62, 71, 72, 73, 80,
      81, 90, 91, 100, 101, 102, 103,
    ];
    const unlabeled = serverActions.filter((code) => !ACTION_LABELS[code]);
    expect(unlabeled).toEqual([]);
    // And nothing here that the server never emits.
    expect(Object.keys(ACTION_LABELS).map(Number).sort((a, b) => a - b)).toEqual(serverActions);
  });
});

describe('inviteExpiryLabel', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const now = Date.parse(created);

  it('says never when the link has no lifespan', () => {
    expect(inviteExpiryLabel({ max_age: 0, created_at: created }, now)).toBe('never');
    expect(inviteExpiryLabel({ max_age: null, created_at: created }, now)).toBe('never');
  });

  it('says when the link dies, never the raw second count', () => {
    // The bug this covers: "Expires 86400" under a column headed Expires.
    expect(inviteExpiryLabel({ max_age: 86400, created_at: created }, now)).toBe('in 1 day');
    expect(inviteExpiryLabel({ max_age: 604800, created_at: created }, now)).toBe('in 7 days');
    expect(inviteExpiryLabel({ max_age: 3600, created_at: created }, now)).toBe('in 1 hour');
    expect(inviteExpiryLabel({ max_age: 1800, created_at: created }, now)).toBe('in 30 minutes');
  });

  it('counts down from when the link was made', () => {
    const halfADayLater = now + 12 * 3600 * 1000;
    expect(inviteExpiryLabel({ max_age: 86400, created_at: created }, halfADayLater)).toBe('in 12 hours');
    expect(inviteExpiryLabel({ max_age: 86400, created_at: created }, now + 86400 * 1000)).toBe('expired');
  });
});
