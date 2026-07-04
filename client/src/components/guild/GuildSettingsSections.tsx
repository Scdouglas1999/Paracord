import type { ChangeEvent, ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  Bot,
  Copy,
  Gavel,
  Link as LinkIcon,
  MessageSquare,
  Plus,
  ScrollText,
  Shield,
  Smile,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type { AuditLogEntry, Ban, Channel, Guild, GuildEmoji, Invite, Member, ModerationReport, Role, Webhook } from '../../types';
import type { BotApplication, GuildBotEntry } from '../../api/bots';
import type { ApplyModerationTemplateRequest, ModerationTemplate } from '../../api/moderationTemplates';
import { ACTION_TYPE_LABELS } from '../../api/moderationTemplates';
import { Button } from '../ui/Button';
import { Input, Select, Textarea } from '../ui/Input';
import { EmptyState } from '../ui/Feedback';
import { buildGuildEmojiImageUrl } from '../../lib/customEmoji';
import { cn } from '../../lib/utils';
import { SectionHeader, GroupLabel, FieldLabel, ToggleRow, GateNotice } from './SettingsPrimitives';

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

// Shared surface wrapper: one elevated settings panel per section (kill-list #5 —
// never tile identical cards; group with dividers instead).
function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6">
      <div className="flex flex-col gap-8">{children}</div>
    </div>
  );
}

