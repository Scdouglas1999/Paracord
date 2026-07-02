import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { Bot, Gavel, GripVertical, Link, MessageSquare, ScrollText, Shield, Smile, Trash2, Upload } from 'lucide-react';
import type { AuditLogEntry, Ban, Channel, Guild, GuildEmoji, Invite, Member, ModerationReport, Role, Webhook } from '../../types';
import type { BotApplication, GuildBotEntry } from '../../api/bots';
import type { ApplyModerationTemplateRequest, ModerationTemplate } from '../../api/moderationTemplates';
import { ACTION_TYPE_LABELS } from '../../api/moderationTemplates';
import { Button } from '../ui/Button';
import { buildGuildEmojiImageUrl } from '../../lib/customEmoji';

export type ReportStatusFilter =
  | 'all'
  | 'open'
  | 'dismissed'
  | 'warned'
  | 'muted'
  | 'banned'
  | 'approved'
  | 'rejected';

type ReportResolutionAction = 'approve' | 'reject' | 'dismiss' | 'warn' | 'mute' | 'ban';

// ---------------------------------------------------------------------------
// OverviewSection
// ---------------------------------------------------------------------------

interface OverviewSectionProps {
  guild: Guild | null;
  authUserId: string | undefined;
  name: string;
  description: string;
  vanityCode: string;
  savingVanity: boolean;
  iconDataUrl: string | null;
  ownershipTargetUserId: string;
  ownershipCandidates: Member[];
  transferringOwnership: boolean;
  members: Member[];
  roles: Role[];
  channels: Channel[];
  invites: Invite[];
  showDeleteGuildDialog: boolean;
  deleteGuildConfirmName: string;
  deletingGuild: boolean;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onVanityCodeChange: (code: string) => void;
  onIconChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onOwnershipTargetChange: (userId: string) => void;
  onDeleteGuildConfirmNameChange: (name: string) => void;
  onSave: () => void;
  onSaveVanity: () => void;
  onLeave: () => void;
  onTransferOwnership: () => void;
  onShowDeleteDialog: () => void;
  onHideDeleteDialog: () => void;
  onDeleteGuild: () => void;
}