function initialFor(name: string) {
  return name.charAt(0).toUpperCase() || '?';
}

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
  const stats: { label: string; value: number }[] = [
    { label: 'Members', value: members.length },
    { label: 'Roles', value: roles.length },
    { label: 'Channels', value: channels.length },
    { label: 'Active invites', value: invites.length },
  ];

  return (
    <SettingsPanel>
      <SectionHeader
        title="Overview"
        description="Your server's identity — the name, icon, and blurb members see everywhere."
        action={
          <div className="flex items-center gap-2">
            {guild && authUserId && guild.owner_id !== authUserId && (
              <Button variant="ghost" onClick={onLeave}>
                Leave server
              </Button>
            )}
            <Button onClick={onSave}>Save Changes</Button>
          </div>
        }
      />

      {/* Identity */}
      <section className="flex flex-col gap-6 border-t border-border-subtle pt-6 sm:flex-row sm:gap-8">
        <label className="group shrink-0 cursor-pointer">
          <input type="file" accept="image/*" className="hidden" onChange={onIconChange} />
          <div className="flex h-24 w-24 flex-col items-center justify-center overflow-hidden rounded-full border border-border-strong bg-bg-tertiary transition-colors group-hover:border-accent-primary/60">
            {iconDataUrl ? (
              <img src={iconDataUrl} alt="Server icon" className="h-full w-full object-cover" />
            ) : (
              <>
                <Upload size={20} className="text-text-muted" />
                <span className="mt-1 text-meta font-semibold uppercase text-text-muted">Upload</span>
              </>
            )}
          </div>
        </label>
        <div className="flex flex-1 flex-col gap-5">
          <label className="block">
            <FieldLabel>Server name</FieldLabel>
            <Input value={name} onChange={(e) => onNameChange(e.target.value)} />
          </label>
          <label className="block">
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Describe what this server is about."
            />
          </label>
        </div>
      </section>

      {/* Stat strip — not tiled cards; a divided figure row */}
      <section className="grid grid-cols-2 divide-border-subtle border-t border-border-subtle pt-6 sm:grid-cols-4 sm:divide-x">
        {stats.map((stat) => (
          <div key={stat.label} className="px-1 first:pl-0 sm:px-5">
            <div className="font-code text-2xl font-semibold tabular-nums text-text-primary">{stat.value}</div>
            <div className="mt-0.5 text-meta uppercase tracking-[0.04em] text-text-muted">{stat.label}</div>
          </div>
        ))}
      </section>

      {isOwner && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Vanity invite</GroupLabel>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            Give out a memorable invite path like{' '}
            <span className="font-code text-[12.5px] text-text-secondary">/your-server</span>. Leave blank to remove it.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Input
              className="min-w-[16rem] flex-1 font-code"
              value={vanityCode}
              onChange={(e) => onVanityCodeChange(e.target.value)}
              placeholder="your-server"
              maxLength={32}
            />
            <Button onClick={onSaveVanity} disabled={savingVanity} loading={savingVanity}>
              Save
            </Button>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Transfer ownership</GroupLabel>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            Hand this server to another member. You'll immediately lose owner privileges — this can't be undone.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Select
              className="min-w-[16rem] flex-1"
              value={ownershipTargetUserId}
              onChange={(e) => onOwnershipTargetChange(e.target.value)}
            >
              {ownershipCandidates.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {(member.nick || member.user.username) + ' (' + member.user.id + ')'}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              onClick={onTransferOwnership}
              disabled={transferringOwnership || !ownershipTargetUserId}
              loading={transferringOwnership}
            >
              Transfer
            </Button>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="rounded-md border border-accent-danger/25 bg-danger-tint p-5">
          <GroupLabel className="!text-accent-danger">Danger zone</GroupLabel>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-label text-text-primary">Delete this server</div>
              <div className="mt-0.5 text-meta text-text-secondary">
                Every channel, message, and upload is permanently erased. This cannot be undone.
              </div>
            </div>
            <Button variant="destructive" onClick={onShowDeleteDialog}>
              Delete Server
            </Button>
          </div>
          {showDeleteGuildDialog && guild && (
            <div className="mt-4 space-y-3 border-t border-accent-danger/25 pt-4">
              <div className="text-[13.5px] text-text-secondary">
                Type <span className="font-semibold text-text-primary">{guild.name}</span> to confirm.
              </div>
              <Input
                value={deleteGuildConfirmName}
                onChange={(e) => onDeleteGuildConfirmNameChange(e.target.value)}
                placeholder={guild.name}
                autoFocus
              />
              <div className="flex gap-2.5">
                <Button
                  variant="destructive"
                  onClick={onDeleteGuild}
                  disabled={deletingGuild || deleteGuildConfirmName !== guild.name}
                  loading={deletingGuild}
                >
                  Delete Server
                </Button>
                <Button variant="ghost" onClick={onHideDeleteDialog}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </SettingsPanel>
  );
}

// ---------------------------------------------------------------------------
// RolesSection
// ---------------------------------------------------------------------------

const PERMISSION_GROUPS: { group: string; perms: { name: string; flag: number }[] }[] = [
  {
    group: 'General',
    perms: [
      { name: 'Manage Channels', flag: 1 << 4 },
      { name: 'Manage Server', flag: 1 << 5 },
      { name: 'Manage Roles', flag: 1 << 28 },
      { name: 'View Audit Log', flag: 1 << 7 },
      { name: 'Create Invite', flag: 1 << 0 },
      { name: 'Change Nickname', flag: 1 << 26 },
    ],
  },
  {
    group: 'Membership',
    perms: [
      { name: 'Kick Members', flag: 1 << 1 },
      { name: 'Ban Members', flag: 1 << 2 },
      { name: 'Administrator', flag: 1 << 3 },
    ],
  },
  {
    group: 'Text',
    perms: [
      { name: 'Send Messages', flag: 1 << 11 },
      { name: 'Manage Messages', flag: 1 << 13 },
      { name: 'Attach Files', flag: 1 << 15 },
      { name: 'Add Reactions', flag: 1 << 6 },
    ],
  },
  {
    group: 'Voice',
    perms: [
      { name: 'Connect', flag: 1 << 20 },
      { name: 'Speak', flag: 1 << 21 },
      { name: 'Stream', flag: 1 << 9 },
    ],
  },
];

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
  const newRoleInputRef = useRef<HTMLInputElement>(null);
  const customRoles = roles.filter((role) => role.id !== guildId);

  return (
    <SettingsPanel>
      <SectionHeader
        title="Roles"
        description="Roles bundle a color and a set of permissions. Everyone starts with @everyone; layer more on top."
      />

      {!canManage && <GateNotice>Only server admins can create, edit, or assign roles.</GateNotice>}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Create a role</GroupLabel>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Input
              ref={newRoleInputRef}
              className="min-w-[14rem] flex-1"
              placeholder="e.g. Moderators"
              value={newRoleName}
              onChange={(e) => onNewRoleNameChange(e.target.value)}
            />
            <input
              type="color"
              value={newRoleColor}
              onChange={(e) => onNewRoleColorChange(e.target.value)}
              className="h-10 w-10 shrink-0 cursor-pointer rounded-sm border border-border-subtle bg-transparent"
              title="Role color"
              aria-label="New role color"
            />
            <Button onClick={onCreateRole} disabled={!newRoleName.trim()}>
              <Plus size={15} className="mr-1.5" />
              Create role
            </Button>
          </div>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>{customRoles.length > 0 ? `Roles · ${roles.length}` : 'Roles'}</GroupLabel>
        {customRoles.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Shield size={20} />}
            title="No custom roles yet"
            description="Everyone starts with @everyone. Add a role to grant colors, hoisting, and finer permissions."
            action={
              canManage ? (
                <Button onClick={() => newRoleInputRef.current?.focus()}>
                  <Plus size={15} className="mr-1.5" />
                  Create role
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="mt-2 divide-y divide-border-subtle">
            {roles.map((role) => {
              const roleColor = roleColorHex(role);
              const isEditing = editingRoleId === role.id;
              const isEveryone = role.id === guildId;
              return (
                <li key={role.id}>
                  <div className="group flex flex-wrap items-center gap-3 py-3">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-black/20"
                      style={{ backgroundColor: roleColor }}
                      aria-hidden
                    />
                    <input
                      className="min-w-0 flex-1 bg-transparent text-label text-text-primary outline-none disabled:cursor-default"
                      style={{ color: roleColor !== '#000000' ? roleColor : undefined }}
                      defaultValue={role.name}
                      disabled={!canManage || isEveryone}
                      aria-label={`Role name for ${role.name}`}
                      onBlur={(e) => {
                        if (!canManage || isEveryone) return;
                        if (e.target.value !== role.name) onRenameRole(role.id, e.target.value);
                      }}
                    />
                    {role.hoist && (
                      <span className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold text-text-secondary">
                        Hoisted
                      </span>
                    )}
                    {canManage && !isEveryone && (
                      <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => (isEditing ? onCancelRoleEditing() : onStartEditingRole(role))}
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </Button>
                        <button
                          className="icon-btn"
                          onClick={() => onDeleteRole(role.id)}
                          aria-label={`Delete role ${role.name}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                  {isEditing && (
                    <div className="mb-4 ml-6 flex flex-col gap-6 border-l border-border-subtle pl-5">
                      <div className="flex items-center gap-3">
                        <label className="block">
                          <FieldLabel>Color</FieldLabel>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={editingRoleColor}
                              onChange={(e) => onEditingRoleColorChange(e.target.value)}
                              className="h-10 w-10 cursor-pointer rounded-sm border border-border-subtle bg-transparent"
                              aria-label="Role color"
                            />
                            <Input
                              value={editingRoleColor}
                              onChange={(e) => onEditingRoleColorChange(e.target.value)}
                              className="w-28 font-code"
                              maxLength={7}
                            />
                          </div>
                        </label>
                      </div>
                      <div className="divide-y divide-border-subtle">
                        <ToggleRow
                          label="Display separately"
                          description="Show members with this role above everyone else in the sidebar."
                          checked={editingRoleHoist}
                          onChange={onEditingRoleHoistChange}
                        />
                        <ToggleRow
                          label="Allow @mention"
                          description="Let anyone ping this role in chat."
                          checked={editingRoleMentionable}
                          onChange={onEditingRoleMentionableChange}
                        />
                      </div>
                      {PERMISSION_GROUPS.map((pg) => (
                        <div key={pg.group}>
                          <GroupLabel>{pg.group}</GroupLabel>
                          <div className="mt-1 divide-y divide-border-subtle">
                            {pg.perms.map((perm) => (
                              <ToggleRow
                                key={perm.name}
                                label={perm.name}
                                checked={(editingRolePermissions & perm.flag) !== 0}
                                onChange={() => onEditingRolePermissionsToggle(perm.flag)}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-2.5">
                        <Button onClick={onSaveRoleEdits}>Save Changes</Button>
                        <Button variant="ghost" onClick={onCancelRoleEditing}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Members"
        description={`${members.length} ${members.length === 1 ? 'person is' : 'people are'} in this server. Manage their roles, or remove them.`}
      />
      <Input
        type="text"
        placeholder="Search members by name"
        value={memberSearch}
        onChange={(e) => onMemberSearchChange(e.target.value)}
      />
      <section className="border-t border-border-subtle pt-2">
        {filteredMembers.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Users size={20} />}
            title={memberSearch.trim() ? 'No matches' : 'No members yet'}
            description={
              memberSearch.trim()
                ? `Nobody here matches "${memberSearch.trim()}". Try a different name.`
                : 'Invite people and they will show up here.'
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {filteredMembers.map((member) => (
              <li key={member.user.id}>
                <div className="group flex flex-wrap items-center gap-3 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-tint text-label font-semibold text-accent-primary">
                    {initialFor(member.user.username)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-label text-text-primary">{member.nick || member.user.username}</span>
                    {member.nick && <span className="text-meta text-text-muted">{member.user.username}</span>}
                  </div>
                  {member.roles && member.roles.length > 0 && (
                    <div className="mr-2 hidden items-center gap-1 sm:flex">
                      {member.roles
                        .filter((roleId) => roleId !== memberRoleId)
                        .slice(0, 3)
                        .map((roleId) => {
                          const role = roles.find((r) => r.id === roleId);
                          if (!role) return null;
                          const rColor = roleColorHex(role);
                          return (
                            <span
                              key={roleId}
                              className="inline-flex items-center gap-1 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-medium"
                              style={{ color: rColor }}
                            >
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: rColor }} />
                              {role.name}
                            </span>
                          );
                        })}
                    </div>
                  )}
                  <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (editingMemberRoleUserId === member.user.id) {
                            onCancelEditingMemberRoles();
                            return;
                          }
                          onStartEditingMemberRoles(member);
                        }}
                      >
                        {editingMemberRoleUserId === member.user.id ? 'Close roles' : 'Roles'}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => onKickMember(member.user.id)}>
                      Kick
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger"
                      onClick={() => onShowBanConfirm(member.user.id)}
                    >
                      Ban
                    </Button>
                  </div>
                </div>
                {banConfirmUserId === member.user.id && (
                  <div className="mb-3 ml-12 space-y-2.5 rounded-md border border-accent-danger/30 bg-danger-tint p-3.5">
                    <p className="text-label text-text-primary">Ban {member.user.username}?</p>
                    <Input
                      type="text"
                      placeholder="Reason (optional)"
                      value={banReasonInput}
                      onChange={(e) => onBanReasonChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onBanMember(member.user.id, banReasonInput);
                        if (e.key === 'Escape') onCancelBanConfirm();
                      }}
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="destructive" size="sm" onClick={() => onBanMember(member.user.id, banReasonInput)}>
                        Confirm ban
                      </Button>
                      <Button variant="ghost" size="sm" onClick={onCancelBanConfirm}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {canManage && editingMemberRoleUserId === member.user.id && (
                  <div className="mb-3 ml-12 space-y-3 border-l border-border-subtle pl-4">
                    <GroupLabel>Extra roles</GroupLabel>
                    <p className="text-meta text-text-muted">The base member role is always included.</p>
                    {assignableRoles.length === 0 ? (
                      <p className="text-[13.5px] text-text-secondary">No assignable roles yet — create one first.</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {assignableRoles.map((role) => {
                          const checked = draftMemberRoleIds.includes(role.id);
                          return (
                            <label
                              key={role.id}
                              className={cn(
                                'flex cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2 text-label transition-colors',
                                checked
                                  ? 'border-accent-primary/50 bg-accent-tint text-text-primary'
                                  : 'border-border-subtle text-text-secondary hover:bg-bg-mod-subtle',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => onToggleDraftRoleId(role.id)}
                                className="h-4 w-4 rounded-sm border-border-subtle accent-accent-primary"
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: roleColorHex(role) }} />
                              <span className="truncate">{role.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center gap-2.5">
                      <Button size="sm" onClick={() => onSaveMemberRoles(member.user.id)}>
                        Save roles
                      </Button>
                      <Button variant="ghost" size="sm" onClick={onCancelEditingMemberRoles}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Invites"
        description="Share these links to bring people in. Revoke any that leak or outlive their purpose."
        action={
          <Button onClick={onCreateInvite}>
            <Plus size={15} className="mr-1.5" />
            Create invite
          </Button>
        }
      />
      <section className="border-t border-border-subtle pt-6">
        {invites.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<LinkIcon size={20} />}
            title="No active invites"
            description="Generate a link and hand it out — you can cap its uses and lifespan later."
            action={
              <Button onClick={onCreateInvite}>
                <Plus size={15} className="mr-1.5" />
                Create invite
              </Button>
            }
          />
        ) : (
          <>
            <div className="hidden items-center gap-3 border-b border-border-subtle pb-2 text-section uppercase text-text-muted sm:flex">
              <span className="flex-1">Code</span>
              <span className="w-24">Uses</span>
              <span className="w-28">Expires</span>
              <span className="w-16" />
            </div>
            <ul className="divide-y divide-border-subtle">
              {invites.map((invite) => (
                <li
                  key={invite.code}
                  className="group flex flex-col items-start gap-1.5 py-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span className="flex-1 font-code text-label text-text-primary">{invite.code}</span>
                  <span className="font-code text-meta tabular-nums text-text-muted sm:w-24">
                    {invite.uses}/{invite.max_uses || '∞'}
                  </span>
                  <span className="font-code text-meta tabular-nums text-text-muted sm:w-28">
                    {invite.max_age || 'never'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger sm:opacity-0 sm:transition-opacity sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                    onClick={() => onRevokeInvite(invite.code)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Emojis"
        description="Custom emoji anyone in the server can drop into chat and reactions."
      />

      {!canManage && (
        <GateNotice>You can view server emojis, but the Manage Emojis permission is needed to add, rename, or delete.</GateNotice>
      )}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Add an emoji</GroupLabel>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Input
              aria-label="New emoji name"
              placeholder="emoji_name"
              value={newEmojiName}
              maxLength={32}
              onChange={(e) => onNewEmojiNameChange(e.target.value)}
            />
            <label className="inline-flex h-10 cursor-pointer items-center justify-center rounded-sm border border-border-subtle bg-bg-tertiary px-3.5 text-label text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary">
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
              <span className="truncate">{newEmojiFile ? newEmojiFile.name : 'Choose PNG/GIF · 256 KB'}</span>
            </label>
            <Button onClick={onCreateEmoji} disabled={!newEmojiName.trim() || !newEmojiFile}>
              <Upload size={15} className="mr-1.5" />
              Upload
            </Button>
          </div>
          <p className="mt-3 text-meta text-text-muted">
            Names take letters, numbers, and underscores. Files are validated on the client and the server.
          </p>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>{emojis.length > 0 ? `Server emoji · ${emojis.length}` : 'Server emoji'}</GroupLabel>
        {emojis.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Smile size={20} />}
            title="No custom emoji yet"
            description="Upload a PNG or GIF above and it becomes available across every channel in the server."
          />
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {emojis
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((emoji) => {
                const editing = editingEmojiId === emoji.id;
                return (
                  <div key={emoji.id} className="group flex items-start gap-3 rounded-md border border-border-subtle p-3">
                    <img
                      src={buildGuildEmojiImageUrl(guildId, emoji.id)}
                      alt={emoji.name}
                      className="h-11 w-11 shrink-0 rounded-sm bg-bg-tertiary object-contain p-1"
                      loading="lazy"
                    />
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <Input
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
                        <p className="truncate text-label text-text-primary">{emoji.name}</p>
                      )}
                      <p className="mt-1 truncate font-code text-meta text-text-muted">
                        &lt;{emoji.animated ? 'a' : ''}:{emoji.name}:{emoji.id}&gt;
                      </p>
                      {canManage && (
                        <div className="mt-2.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          {editing ? (
                            <>
                              <Button size="sm" onClick={() => onSaveEmojiName(emoji.id)}>
                                Save
                              </Button>
                              <Button variant="ghost" size="sm" onClick={onCancelEditingEmoji}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => onStartEditingEmoji(emoji)}>
                              Rename
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger"
                            onClick={() => onDeleteEmoji(emoji.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Webhooks"
        description="Post messages into channels from external services. Execute URLs are shown once, at creation."
      />

      {!canManage && (
        <GateNotice>You need the Manage Webhooks permission to create, edit, or delete webhooks.</GateNotice>
      )}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>New webhook</GroupLabel>
          <div className="mt-4 flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]">
              <Input
                placeholder="Webhook name"
                value={newWebhookName}
                maxLength={80}
                onChange={(e) => onNewWebhookNameChange(e.target.value)}
              />
              <Select value={newWebhookChannelId} onChange={(e) => onNewWebhookChannelChange(e.target.value)}>
                {textChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name || 'unnamed'}
                  </option>
                ))}
              </Select>
              <Button onClick={onCreateWebhook} disabled={!newWebhookName.trim()}>
                <Plus size={15} className="mr-1.5" />
                Create
              </Button>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-meta text-text-muted">
              <span className="text-section uppercase text-text-secondary">Filter</span>
              <Select
                className="w-auto min-w-[12rem]"
                value={webhookFilterChannelId}
                onChange={(e) => onFilterChannelChange(e.target.value)}
              >
                <option value="all">All channels</option>
                {textChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name || 'unnamed'}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>{webhooks.length > 0 ? `Webhooks · ${webhooks.length}` : 'Webhooks'}</GroupLabel>
        {webhooks.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<LinkIcon size={20} />}
            title="No webhooks yet"
            description="Create one above to let an external service post into a channel. You'll get its execute URL once."
          />
        ) : (
          <ul className="mt-2 divide-y divide-border-subtle">
            {webhooks
              .slice()
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((webhook) => {
                const editing = editingWebhookId === webhook.id;
                const issuedToken = issuedWebhookTokens[webhook.id];
                const testMessage = webhookTestMessages[webhook.id] ?? '';
                const createdLabel = new Date(webhook.created_at).toLocaleString();
                return (
                  <li key={webhook.id} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-center gap-2.5">
                      {editing ? (
                        <Input
                          className="min-w-[14rem] flex-1"
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
                        <span className="text-label text-text-primary">{webhook.name}</span>
                      )}
                      <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-semibold text-text-secondary">
                        #{channelNameById.get(webhook.channel_id) || 'unknown'}
                      </span>
                      <span className="font-code text-meta tabular-nums text-text-muted">Created {createdLabel}</span>
                    </div>

                    <div className="rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-meta">
                      {issuedToken ? (
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="min-w-0 flex-1 truncate font-code text-text-secondary">
                            {buildWebhookExecuteUrl(webhook.id, issuedToken)}
                          </span>
                          <Button variant="outline" size="sm" onClick={() => onCopyWebhookUrl(webhook.id)}>
                            <Copy size={13} className="mr-1.5" />
                            {copiedWebhookId === webhook.id ? 'Copied' : 'Copy URL'}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-text-muted">
                          Token hidden. Recreate this webhook to capture its execute URL.
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {editing ? (
                        <>
                          <Button size="sm" onClick={() => onSaveWebhookName(webhook.id)}>
                            Save
                          </Button>
                          <Button variant="ghost" size="sm" onClick={onCancelEditingWebhook}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => onStartEditingWebhook(webhook)}>
                          Rename
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onInspectWebhook(webhook.id)}
                        disabled={webhookInspectingId === webhook.id}
                      >
                        {webhookInspectingId === webhook.id ? 'Refreshing…' : 'Refresh'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger"
                        onClick={() => onDeleteWebhook(webhook.id)}
                      >
                        Delete
                      </Button>
                    </div>

                    {issuedToken && (
                      <div className="rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2.5">
                        <GroupLabel>Test execute</GroupLabel>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Input
                            className="min-w-[14rem] flex-1"
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
                            Send test
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
  const isEmpty = guildBots.length === 0 && nativeBotEntries.length === 0;
  return (
    <SettingsPanel>
      <SectionHeader
        title="Bots"
        description="Automations installed in this server — your own apps, third-party apps, and Paracord's built-ins."
      />

      {!canManage && <GateNotice>You need the Manage Server permission to add or remove bots.</GateNotice>}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Add a bot</GroupLabel>
          <div className="mt-4 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Select value={selectedOwnBotId} onChange={(e) => onSelectedOwnBotIdChange(e.target.value)}>
                {userBotApps.length === 0 && <option value="">No developer apps found</option>}
                {userBotApps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name} ({app.id})
                  </option>
                ))}
              </Select>
              <Button onClick={onAddOwnBot} disabled={!selectedOwnBotId}>
                Add owned bot
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Input
                placeholder="Third-party application ID"
                value={addBotId}
                onChange={(e) => onAddBotIdChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addBotId.trim()) onAddBotById();
                }}
              />
              <Button variant="outline" onClick={onAddBotById} disabled={!addBotId.trim()}>
                Add by ID
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Installed</GroupLabel>
        {isEmpty ? (
          <EmptyState
            className="!py-8"
            icon={<Bot size={20} />}
            title="No bots installed"
            description="Add one of your developer apps, paste a third-party application ID, or enable a built-in from the Bot Store."
          />
        ) : (
          <ul className="mt-2 divide-y divide-border-subtle">
            {guildBots.map((entry) => (
              <li key={entry.application.id} className="group flex flex-wrap items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                  <Bot size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-label text-text-primary">{entry.application.name}</p>
                  {entry.application.description && (
                    <p className="truncate text-meta text-text-muted">{entry.application.description}</p>
                  )}
                  <p className="font-code text-meta tabular-nums text-text-muted">
                    Added {new Date(entry.install.created_at).toLocaleDateString()}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => onRemoveBot(entry.application.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {nativeBotEntries.map((entry) => (
              <li key={`native-${entry.id}`} className="group flex flex-wrap items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success-tint text-accent-success">
                  <Bot size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-label text-text-primary">{entry.name}</p>
                    <span className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold uppercase text-text-secondary">
                      Native
                    </span>
                  </div>
                  <p className="truncate text-meta text-text-muted">{entry.description}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => onRemoveNativeBot(entry.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Bans"
        description="People blocked from rejoining. Lift a ban to let someone back in with a fresh invite."
      />
      <section className="border-t border-border-subtle pt-6">
        {bans.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Gavel size={20} />}
            title="No one is banned"
            description="When you ban a member their entry lands here, where you can review the reason or reverse it."
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {bans.map((ban) => (
              <li key={ban.user.id} className="group flex flex-wrap items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-tint text-label font-semibold text-accent-danger">
                  {initialFor(ban.user.username)}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block text-label text-text-primary">{ban.user.username}</span>
                  {ban.reason && <span className="text-meta text-text-muted">{ban.reason}</span>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => void onUnban(ban.user.id)}>
                  Unban
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
    <SettingsPanel>
      <SectionHeader
        title="Reports"
        description="Member reports and AutoMod quarantines waiting on a moderator's call."
        action={
          <Select
            className="w-auto min-w-[11rem]"
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
          </Select>
        }
      />

      <section className="border-t border-border-subtle pt-6">
        {reports.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<MessageSquare size={20} />}
            title="Nothing to review"
            description="No reports match this filter. When members flag content, it will queue up here for action."
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
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
                <li key={report.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-label text-text-primary">
                        {targetType.toUpperCase()} report on <span className="font-code">{targetId}</span>
                      </div>
                      <div className="font-code text-meta tabular-nums text-text-muted">
                        by {reporterName} · {createdLabel}
                      </div>
                      {isQuarantineReport && (
                        <div className="mt-1 text-section uppercase text-text-secondary">AutoMod quarantine review</div>
                      )}
                    </div>
                    <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-semibold uppercase text-text-secondary">
                      {report.status}
                    </span>
                  </div>

                  {report.reason && <div className="mt-2 text-[13.5px] text-text-secondary">{report.reason}</div>}

                  {evidence.length > 0 && (
                    <div className="mt-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-2">
                      <GroupLabel>Evidence</GroupLabel>
                      <div className="mt-1 space-y-1">
                        {evidence.map((item, idx) => (
                          <div key={`${report.id}-evidence-${idx}`} className="break-all font-code text-meta text-text-muted">
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
                          <Button size="sm" variant="secondary" onClick={() => void onResolveReport(report.id, 'approve')} disabled={reportResolvingId === report.id}>
                            Approve
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => void onResolveReport(report.id, 'reject')} disabled={reportResolvingId === report.id}>
                            Reject
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void onResolveReport(report.id, 'dismiss')} disabled={reportResolvingId === report.id}>
                            Dismiss
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => void onResolveReport(report.id, 'warn')} disabled={reportResolvingId === report.id}>
                            Warn
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => void onResolveReport(report.id, 'mute')} disabled={reportResolvingId === report.id}>
                            Mute (15m)
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="destructive" onClick={() => void onResolveReport(report.id, 'ban')} disabled={reportResolvingId === report.id}>
                        Ban
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SettingsPanel>
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

export function AuditLogSection({ auditEntries, members, channels, roles }: AuditLogSectionProps) {
  return (
    <SettingsPanel>
      <SectionHeader title="Audit Log" description="A running record of administrative actions in this server." />
      <section className="max-h-[calc(100dvh-20rem)] overflow-y-auto border-t border-border-subtle pt-2">
        {auditEntries.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<ScrollText size={20} />}
            title="Nothing logged yet"
            description="Role edits, bans, channel changes, and other admin actions will appear here as they happen."
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
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
                <li key={entry.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-label text-text-primary">{label}</span>
                    <span className="shrink-0 font-code text-meta tabular-nums text-text-muted">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 text-meta text-text-secondary">
                    by <span className="text-text-primary">{actorName}</span>
                    {targetDesc && (
                      <>
                        {' '}
                        on <span className="text-text-primary">{targetDesc}</span>
                      </>
                    )}
                  </div>
                  {entry.reason && <div className="mt-1 text-meta text-text-muted">Reason: {entry.reason}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SettingsPanel>
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
    patch: Partial<{ targetUserId: string; reason: string; dmMessage: string }>,
  ) => {
    setApplyDrafts((prev) => {
      const current = prev[templateId] ?? { targetUserId: '', reason: '', dmMessage: '' };
      return { ...prev, [templateId]: { ...current, ...patch } };
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
      setApplyDrafts((prev) => ({ ...prev, [templateId]: { targetUserId: '', reason: '', dmMessage: '' } }));
      setApplyStatus((prev) => ({ ...prev, [templateId]: 'Template applied.' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply template.';
      setApplyStatus((prev) => ({ ...prev, [templateId]: message }));
    } finally {
      setApplyingTemplateId(null);
    }
  }

  return (
    <SettingsPanel>
      <SectionHeader
        title="Mod Templates"
        description="Reusable warn / mute / kick / ban actions with pre-written reasons and DMs — apply them in one step."
      />

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>New template</GroupLabel>
        <div className="mt-4 grid gap-3">
          <Input
            aria-label="Template name"
            placeholder="Template name (e.g. Spam Warning)"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <FieldLabel>Action</FieldLabel>
              <Select aria-label="Action type" value={actionType} onChange={(e) => setActionType(Number(e.target.value))}>
                <option value={1}>Warn</option>
                <option value={2}>Timed Mute</option>
                <option value={3}>Kick</option>
                <option value={4}>Ban</option>
              </Select>
            </label>
            {needsDuration && (
              <label className="block">
                <FieldLabel>Duration (minutes)</FieldLabel>
                <Input
                  aria-label="Duration in minutes"
                  type="number"
                  min={1}
                  max={43200}
                  className="font-code tabular-nums"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <label className="block">
            <FieldLabel>
              Reason template <span className="normal-case tracking-normal text-text-muted">— {'{target}'}, {'{moderator}'}, {'{reason}'}</span>
            </FieldLabel>
            <Textarea
              className="min-h-[4rem] resize-y"
              aria-label="Reason template"
              placeholder="e.g. {target} was warned for spam."
              maxLength={500}
              value={reasonTemplate}
              onChange={(e) => setReasonTemplate(e.target.value)}
            />
          </label>
          <label className="block">
            <FieldLabel>
              DM template <span className="normal-case tracking-normal text-text-muted">— sent to the user</span>
            </FieldLabel>
            <Textarea
              className="min-h-[4rem] resize-y"
              aria-label="DM template"
              placeholder="e.g. You have been warned in {guild} for: {reason}"
              maxLength={500}
              value={dmTemplate}
              onChange={(e) => setDmTemplate(e.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={!name.trim() || saving} loading={saving} onClick={() => void handleCreate()}>
              Create template
            </Button>
          </div>
        </div>
      </section>

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>{templates.length > 0 ? `Templates · ${templates.length}` : 'Templates'}</GroupLabel>
        {templates.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Shield size={20} />}
            title="No templates yet"
            description="Build a template above and moderators can warn, mute, or ban with a consistent reason in a single click."
          />
        ) : (
          <ul className="mt-2 divide-y divide-border-subtle">
            {templates.map((template) => (
              <li key={template.id} className="py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                    <Shield size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-label text-text-primary">{template.name}</span>
                      <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-semibold text-text-secondary">
                        {ACTION_TYPE_LABELS[template.action_type] ?? `Type ${template.action_type}`}
                      </span>
                      {template.action_type === 2 && template.duration_minutes != null && (
                        <span className="font-code text-meta tabular-nums text-text-muted">{template.duration_minutes}m</span>
                      )}
                    </div>
                    {template.reason_template && (
                      <p className="mt-0.5 text-meta text-text-muted">Reason: {template.reason_template}</p>
                    )}
                    {template.dm_template && <p className="mt-0.5 text-meta text-text-muted">DM: {template.dm_template}</p>}
                  </div>
                  <button
                    className="icon-btn"
                    aria-label={`Delete moderation template ${template.name}`}
                    onClick={() => void onDeleteTemplate(template.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <form
                  className="mt-3 grid gap-2 border-t border-border-subtle pt-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleApply(template.id);
                  }}
                >
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <Input
                      aria-label={`Target user ID for ${template.name}`}
                      placeholder="Target user ID"
                      value={getApplyDraft(template.id).targetUserId}
                      onChange={(event) => updateApplyDraft(template.id, { targetUserId: event.target.value })}
                    />
                    <Input
                      aria-label={`Reason override for ${template.name}`}
                      placeholder="Reason override (optional)"
                      maxLength={500}
                      value={getApplyDraft(template.id).reason}
                      onChange={(event) => updateApplyDraft(template.id, { reason: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <Input
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
                      {applyingTemplateId === template.id ? 'Applying…' : 'Apply template'}
                    </Button>
                  </div>
                  {applyStatus[template.id] && (
                    <p className="text-meta text-text-muted" role="status">
                      {applyStatus[template.id]}
                    </p>
                  )}
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPanel>
  );
}