export function OverviewSection({
  guild,
  authUserId,
  name,
  description,
  vanityCode,
  savingVanity,
  iconDataUrl,
  ownershipTargetUserId,
  ownershipCandidates,
  transferringOwnership,
  members,
  roles,
  channels,
  invites,
  showDeleteGuildDialog,
  deleteGuildConfirmName,
  deletingGuild,
  onNameChange,
  onDescriptionChange,
  onVanityCodeChange,
  onIconChange,
  onOwnershipTargetChange,
  onDeleteGuildConfirmNameChange,
  onSave,
  onSaveVanity,
  onLeave,
  onTransferOwnership,
  onShowDeleteDialog,
  onHideDeleteDialog,
  onDeleteGuild,
}: OverviewSectionProps) {
  const isOwner = guild && authUserId && guild.owner_id === authUserId;

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
      <h2 className="settings-section-title !mb-0">Server Overview</h2>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <div className="flex-shrink-0">
          <label className="cursor-pointer">
            <input type="file" accept="image/*" className="hidden" onChange={onIconChange} />
            <div
              className="w-24 h-24 rounded-full flex flex-col items-center justify-center border-2 border-dashed transition-colors hover:border-[var(--interactive-normal)]"
              style={{ borderColor: 'var(--interactive-muted)', backgroundColor: 'var(--bg-secondary)' }}
            >
              {iconDataUrl ? (
                <img src={iconDataUrl} alt="Server icon" className="w-full h-full rounded-full object-cover" />
              ) : (
                <>
                  <Upload size={20} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[10px] mt-1 font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>
                    Upload
                  </span>
                </>
              )}
            </div>
          </label>
        </div>
        <div className="flex-1 card-stack-relaxed">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Server Name</span>
            <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)} className="input-field mt-3" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Description</span>
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={3}
              className="input-field mt-3 resize-none"
              placeholder="Describe your server"
            />
          </label>
        </div>
      </div>
      <div className="settings-action-row">
        <Button onClick={onSave}>Save Changes</Button>
        {guild && authUserId && guild.owner_id !== authUserId && (
          <button className="btn-ghost" onClick={onLeave}>
            Leave Server
          </button>
        )}
      </div>
      <div className="grid gap-7 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card-surface min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Members</div>
          <div className="mt-1 text-xl font-semibold text-text-primary">{members.length}</div>
        </div>
        <div className="card-surface min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Roles</div>
          <div className="mt-1 text-xl font-semibold text-text-primary">{roles.length}</div>
        </div>
        <div className="card-surface min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Channels</div>
          <div className="mt-1 text-xl font-semibold text-text-primary">{channels.length}</div>
        </div>
        <div className="card-surface min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Active Invites</div>
          <div className="mt-1 text-xl font-semibold text-text-primary">{invites.length}</div>
        </div>
      </div>
      {isOwner && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-4 py-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Vanity URL
          </div>
          <div className="mb-3 text-sm text-text-muted">
            Set a custom invite path for your server (e.g. <span className="font-mono text-text-secondary">my-server</span>). Leave blank to remove.
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="text"
              className="input-field min-w-[16rem] flex-1 font-mono"
              value={vanityCode}
              onChange={(e) => onVanityCodeChange(e.target.value)}
              placeholder="e.g. my-server"
              maxLength={32}
            />
            <Button
              onClick={onSaveVanity}
              disabled={savingVanity}
              loading={savingVanity}
            >
              Save
            </Button>
          </div>
        </div>
      )}
      {isOwner && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-4 py-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Transfer Ownership
          </div>
          <div className="text-sm text-text-muted">
            Transfer this server to another member. You will lose owner privileges.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <select
              className="select-field min-w-[16rem] flex-1"
              value={ownershipTargetUserId}
              onChange={(e) => onOwnershipTargetChange(e.target.value)}
            >
              {ownershipCandidates.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {(member.nick || member.user.username) + ' (' + member.user.id + ')'}
                </option>
              ))}
            </select>
            <button
              className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
              onClick={onTransferOwnership}
              disabled={transferringOwnership || !ownershipTargetUserId}
            >
              {transferringOwnership ? 'Transferring...' : 'Transfer'}
            </button>
          </div>
        </div>
      )}
      {isOwner && (
        <div className="card-surface rounded-xl border border-accent-danger/25 bg-accent-danger/5 px-4 py-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-danger">
            Danger Zone
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-text-primary">Delete this server</div>
              <div className="text-sm text-text-muted">
                Once deleted, all channels, messages, and data will be permanently removed. This action cannot be undone.
              </div>
            </div>
            <button
              className="rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/20"
              onClick={onShowDeleteDialog}
            >
              Delete Server
            </button>
          </div>
          {showDeleteGuildDialog && guild && (
            <div className="mt-4 rounded-xl border border-accent-danger/30 bg-bg-primary/60 p-4 space-y-3">
              <div className="text-sm text-text-secondary">
                Type <span className="font-semibold text-text-primary">{guild.name}</span> to confirm deletion.
              </div>
              <input
                type="text"
                className="input-field"
                value={deleteGuildConfirmName}
                onChange={(e) => onDeleteGuildConfirmNameChange(e.target.value)}
                placeholder={guild.name}
                autoFocus
              />
              <div className="flex gap-2.5">
                <button
                  className="rounded-lg border border-accent-danger/40 bg-accent-danger px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-danger/85 disabled:opacity-50"
                  onClick={onDeleteGuild}
                  disabled={deletingGuild || deleteGuildConfirmName !== guild.name}
                >
                  {deletingGuild ? 'Deleting...' : 'Delete Server'}
                </button>
                <button
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                  onClick={onHideDeleteDialog}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm leading-6 text-text-secondary">
        Keep this server profile complete so new members instantly recognize your community and can orient themselves faster.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RolesSection
// ---------------------------------------------------------------------------

interface RolesSectionProps {
  roles: Role[];
  canManage: boolean;
  guildId: string;
  newRoleName: string;
  newRoleColor: string;
  editingRoleId: string | null;
  editingRolePermissions: number;
  editingRoleColor: string;
  editingRoleHoist: boolean;
  editingRoleMentionable: boolean;
  onNewRoleNameChange: (v: string) => void;
  onNewRoleColorChange: (v: string) => void;
  onEditingRoleColorChange: (v: string) => void;
  onEditingRolePermissionsToggle: (flag: number) => void;
  onEditingRoleHoistChange: (v: boolean) => void;
  onEditingRoleMentionableChange: (v: boolean) => void;
  onCreateRole: () => void;
  onRenameRole: (roleId: string, name: string) => void;
  onStartEditingRole: (role: Role) => void;
  onSaveRoleEdits: () => void;
  onCancelRoleEditing: () => void;
  onDeleteRole: (roleId: string) => void;
  roleColorHex: (role: Role) => string;
}

export function RolesSection({
  roles,
  canManage,
  guildId,
  newRoleName,
  newRoleColor,
  editingRoleId,
  editingRolePermissions,
  editingRoleColor,
  editingRoleHoist,
  editingRoleMentionable,
  onNewRoleNameChange,
  onNewRoleColorChange,
  onEditingRoleColorChange,
  onEditingRolePermissionsToggle,
  onEditingRoleHoistChange,
  onEditingRoleMentionableChange,
  onCreateRole,
  onRenameRole,
  onStartEditingRole,
  onSaveRoleEdits,
  onCancelRoleEditing,
  onDeleteRole,
  roleColorHex,
}: RolesSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
      <h2 className="settings-section-title !mb-0">Roles</h2>
      {!canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
          Only server admins can create, edit, or assign roles.
        </div>
      )}
      <div className="card-stack">
        {roles.map((role) => {
          const roleColor = roleColorHex(role);
          const isEditing = editingRoleId === role.id;
          return (
            <div key={role.id}>
              <div className="card-surface flex flex-wrap items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <GripVertical size={16} style={{ color: 'var(--text-muted)' }} />
                <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-border-subtle" style={{ backgroundColor: roleColor }} />
                <input
                  className="flex-1 bg-transparent text-base leading-normal outline-none"
                  style={{ color: roleColor !== '#000000' ? roleColor : 'var(--text-primary)' }}
                  defaultValue={role.name}
                  disabled={!canManage}
                  onBlur={(e) => {
                    if (!canManage) return;
                    if (e.target.value !== role.name) onRenameRole(role.id, e.target.value);
                  }}
                />
                {role.hoist && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border-subtle" style={{ color: 'var(--text-muted)' }}>Hoisted</span>
                )}
                {canManage && role.id !== guildId && (
                  <button
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => isEditing ? onCancelRoleEditing() : onStartEditingRole(role)}
                  >
                    {isEditing ? 'Close' : 'Edit'}
                  </button>
                )}
                {canManage && role.id !== guildId && (
                  <button className="icon-btn" onClick={() => onDeleteRole(role.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {isEditing && (
                <div className="card-surface ml-0 mt-3 rounded-xl border border-border-subtle bg-bg-primary/60 p-6 space-y-6 sm:ml-8">
                  <div className="flex items-center gap-4">
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Color</span>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="color"
                          value={editingRoleColor}
                          onChange={(e) => onEditingRoleColorChange(e.target.value)}
                          className="h-9 w-9 cursor-pointer rounded-lg border border-border-subtle bg-transparent"
                        />
                        <input
                          type="text"
                          value={editingRoleColor}
                          onChange={(e) => onEditingRoleColorChange(e.target.value)}
                          className="input-field w-28"
                          maxLength={7}
                        />
                      </div>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editingRoleHoist}
                        onChange={(e) => onEditingRoleHoistChange(e.target.checked)}
                        className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                      />
                      <span className="text-sm text-text-secondary">Display separately (hoist)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editingRoleMentionable}
                        onChange={(e) => onEditingRoleMentionableChange(e.target.checked)}
                        className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                      />
                      <span className="text-sm text-text-secondary">Allow anyone to @mention this role</span>
                    </label>
                  </div>
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Permissions</span>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {[
                        { name: 'Manage Channels', flag: 1 << 4 },
                        { name: 'Manage Server', flag: 1 << 5 },
                        { name: 'Manage Messages', flag: 1 << 13 },
                        { name: 'Manage Roles', flag: 1 << 28 },
                        { name: 'Kick Members', flag: 1 << 1 },
                        { name: 'Ban Members', flag: 1 << 2 },
                        { name: 'Administrator', flag: 1 << 3 },
                        { name: 'Send Messages', flag: 1 << 11 },
                        { name: 'Attach Files', flag: 1 << 15 },
                        { name: 'Add Reactions', flag: 1 << 6 },
                        { name: 'Connect (Voice)', flag: 1 << 20 },
                        { name: 'Speak (Voice)', flag: 1 << 21 },
                        { name: 'Stream', flag: 1 << 9 },
                        { name: 'View Audit Log', flag: 1 << 7 },
                        { name: 'Create Invite', flag: 1 << 0 },
                        { name: 'Change Nickname', flag: 1 << 26 },
                      ].map((perm) => (
                        <label key={perm.name} className="flex items-center gap-2 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-bg-mod-subtle transition-colors">
                          <input
                            type="checkbox"
                            checked={(editingRolePermissions & perm.flag) !== 0}
                            onChange={() => onEditingRolePermissionsToggle(perm.flag)}
                            className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                          />
                          <span className="text-sm text-text-secondary">{perm.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="settings-action-row">
                    <Button onClick={onSaveRoleEdits}>Save Changes</Button>
                    <button
                      className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={onCancelRoleEditing}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canManage && (
        <div className="settings-action-row">
          <input className="input-field flex-1" placeholder="New role name" value={newRoleName} onChange={(e) => onNewRoleNameChange(e.target.value)} />
          <input
            type="color"
            value={newRoleColor}
            onChange={(e) => onNewRoleColorChange(e.target.value)}
            className="h-10 w-10 cursor-pointer rounded-lg border border-border-subtle bg-transparent"
            title="Role color"
          />
          <Button onClick={onCreateRole}>Create Role</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MembersSection
// ---------------------------------------------------------------------------

interface MembersSectionProps {
  members: Member[];
  roles: Role[];
  canManage: boolean;
  memberRoleId: string;
  memberSearch: string;
  editingMemberRoleUserId: string | null;
  draftMemberRoleIds: string[];
  banConfirmUserId: string | null;
  banReasonInput: string;
  onMemberSearchChange: (v: string) => void;
  onStartEditingMemberRoles: (member: Member) => void;
  onCancelEditingMemberRoles: () => void;
  onToggleDraftRoleId: (roleId: string) => void;
  onSaveMemberRoles: (userId: string) => void;
  onKickMember: (userId: string) => void;
  onShowBanConfirm: (userId: string) => void;
  onCancelBanConfirm: () => void;
  onBanReasonChange: (reason: string) => void;
  onBanMember: (userId: string, reason: string) => void;
  roleColorHex: (role: Role) => string;
}

export function MembersSection({
  members,
  roles,
  canManage,
  memberRoleId,
  memberSearch,
  editingMemberRoleUserId,
  draftMemberRoleIds,
  banConfirmUserId,
  banReasonInput,
  onMemberSearchChange,
  onStartEditingMemberRoles,
  onCancelEditingMemberRoles,
  onToggleDraftRoleId,
  onSaveMemberRoles,
  onKickMember,
  onShowBanConfirm,
  onCancelBanConfirm,
  onBanReasonChange,
  onBanMember,
  roleColorHex,
}: MembersSectionProps) {
  const filteredMembers = memberSearch.trim()
    ? members.filter((m) => (m.nick || m.user.username || '').toLowerCase().includes(memberSearch.toLowerCase()))
    : members;

  const assignableRoles = roles.filter((role) => role.id !== memberRoleId);

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Members</h2>
      <input type="text" placeholder="Search members" className="input-field" value={memberSearch} onChange={(e) => onMemberSearchChange(e.target.value)} />
      <div className="card-stack">
        {filteredMembers.map((member) => (
          <div key={member.user.id}>
            <div className="card-surface flex flex-wrap items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold" style={{ backgroundColor: 'var(--accent-primary)' }}>
                {member.user.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm block" style={{ color: 'var(--text-primary)' }}>
                  {member.nick || member.user.username}
                </span>
                {member.nick && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {member.user.username}
                  </span>
                )}
              </div>
              <div className="ml-auto flex items-center gap-1">
                {member.roles && member.roles.length > 0 && (
                  <div className="hidden sm:flex items-center gap-1 mr-2">
                    {member.roles
                      .filter((roleId) => roleId !== memberRoleId)
                      .slice(0, 3)
                      .map((roleId) => {
                        const role = roles.find((r) => r.id === roleId);
                        if (!role) return null;
                        const rColor = roleColorHex(role);
                        return (
                          <span key={roleId} className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-[11px] font-medium" style={{ color: rColor }}>
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rColor }} />
                            {role.name}
                          </span>
                        );
                      })}
                  </div>
                )}
                {canManage && (
                  <button
                    className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => {
                      if (editingMemberRoleUserId === member.user.id) {
                        onCancelEditingMemberRoles();
                        return;
                      }
                      onStartEditingMemberRoles(member);
                    }}
                  >
                    {editingMemberRoleUserId === member.user.id ? 'Close Roles' : 'Roles'}
                  </button>
                )}
                <button className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary" onClick={() => onKickMember(member.user.id)}>Kick</button>
                <button
                  className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                  onClick={() => onShowBanConfirm(member.user.id)}
                >
                  Ban
                </button>
              </div>
            </div>
            {banConfirmUserId === member.user.id && (
              <div className="card-surface ml-10 mt-2 rounded-xl border border-accent-danger/30 bg-accent-danger/5 p-3 space-y-2">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Ban {member.user.username}?
                </p>
                <input
                  type="text"
                  placeholder="Reason for ban (optional)"
                  value={banReasonInput}
                  onChange={(e) => onBanReasonChange(e.target.value)}
                  className="input-field w-full"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onBanMember(member.user.id, banReasonInput);
                    if (e.key === 'Escape') onCancelBanConfirm();
                  }}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors"
                    style={{ backgroundColor: 'var(--accent-danger)', color: '#fff' }}
                    onClick={() => onBanMember(member.user.id, banReasonInput)}
                  >
                    Confirm Ban
                  </button>
                  <button
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle"
                    onClick={onCancelBanConfirm}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {canManage && editingMemberRoleUserId === member.user.id && (
              <div className="card-surface ml-10 mt-2 rounded-xl border border-border-subtle bg-bg-primary/60 p-3 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  Extra Access Roles (Member role is always included)
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {assignableRoles.map((role) => {
                    const checked = draftMemberRoleIds.includes(role.id);
                    return (
                      <label
                        key={role.id}
                        className="card-surface flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle/60 px-2.5 py-2 text-sm text-text-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleDraftRoleId(role.id)}
                          className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                        />
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: roleColorHex(role) }}
                        />
                        <span className="truncate">{role.name}</span>
                      </label>
                    );
                  })}
                  {assignableRoles.length === 0 && (
                    <p className="text-sm text-text-muted">No assignable roles yet.</p>
                  )}
                </div>
                <div className="settings-action-row">
                  <Button
                    onClick={() => onSaveMemberRoles(member.user.id)}
                  >
                    Save Roles
                  </Button>
                  <button
                    className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={onCancelEditingMemberRoles}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {filteredMembers.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No members found.</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvitesSection
// ---------------------------------------------------------------------------

interface InvitesSectionProps {
  invites: Invite[];
  onCreateInvite: () => void;
  onRevokeInvite: (code: string) => void;
}

export function InvitesSection({ invites, onCreateInvite, onRevokeInvite }: InvitesSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Invites</h2>
      <div className="settings-action-row">
        <Button size="sm" onClick={onCreateInvite}>
          Create Invite
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <div className="hidden items-center bg-bg-secondary px-4 py-2.5 text-xs font-semibold uppercase text-text-muted sm:flex">
          <span className="flex-1">Code</span>
          <span className="w-24">Uses</span>
          <span className="w-24">Expires</span>
          <span className="w-16"></span>
        </div>
        {invites.map((invite) => (
          <div key={invite.code} className="flex flex-col items-start gap-1.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <span className="flex-1 font-semibold sm:font-normal" style={{ color: 'var(--text-primary)' }}>{invite.code}</span>
            <span className="text-xs sm:w-24 sm:text-sm" style={{ color: 'var(--text-muted)' }}>Uses: {invite.uses}/{invite.max_uses || 'inf'}</span>
            <span className="text-xs sm:w-24 sm:text-sm" style={{ color: 'var(--text-muted)' }}>Expires: {invite.max_age || 'never'}</span>
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg border border-transparent px-3 text-sm font-semibold text-accent-danger transition-colors hover:border-accent-danger/35 hover:bg-accent-danger/12"
              onClick={() => onRevokeInvite(invite.code)}
            >
              Revoke
            </button>
          </div>
        ))}
        {invites.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <Link size={24} style={{ color: 'var(--text-muted)' }} className="mb-2" />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No active invites.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmojisSection
// ---------------------------------------------------------------------------

interface EmojisSectionProps {
  guildId: string;
  emojis: GuildEmoji[];
  canManage: boolean;
  newEmojiName: string;
  newEmojiFile: File | null;
  editingEmojiId: string | null;
  editingEmojiName: string;
  onNewEmojiNameChange: (v: string) => void;
  onNewEmojiFileChange: (file: File | null, error?: string) => void;
  onEditingEmojiNameChange: (v: string) => void;
  onCreateEmoji: () => void;
  onStartEditingEmoji: (emoji: GuildEmoji) => void;
  onSaveEmojiName: (emojiId: string) => void;
  onCancelEditingEmoji: () => void;
  onDeleteEmoji: (emojiId: string) => void;
}

export function EmojisSection({
  guildId,
  emojis,
  canManage,
  newEmojiName,
  newEmojiFile,
  editingEmojiId,
  editingEmojiName,
  onNewEmojiNameChange,
  onNewEmojiFileChange,
  onEditingEmojiNameChange,
  onCreateEmoji,
  onStartEditingEmoji,
  onSaveEmojiName,
  onCancelEditingEmoji,
  onDeleteEmoji,
}: EmojisSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Emojis</h2>
      {!canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
          You can view server emojis, but Manage Emojis permission is required to add, rename, or delete.
        </div>
      )}

      {canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <input
              className="input-field"
              aria-label="New emoji name"
              placeholder="emoji_name"
              value={newEmojiName}
              maxLength={32}
              onChange={(e) => onNewEmojiNameChange(e.target.value)}
            />
            <label className="inline-flex h-[2.9rem] cursor-pointer items-center justify-center rounded-lg border border-border-subtle bg-bg-primary/50 px-3.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary">
              <input
                type="file"
                accept="image/png,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (!file) {
                    onNewEmojiFileChange(null);
                    return;
                  }
                  if (file.type !== 'image/png' && file.type !== 'image/gif') {
                    onNewEmojiFileChange(null, 'Only PNG and GIF emoji files are supported.');
                    e.currentTarget.value = '';
                    return;
                  }
                  if (file.size > 256 * 1024) {
                    onNewEmojiFileChange(null, 'Emoji image must be 256 KB or less.');
                    e.currentTarget.value = '';
                    return;
                  }
                  onNewEmojiFileChange(file);
                }}
              />
              <span className="truncate">
                {newEmojiFile ? newEmojiFile.name : 'Select PNG/GIF (256 KB max)'}
              </span>
            </label>
            <Button className="h-[2.9rem] min-w-[8rem]" onClick={onCreateEmoji}>
              Upload
            </Button>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Emoji names support letters, numbers, and underscores. Uploaded files are validated client and server side.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {emojis
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((emoji) => {
            const editing = editingEmojiId === emoji.id;
            return (
              <div
                key={emoji.id}
                className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5"
              >
                <div className="flex items-start gap-3">
                  <img
                    src={buildGuildEmojiImageUrl(guildId, emoji.id)}
                    alt={emoji.name}
                    className="h-11 w-11 shrink-0 rounded-lg border border-border-subtle bg-bg-primary/50 object-contain p-1"
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <input
                        className="input-field"
                        aria-label={`Rename emoji ${emoji.name}`}
                        value={editingEmojiName}
                        maxLength={32}
                        onChange={(e) => onEditingEmojiNameChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSaveEmojiName(emoji.id);
                          if (e.key === 'Escape') onCancelEditingEmoji();
                        }}
                        autoFocus
                      />
                    ) : (
                      <p className="truncate text-sm font-semibold text-text-primary">{emoji.name}</p>
                    )}
                    <p className="mt-1 truncate text-xs text-text-muted">
                      &lt;{emoji.animated ? 'a' : ''}:{emoji.name}:{emoji.id}&gt;
                    </p>
                  </div>
                </div>
                {canManage && (
                  <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                    {editing ? (
                      <>
                        <Button onClick={() => onSaveEmojiName(emoji.id)}>
                          Save
                        </Button>
                        <button
                          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={onCancelEditingEmoji}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                        onClick={() => onStartEditingEmoji(emoji)}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/12"
                      onClick={() => onDeleteEmoji(emoji.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {emojis.length === 0 && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
          <Smile size={36} className="mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">No custom emojis uploaded yet.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebhooksSection
// ---------------------------------------------------------------------------

interface WebhooksSectionProps {
  webhooks: Webhook[];
  channels: Channel[];
  canManage: boolean;
  webhookFilterChannelId: 'all' | string;
  newWebhookName: string;
  newWebhookChannelId: string;
  editingWebhookId: string | null;
  editingWebhookName: string;
  issuedWebhookTokens: Record<string, string>;
  copiedWebhookId: string | null;
  webhookInspectingId: string | null;
  webhookExecutingId: string | null;
  webhookTestMessages: Record<string, string>;
  webhookBase: string;
  onFilterChannelChange: (v: 'all' | string) => void;
  onNewWebhookNameChange: (v: string) => void;
  onNewWebhookChannelChange: (v: string) => void;
  onEditingWebhookNameChange: (v: string) => void;
  onWebhookTestMessageChange: (webhookId: string, msg: string) => void;
  onCreateWebhook: () => void;
  onStartEditingWebhook: (webhook: Webhook) => void;
  onSaveWebhookName: (webhookId: string) => void;
  onCancelEditingWebhook: () => void;
  onDeleteWebhook: (webhookId: string) => void;
  onCopyWebhookUrl: (webhookId: string) => void;
  onInspectWebhook: (webhookId: string) => void;
  onExecuteWebhookTest: (webhookId: string) => void;
  channelNameById: Map<string, string>;
}

export function WebhooksSection({
  webhooks,
  channels,
  canManage,
  webhookFilterChannelId,
  newWebhookName,
  newWebhookChannelId,
  editingWebhookId,
  editingWebhookName,
  issuedWebhookTokens,
  copiedWebhookId,
  webhookInspectingId,
  webhookExecutingId,
  webhookTestMessages,
  webhookBase,
  onFilterChannelChange,
  onNewWebhookNameChange,
  onNewWebhookChannelChange,
  onEditingWebhookNameChange,
  onWebhookTestMessageChange,
  onCreateWebhook,
  onStartEditingWebhook,
  onSaveWebhookName,
  onCancelEditingWebhook,
  onDeleteWebhook,
  onCopyWebhookUrl,
  onInspectWebhook,
  onExecuteWebhookTest,
  channelNameById,
}: WebhooksSectionProps) {
  const buildWebhookExecuteUrl = (webhookId: string, token: string) =>
    `${webhookBase}/api/v1/webhooks/${webhookId}/${token}`;

  const textChannels = channels
    .filter((channel) => channel.type === 0 || channel.channel_type === 0)
    .sort((a, b) => a.position - b.position);

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Webhooks</h2>
      {!canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
          You need the Manage Webhooks permission to create, edit, or delete webhooks.
        </div>
      )}
      {canManage && (
        <>
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Filter</div>
            <select
              className="select-field"
              value={webhookFilterChannelId}
              onChange={(e) => onFilterChannelChange(e.target.value)}
            >
              <option value="all">All channels</option>
              {textChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name || 'unnamed'}
                </option>
              ))}
            </select>
          </div>

          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]">
              <input
                className="input-field"
                placeholder="Webhook name"
                value={newWebhookName}
                maxLength={80}
                onChange={(e) => onNewWebhookNameChange(e.target.value)}
              />
              <select
                className="select-field"
                value={newWebhookChannelId}
                onChange={(e) => onNewWebhookChannelChange(e.target.value)}
              >
                {textChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name || 'unnamed'}
                  </option>
                ))}
              </select>
              <Button className="h-[2.9rem] min-w-[8rem]" onClick={onCreateWebhook}>
                Create
              </Button>
            </div>
            <p className="mt-3 text-xs text-text-muted">
              Webhook execute URLs are shown only when the webhook is created in this session.
            </p>
          </div>
        </>
      )}

      <div className="card-stack">
        {webhooks
          .slice()
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((webhook) => {
            const editing = editingWebhookId === webhook.id;
            const issuedToken = issuedWebhookTokens[webhook.id];
            const testMessage = webhookTestMessages[webhook.id] ?? '';
            const createdLabel = new Date(webhook.created_at).toLocaleString();
            return (
              <div
                key={webhook.id}
                className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3 sm:px-5 sm:py-4"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {editing ? (
                      <input
                        className="input-field min-w-[14rem] flex-1"
                        value={editingWebhookName}
                        maxLength={80}
                        onChange={(e) => onEditingWebhookNameChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSaveWebhookName(webhook.id);
                          if (e.key === 'Escape') onCancelEditingWebhook();
                        }}
                        autoFocus
                      />
                    ) : (
                      <span className="text-sm font-semibold text-text-primary">{webhook.name}</span>
                    )}
                    <span className="rounded-lg border border-border-subtle px-2 py-1 text-[11px] font-semibold text-text-secondary">
                      #{channelNameById.get(webhook.channel_id) || 'unknown'}
                    </span>
                    <span className="text-xs text-text-muted">Created {createdLabel}</span>
                  </div>

                  <div className="rounded-lg border border-border-subtle bg-bg-primary/55 px-3 py-2 text-xs">
                    {issuedToken ? (
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-text-secondary">
                          {buildWebhookExecuteUrl(webhook.id, issuedToken)}
                        </span>
                        <button
                          className="rounded-lg border border-border-subtle px-2.5 py-1 font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => onCopyWebhookUrl(webhook.id)}
                        >
                          {copiedWebhookId === webhook.id ? 'Copied' : 'Copy URL'}
                        </button>
                      </div>
                    ) : (
                      <span className="text-text-muted">
                        Token not displayed. Create a new webhook to capture its execute URL.
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {editing ? (
                      <>
                        <Button onClick={() => onSaveWebhookName(webhook.id)}>
                          Save
                        </Button>
                        <button
                          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={onCancelEditingWebhook}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                        onClick={() => onStartEditingWebhook(webhook)}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary disabled:opacity-60"
                      onClick={() => onInspectWebhook(webhook.id)}
                      disabled={webhookInspectingId === webhook.id}
                    >
                      {webhookInspectingId === webhook.id ? 'Refreshing...' : 'Refresh'}
                    </button>
                    <button
                      className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/12"
                      onClick={() => onDeleteWebhook(webhook.id)}
                    >
                      Delete
                    </button>
                  </div>

                  {issuedToken && (
                    <div className="rounded-lg border border-border-subtle bg-bg-primary/45 px-3 py-2.5">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                        Test Execute
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className="input-field min-w-[14rem] flex-1"
                          placeholder="Send a test webhook message"
                          value={testMessage}
                          maxLength={2000}
                          onChange={(e) => onWebhookTestMessageChange(webhook.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              onExecuteWebhookTest(webhook.id);
                            }
                          }}
                        />
                        <Button
                          onClick={() => onExecuteWebhookTest(webhook.id)}
                          disabled={webhookExecutingId === webhook.id || !testMessage.trim()}
                          loading={webhookExecutingId === webhook.id}
                        >
                          {webhookExecutingId === webhook.id ? 'Sending...' : 'Send Test'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        {webhooks.length === 0 && (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
            <p className="text-sm text-text-muted">No webhooks configured.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BotsSection
// ---------------------------------------------------------------------------

interface BotsSectionProps {
  guildId: string;
  guildBots: GuildBotEntry[];
  nativeBotEntries: Array<{ id: string; name: string; description: string }>;
  userBotApps: BotApplication[];
  selectedOwnBotId: string;
  addBotId: string;
  canManage: boolean;
  onSelectedOwnBotIdChange: (v: string) => void;
  onAddBotIdChange: (v: string) => void;
  onAddOwnBot: () => void;
  onAddBotById: () => void;
  onRemoveBot: (applicationId: string) => void;
  onRemoveNativeBot: (botId: string) => void;
}

export function BotsSection({
  guildBots,
  nativeBotEntries,
  userBotApps,
  selectedOwnBotId,
  addBotId,
  canManage,
  onSelectedOwnBotIdChange,
  onAddBotIdChange,
  onAddOwnBot,
  onAddBotById,
  onRemoveBot,
  onRemoveNativeBot,
}: BotsSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Bots</h2>
      {!canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
          You need Manage Server permission to add or remove bots.
        </div>
      )}
      {canManage && (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
          <div className="space-y-3.5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <select
                className="select-field"
                value={selectedOwnBotId}
                onChange={(e) => onSelectedOwnBotIdChange(e.target.value)}
              >
                {userBotApps.length === 0 && (
                  <option value="">No developer apps found</option>
                )}
                {userBotApps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name} ({app.id})
                  </option>
                ))}
              </select>
              <Button
                className="h-[2.9rem] min-w-[8rem]"
                onClick={onAddOwnBot}
                disabled={!selectedOwnBotId}
              >
                Add Owned Bot
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                className="input-field"
                placeholder="Third-party Bot Application ID"
                value={addBotId}
                onChange={(e) => onAddBotIdChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addBotId.trim()) onAddBotById();
                }}
              />
              <Button
                className="h-[2.9rem] min-w-[8rem]"
                onClick={onAddBotById}
              >
                Add by ID
              </Button>
            </div>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Add your own apps quickly from the dropdown, or paste a third-party application ID.
          </p>
        </div>
      )}

      <div className="card-stack">
        {guildBots.map((entry) => (
          <div
            key={entry.application.id}
            className="card-surface flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-primary/15 text-accent-primary">
              <Bot size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary">{entry.application.name}</p>
              {entry.application.description && (
                <p className="text-xs text-text-muted">{entry.application.description}</p>
              )}
              <p className="mt-0.5 text-xs text-text-muted">
                Added {new Date(entry.install.created_at).toLocaleDateString()}
              </p>
            </div>
            {canManage && (
              <button
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
                onClick={() => onRemoveBot(entry.application.id)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {nativeBotEntries.map((entry) => (
          <div
            key={`native-${entry.id}`}
            className="card-surface flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-success/15 text-accent-success">
              <Bot size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-text-primary">{entry.name}</p>
                <span className="rounded-md border border-border-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Native
                </span>
              </div>
              <p className="text-xs text-text-muted">{entry.description}</p>
            </div>
            {canManage && (
              <button
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
                onClick={() => onRemoveNativeBot(entry.id)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {guildBots.length === 0 && nativeBotEntries.length === 0 && (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
            <Bot size={36} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No bots installed in this server.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BansSection
// ---------------------------------------------------------------------------

interface BansSectionProps {
  bans: Ban[];
  onUnban: (userId: string) => void | Promise<void>;
}

export function BansSection({ bans, onUnban }: BansSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Bans</h2>
      <div className="card-stack">
        {bans.map((ban) => (
          <div
            key={ban.user.id}
            className="card-surface flex flex-wrap items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3"
          >
            <div className="h-8 w-8 shrink-0 rounded-full bg-accent-danger text-center text-xs font-semibold leading-8 text-white">
              {ban.user.username.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <span className="block text-sm text-text-primary">{ban.user.username}</span>
              {ban.reason && <span className="text-xs text-text-muted">Reason: {ban.reason}</span>}
            </div>
            <Button size="sm" variant="secondary" onClick={() => void onUnban(ban.user.id)}>
              Unban
            </Button>
          </div>
        ))}
        {bans.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <Gavel size={36} className="mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No banned users.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReportsSection
// ---------------------------------------------------------------------------

interface ReportsSectionProps {
  reports: ModerationReport[];
  members: Member[];
  reportStatusFilter: ReportStatusFilter;
  onReportStatusFilterChange: (next: ReportStatusFilter) => void;
  reportResolvingId: string | null;
  onResolveReport: (reportId: string, action: ReportResolutionAction) => void | Promise<void>;
}

export function ReportsSection({
  reports,
  members,
  reportStatusFilter,
  onReportStatusFilterChange,
  reportResolvingId,
  onResolveReport,
}: ReportsSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="settings-section-title !mb-0">Reports</h2>
        <select
          className="select-field w-auto min-w-[11rem]"
          value={reportStatusFilter}
          onChange={(event) => onReportStatusFilterChange(event.target.value as ReportStatusFilter)}
        >
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="dismissed">Dismissed</option>
          <option value="warned">Warned</option>
          <option value="muted">Muted</option>
          <option value="banned">Banned</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="card-stack">
        {reports.map((report) => {
          const changes = (report.changes || {}) as Record<string, unknown>;
          const isQuarantineReport = String(changes.report_kind || '') === 'automod_quarantine';
          const targetType = String(changes.target_type || 'unknown');
          const targetId = String(changes.target_id || report.target_id || 'unknown');
          const reporter = members.find((member) => member.user.id === report.reporter_id);
          const reporterName = reporter?.nick || reporter?.user.username || report.reporter_id;
          const createdLabel = new Date(report.created_at).toLocaleString();
          const evidence = Array.isArray(changes.evidence)
            ? changes.evidence.filter((item): item is string => typeof item === 'string')
            : [];

          return (
            <div
              key={report.id}
              className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 p-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-text-primary">
                    {targetType.toUpperCase()} report on {targetId}
                  </div>
                  <div className="text-xs text-text-muted">
                    by {reporterName} - {createdLabel}
                  </div>
                  {isQuarantineReport && (
                    <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                      AutoMod quarantine review
                    </div>
                  )}
                </div>
                <span className="rounded-md border border-border-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  {report.status}
                </span>
              </div>

              {report.reason && <div className="mt-2 text-sm text-text-secondary">{report.reason}</div>}

              {evidence.length > 0 && (
                <div className="mt-2 rounded-lg border border-border-subtle bg-bg-primary/40 px-2.5 py-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                    Evidence
                  </div>
                  <div className="space-y-1">
                    {evidence.map((item, idx) => (
                      <div
                        key={`${report.id}-evidence-${idx}`}
                        className="break-all text-xs text-text-muted"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {report.status === 'open' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {isQuarantineReport ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onResolveReport(report.id, 'approve')}
                        disabled={reportResolvingId === report.id}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onResolveReport(report.id, 'reject')}
                        disabled={reportResolvingId === report.id}
                      >
                        Reject
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onResolveReport(report.id, 'dismiss')}
                        disabled={reportResolvingId === report.id}
                      >
                        Dismiss
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onResolveReport(report.id, 'warn')}
                        disabled={reportResolvingId === report.id}
                      >
                        Warn
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onResolveReport(report.id, 'mute')}
                        disabled={reportResolvingId === report.id}
                      >
                        Mute (15m)
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void onResolveReport(report.id, 'ban')}
                    disabled={reportResolvingId === report.id}
                  >
                    Ban
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {reports.length === 0 && (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
            <MessageSquare size={36} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No reports for the selected filter.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditLogSection
// ---------------------------------------------------------------------------

interface AuditLogSectionProps {
  auditEntries: AuditLogEntry[];
  members: Member[];
  channels: Channel[];
  roles: Role[];
}

const ACTION_LABELS: Record<number, string> = {
  1: 'Guild Updated',
  10: 'Channel Created',
  11: 'Channel Updated',
  12: 'Channel Deleted',
  20: 'Member Updated',
  21: 'Member Kicked',
  22: 'Member Banned',
  23: 'Member Unbanned',
  30: 'Role Created',
  31: 'Role Updated',
  32: 'Role Deleted',
  40: 'Invite Created',
  41: 'Invite Deleted',
  72: 'Message Deleted',
  73: 'Messages Bulk Deleted',
  80: 'Bot Added',
  81: 'Bot Removed',
  90: 'Report Created',
  91: 'Report Resolved',
};

export function AuditLogSection({
  auditEntries,
  members,
  channels,
  roles,
}: AuditLogSectionProps) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Audit Log</h2>
      <div className="card-stack max-h-[calc(100dvh-18rem)] overflow-y-auto">
        {auditEntries.map((entry) => {
          const label = ACTION_LABELS[entry.action_type] || `Action ${entry.action_type}`;
          const actor = members.find((member) => member.user.id === entry.user_id);
          const actorName = actor?.nick || actor?.user.username || entry.user_id;
          const targetDesc = entry.target_id
            ? (() => {
                const targetChannel = channels.find((channel) => channel.id === entry.target_id);
                if (targetChannel) return `#${targetChannel.name}`;

                const targetMember = members.find((member) => member.user.id === entry.target_id);
                if (targetMember) return targetMember.nick || targetMember.user.username || entry.target_id;

                const targetRole = roles.find((role) => role.id === entry.target_id);
                if (targetRole) return `@${targetRole.name}`;

                return entry.target_id;
              })()
            : null;

          return (
            <div
              key={entry.id}
              className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-primary">{label}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                by <span className="font-medium text-text-primary">{actorName}</span>
                {targetDesc && (
                  <>
                    {' '}
                    on <span className="font-medium text-text-primary">{targetDesc}</span>
                  </>
                )}
              </div>
              {entry.reason && <div className="mt-1 text-xs text-text-muted">Reason: {entry.reason}</div>}
            </div>
          );
        })}
        {auditEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <ScrollText size={36} className="mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No audit log entries.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModerationTemplatesSection
// ---------------------------------------------------------------------------

interface ModerationTemplatesSectionProps {
  templates: ModerationTemplate[];
  onCreateTemplate: (data: {
    name: string;
    action_type: number;
    duration_minutes?: number;
    reason_template?: string;
    dm_template?: string;
  }) => void | Promise<void>;
  onDeleteTemplate: (templateId: string) => void | Promise<void>;
  onApplyTemplate: (templateId: string, data: ApplyModerationTemplateRequest) => void | Promise<void>;
}

export function ModerationTemplatesSection({
  templates,
  onCreateTemplate,
  onDeleteTemplate,
  onApplyTemplate,
}: ModerationTemplatesSectionProps) {
  const [name, setName] = useState('');
  const [actionType, setActionType] = useState(1);
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [reasonTemplate, setReasonTemplate] = useState('');
  const [dmTemplate, setDmTemplate] = useState('');
  const [saving, setSaving] = useState(false);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);
  const [applyDrafts, setApplyDrafts] = useState<
    Record<string, { targetUserId: string; reason: string; dmMessage: string }>
  >({});
  const [applyStatus, setApplyStatus] = useState<Record<string, string>>({});

  const needsDuration = actionType === 2;

  const getApplyDraft = (templateId: string) =>
    applyDrafts[templateId] ?? { targetUserId: '', reason: '', dmMessage: '' };

  const updateApplyDraft = (
    templateId: string,
    patch: Partial<{ targetUserId: string; reason: string; dmMessage: string }>
  ) => {
    setApplyDrafts((prev) => {
      const current = prev[templateId] ?? {
        targetUserId: '',
        reason: '',
        dmMessage: '',
      };

      return {
        ...prev,
        [templateId]: {
          ...current,
          ...patch,
        },
      };
    });
    setApplyStatus((prev) => ({ ...prev, [templateId]: '' }));
  };

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    try {
      await onCreateTemplate({
        name: trimmedName,
        action_type: actionType,
        duration_minutes: needsDuration ? durationMinutes : undefined,
        reason_template: reasonTemplate.trim() || undefined,
        dm_template: dmTemplate.trim() || undefined,
      });
      setName('');
      setActionType(1);
      setDurationMinutes(10);
      setReasonTemplate('');
      setDmTemplate('');
    } finally {
      setSaving(false);
    }
  }

  async function handleApply(templateId: string) {
    const draft = getApplyDraft(templateId);
    const targetUserId = draft.targetUserId.trim();
    if (!targetUserId || applyingTemplateId) return;

    setApplyingTemplateId(templateId);
    setApplyStatus((prev) => ({ ...prev, [templateId]: '' }));
    try {
      await onApplyTemplate(templateId, {
        target_user_id: targetUserId,
        reason: draft.reason.trim() || undefined,
        dm_message: draft.dmMessage.trim() || undefined,
      });
      setApplyDrafts((prev) => ({
        ...prev,
        [templateId]: { targetUserId: '', reason: '', dmMessage: '' },
      }));
      setApplyStatus((prev) => ({ ...prev, [templateId]: 'Template applied.' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply template.';
      setApplyStatus((prev) => ({ ...prev, [templateId]: message }));
    } finally {
      setApplyingTemplateId(null);
    }
  }

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Mod Templates</h2>

      {/* Create new template */}
      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          New Template
        </div>
        <div className="grid gap-3">
          <input
            className="input-field"
            aria-label="Template name"
            placeholder="Template name (e.g. Spam Warning)"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-secondary">Action Type</label>
              <select
                className="select-field"
                aria-label="Action type"
                value={actionType}
                onChange={(e) => setActionType(Number(e.target.value))}
              >
                <option value={1}>Warn</option>
                <option value={2}>Timed Mute</option>
                <option value={3}>Kick</option>
                <option value={4}>Ban</option>
              </select>
            </div>
            {needsDuration && (
              <div>
                <label className="mb-1 block text-xs text-text-secondary">
                  Duration (minutes)
                </label>
                <input
                  className="input-field"
                  aria-label="Duration in minutes"
                  type="number"
                  min={1}
                  max={43200}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                />
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-secondary">
              Reason Template{' '}
              <span className="text-text-muted">(optional — use {'{target}'}, {'{moderator}'}, {'{reason}'})</span>
            </label>
            <textarea
              className="input-field min-h-[4rem] resize-y"
              aria-label="Reason template"
              placeholder="e.g. {target} was warned for spam."
              maxLength={500}
              value={reasonTemplate}
              onChange={(e) => setReasonTemplate(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-secondary">
              DM Template <span className="text-text-muted">(optional — sent to the user)</span>
            </label>
            <textarea
              className="input-field min-h-[4rem] resize-y"
              aria-label="DM template"
              placeholder="e.g. You have been warned in {guild} for: {reason}"
              maxLength={500}
              value={dmTemplate}
              onChange={(e) => setDmTemplate(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="default"
              size="sm"
              disabled={!name.trim() || saving}
              onClick={() => void handleCreate()}
            >
              {saving ? 'Creating…' : 'Create Template'}
            </Button>
          </div>
        </div>
      </div>

      {/* Existing templates */}
      <div className="card-stack">
        {templates.map((template) => (
          <div
            key={template.id}
            className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3"
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/20 text-accent-primary">
                <Shield size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{template.name}</span>
                  <span className="rounded-full bg-bg-mod-subtle px-2 py-0.5 text-xs text-text-secondary">
                    {ACTION_TYPE_LABELS[template.action_type] ?? `Type ${template.action_type}`}
                  </span>
                  {template.action_type === 2 && template.duration_minutes != null && (
                    <span className="text-xs text-text-muted">
                      {template.duration_minutes}m
                    </span>
                  )}
                </div>
                {template.reason_template && (
                  <p className="mt-0.5 text-xs text-text-muted">
                    Reason: {template.reason_template}
                  </p>
                )}
                {template.dm_template && (
                  <p className="mt-0.5 text-xs text-text-muted">DM: {template.dm_template}</p>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Delete moderation template ${template.name}`}
                onClick={() => void onDeleteTemplate(template.id)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <form
              className="mt-3 grid gap-2 border-t border-border-subtle/70 pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleApply(template.id);
              }}
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <input
                  className="input-field"
                  aria-label={`Target user ID for ${template.name}`}
                  placeholder="Target user ID"
                  value={getApplyDraft(template.id).targetUserId}
                  onChange={(event) => updateApplyDraft(template.id, { targetUserId: event.target.value })}
                />
                <input
                  className="input-field"
                  aria-label={`Reason override for ${template.name}`}
                  placeholder="Reason override (optional)"
                  maxLength={500}
                  value={getApplyDraft(template.id).reason}
                  onChange={(event) => updateApplyDraft(template.id, { reason: event.target.value })}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  className="input-field"
                  aria-label={`DM override for ${template.name}`}
                  placeholder="DM override (optional)"
                  maxLength={500}
                  value={getApplyDraft(template.id).dmMessage}
                  onChange={(event) => updateApplyDraft(template.id, { dmMessage: event.target.value })}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!getApplyDraft(template.id).targetUserId.trim() || applyingTemplateId !== null}
                >
                  {applyingTemplateId === template.id ? 'Applying...' : 'Apply Template'}
                </Button>
              </div>
              {applyStatus[template.id] && (
                <p className="text-xs text-text-muted" role="status">
                  {applyStatus[template.id]}
                </p>
              )}
            </form>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <Shield size={36} className="mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No moderation templates yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
