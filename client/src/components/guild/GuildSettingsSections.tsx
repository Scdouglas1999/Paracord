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
import { Button, Chip, EmptyState, IconButton, Input, Select, Textarea } from '../ui';
import { BannerEditor } from '../user/BannerEditor';
import { guildApi } from '../../api/guilds';
import { clearAuthenticatedImageCache } from '../../lib/authenticatedImage';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { CustomEmojiImage } from '../ui/ResourceImage';
import { cn } from '../../lib/utils';
import { SectionHeader, GroupLabel, FieldLabel, ToggleRow, GateNotice } from './SettingsPrimitives';
import { displayName } from '../../lib/displayName';
import { UNSET_ROLE_COLOR } from '../../lib/colors';

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

// Shared section stack. Settings are ONE plate over the street (SettingsShell,
// spec §4) and every section renders inside it, so this is a bare rhythm
// wrapper — never a second surface. Depth inside comes from wells and raised
// rows; separation comes from hairline dividers, never from tiled cards.
/**
 * An invite's lifespan, in words.
 *
 * `max_age` is a duration in **seconds** straight off the wire. Printing it raw
 * put "86400" under an "Expires" heading, which reads as neither a date nor a
 * duration. Say when the link dies, counted from when it was made.
 */
export function inviteExpiryLabel(invite: Pick<Invite, 'max_age' | 'created_at'>, now = Date.now()): string {
  const seconds = invite.max_age ?? 0;
  if (seconds <= 0) return 'never';
  const created = Date.parse(invite.created_at);
  const remaining = Number.isFinite(created) ? (created + seconds * 1000 - now) / 1000 : seconds;
  if (remaining <= 0) return 'expired';
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    if (remaining >= size) {
      const count = Math.round(remaining / size);
      return `in ${count} ${name}${count === 1 ? '' : 's'}`;
    }
  }
  return 'in under a minute';
}

function SettingsPanel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8">{children}</div>;
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
  onBannerHashChange?: (hash: string | null) => void;
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
  onBannerHashChange = () => {},
}: OverviewSectionProps) {
  const isOwner = guild && authUserId && guild.owner_id === authUserId;
  // A readout that counts things says "1 Role", not "1 Roles". The strip was
  // printing the plural beside every number, including the ones that are
  // always 1 on a young building.
  const countLabel = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const stats: { label: string; value: number }[] = [
    { label: countLabel(members.length, 'Member', 'Members'), value: members.length },
    { label: countLabel(roles.length, 'Role', 'Roles'), value: roles.length },
    { label: countLabel(channels.length, 'Channel', 'Channels'), value: channels.length },
    { label: countLabel(invites.length, 'Active invite', 'Active invites'), value: invites.length },
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
            <Button onClick={onSave}>Save changes</Button>
          </div>
        }
      />

      {guild && (
        <BannerEditor
          label="Server banner"
          bannerHash={guild.banner_hash}
          outputWidth={1920}
          outputHeight={640}
          hint="Shown across the top of the server home. Saved right away as a 1920 by 640 image; PNG, JPEG, GIF, or WebP up to 8 MB."
          onUpload={async (file) => {
            const { data } = await guildApi.uploadBanner(guild.id, file);
            clearAuthenticatedImageCache();
            onBannerHashChange(data.banner_hash ?? null);
          }}
          onRemove={async () => {
            await guildApi.deleteBanner(guild.id);
            clearAuthenticatedImageCache();
            onBannerHashChange(null);
          }}
        />
      )}

      {/* Identity */}
      <section className="flex flex-col gap-6 border-t border-border-subtle pt-6 sm:flex-row sm:gap-8">
        <label className="group shrink-0 cursor-pointer">
          <input type="file" accept="image/*" className="hidden" onChange={onIconChange} />
          {/* The icon well: recessed, matte, no border-as-depth (§1.1). It is
              the SAME shape the building's mark is drawn in everywhere else —
              the Lobby header, the collapsed rail and Home all round it to
              --radius-card — so what you drop here is what you get. It asked
              for --radius-full until D2 made call-site radii bind, and a round
              crop of a square logo previewed a building nothing renders. */}
          <div className="pc-well flex h-24 w-24 flex-col items-center justify-center overflow-hidden rounded-[var(--radius-card)] transition-colors group-hover:bg-bg-mod-subtle">
            {iconDataUrl ? (
              <img src={iconDataUrl} alt="Server icon" className="h-full w-full object-cover" />
            ) : (
              <>
                <Upload size={20} className="text-text-muted" aria-hidden />
                <span className="mt-1 text-meta text-text-muted">Upload</span>
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

      {/* Stat strip — a read-only readout, so a well; not tiled cards. */}
      <section className="pc-well grid grid-cols-2 gap-y-4 divide-border-subtle px-5 py-4 sm:grid-cols-4 sm:divide-x">
        {stats.map((stat) => (
          <div key={stat.label} className="px-1 first:pl-0 sm:px-5 sm:first:pl-1">
            <div className="pc-mono text-title text-text-primary">{stat.value}</div>
            <div className="mt-0.5 text-meta text-text-muted">{stat.label}</div>
          </div>
        ))}
      </section>

      {isOwner && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Vanity invite</GroupLabel>
          <p className="mt-2 max-w-prose text-body leading-relaxed text-text-secondary">
            Give out a memorable invite path like{' '}
            <span className="pc-mono text-meta text-text-secondary">/your-server</span>. Leave blank to remove it.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Input
              aria-label="Vanity invite path"
              className="min-w-[16rem] flex-1 pc-mono"
              value={vanityCode}
              onChange={(e) => onVanityCodeChange(e.target.value)}
              placeholder="your-server"
              maxLength={32}
            />
            <Button variant="ghost" onClick={onSaveVanity} disabled={savingVanity} loading={savingVanity}>
              Save
            </Button>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Transfer ownership</GroupLabel>
          <p className="mt-2 max-w-prose text-body leading-relaxed text-text-secondary">
            Hand this server to another member. You'll immediately lose owner privileges — this can't be undone.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Select
              aria-label="New owner"
              className="min-w-[16rem] flex-1"
              value={ownershipTargetUserId}
              onChange={(e) => onOwnershipTargetChange(e.target.value)}
            >
              {ownershipCandidates.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {/* The disambiguator has to be something the person handing
                      over their building can recognize. A snowflake is not: it
                      told the owner "priya (357593456400404480)" and made them
                      guess. A username is unique on this server and is what
                      they already call each other. */}
                  {displayName(member.user, member.nick).toLowerCase() === member.user.username.toLowerCase()
                    ? `@${member.user.username}`
                    : `${displayName(member.user, member.nick)} (@${member.user.username})`}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              onClick={onTransferOwnership}
              disabled={transferringOwnership || !ownershipTargetUserId}
              loading={transferringOwnership}
            >
              Transfer
            </Button>
          </div>
        </section>
      )}

      {/* Danger is the danger WELL carrying danger ink (§1.3), never a red fill. */}
      {isOwner && (
        <section className="rounded-[var(--radius-well)] bg-danger-well p-5 shadow-[var(--shadow-well)]">
          <GroupLabel className="text-accent-danger">Danger zone</GroupLabel>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-label text-text-primary">Delete this server</div>
              <div className="mt-0.5 max-w-prose text-meta leading-relaxed text-text-secondary">
                Every channel, message, and upload is permanently erased. This cannot be undone.
              </div>
            </div>
            <Button variant="danger" onClick={onShowDeleteDialog}>
              Delete server
            </Button>
          </div>
          {showDeleteGuildDialog && guild && (
            <div className="mt-4 space-y-3 border-t border-border-strong pt-4">
              <div className="text-body leading-relaxed text-text-secondary">
                Type <span className="font-semibold text-text-primary">{guild.name}</span> to confirm.
              </div>
              <Input
                aria-label={`Type ${guild.name} to confirm deletion`}
                value={deleteGuildConfirmName}
                onChange={(e) => onDeleteGuildConfirmNameChange(e.target.value)}
                placeholder={guild.name}
                autoFocus
              />
              <div className="flex gap-2.5">
                <Button
                  variant="danger"
                  onClick={onDeleteGuild}
                  disabled={deletingGuild || deleteGuildConfirmName !== guild.name}
                  loading={deletingGuild}
                >
                  Delete permanently
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

// Mirrors `paracord_models::permissions::Permissions`. Every bit the server
// enforces has a switch here: a permission the matrix omits is one an admin can
// neither grant nor revoke, and half of them were missing — a role could not be
// given Manage Webhooks, Manage Emojis or Manage Nicknames from this screen at
// all, and View Channel could not be taken away.
//
// Flags are bigint: Use Soundboard is bit 42 (Discord's slot for it), which
// JavaScript `number` bitwise operators silently truncate to int32.
const PERMISSION_GROUPS: { group: string; perms: { name: string; flag: bigint }[] }[] = [
  {
    group: 'General',
    perms: [
      { name: 'Manage Channels', flag: 1n << 4n },
      { name: 'Manage Server', flag: 1n << 5n },
      { name: 'Manage Roles', flag: 1n << 28n },
      { name: 'Manage Webhooks', flag: 1n << 29n },
      { name: 'Manage Emojis', flag: 1n << 30n },
      { name: 'View Audit log', flag: 1n << 7n },
      { name: 'Create Invite', flag: 1n << 0n },
    ],
  },
  {
    group: 'Membership',
    perms: [
      { name: 'Kick Members', flag: 1n << 1n },
      { name: 'Ban Members', flag: 1n << 2n },
      { name: 'Change Nickname', flag: 1n << 26n },
      { name: 'Manage Nicknames', flag: 1n << 27n },
      { name: 'Administrator', flag: 1n << 3n },
    ],
  },
  {
    group: 'Text',
    perms: [
      { name: 'View Channel', flag: 1n << 10n },
      { name: 'Send Messages', flag: 1n << 11n },
      { name: 'Read Message History', flag: 1n << 16n },
      { name: 'Manage Messages', flag: 1n << 13n },
      { name: 'Attach Files', flag: 1n << 15n },
      { name: 'Embed Links', flag: 1n << 14n },
      { name: 'Add reactions', flag: 1n << 6n },
      { name: 'Use External Emojis', flag: 1n << 18n },
      { name: 'Mention Everyone', flag: 1n << 17n },
      { name: 'Send TTS Messages', flag: 1n << 12n },
    ],
  },
  {
    group: 'Voice',
    perms: [
      { name: 'Connect', flag: 1n << 20n },
      { name: 'Speak', flag: 1n << 21n },
      { name: 'Stream', flag: 1n << 9n },
      { name: 'Use Voice Activity', flag: 1n << 25n },
      { name: 'Priority Speaker', flag: 1n << 8n },
      { name: 'Use Soundboard', flag: 1n << 42n },
      { name: 'Mute Members', flag: 1n << 22n },
      { name: 'Deafen Members', flag: 1n << 23n },
      { name: 'Move Members', flag: 1n << 24n },
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
  editingRolePermissions: bigint;
  editingRoleColor: string;
  editingRoleHoist: boolean;
  editingRoleMentionable: boolean;
  onNewRoleNameChange: (v: string) => void;
  onNewRoleColorChange: (v: string) => void;
  onEditingRoleColorChange: (v: string) => void;
  onEditingRolePermissionsToggle: (flag: bigint) => void;
  onEditingRoleHoistChange: (v: boolean) => void;
  onEditingRoleMentionableChange: (v: boolean) => void;
  onCreateRole: () => void;
  onRenameRole: (roleId: string, name: string) => void;
  onStartEditingRole: (role: Role) => void;
  onSaveRoleEdits: () => void;
  onCancelRoleEditing: () => void;
  onDeleteRole: (roleId: string) => void;
  roleColorHex: (role: Role) => string;
  memberCountByRole?: Map<string, number>;
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
  memberCountByRole,
}: RolesSectionProps) {
  const newRoleInputRef = useRef<HTMLInputElement>(null);
  // The space's default role carries the id of the space itself. It is the
  // baseline every member holds, so it is listed and editable like any other —
  // only its name is fixed and it cannot be deleted.
  const defaultRole = roles.find((role) => role.id === guildId);

  return (
    <SettingsPanel>
      <SectionHeader
        title="Roles"
        description={`Roles bundle a color and a set of permissions. Everyone holds ${
          defaultRole?.name ?? 'the default role'
        }; layer more on top.`}
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
              className="pc-focusable h-[var(--h-control-phone)] w-[var(--h-control-phone)] shrink-0 cursor-pointer rounded-[var(--radius-control)] border-0 bg-transparent p-1"
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
        <GroupLabel>{roles.length > 0 ? `Roles · ${roles.length}` : 'Roles'}</GroupLabel>
        {roles.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Shield size={20} />}
            title="No roles yet"
            description="Add a role to grant colors, hoisting, and finer permissions."
            action={
              canManage ? (
                <Button variant="ghost" onClick={() => newRoleInputRef.current?.focus()}>
                  <Plus size={15} aria-hidden />
                  Name a role
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
              const memberCount = memberCountByRole?.get(role.id);
              return (
                <li key={role.id}>
                  <div className="group flex flex-wrap items-center gap-3 py-3">
                    <span
                      className="h-3 w-3 shrink-0 rounded-[var(--radius-full)] ring-1 ring-inset ring-border-strong"
                      style={{ backgroundColor: roleColor }}
                      aria-hidden
                    />
                    <input
                      className="pc-focusable min-w-0 flex-1 rounded-[var(--radius-control)] bg-transparent text-label text-text-primary outline-none disabled:cursor-default"
                      style={{ color: roleColor !== UNSET_ROLE_COLOR ? roleColor : undefined }}
                      defaultValue={role.name}
                      disabled={!canManage || isEveryone}
                      aria-label={`Role name for ${role.name}`}
                      onBlur={(e) => {
                        if (!canManage || isEveryone) return;
                        if (e.target.value !== role.name) onRenameRole(role.id, e.target.value);
                      }}
                    />
                    {isEveryone && <Chip size="sm">Everyone</Chip>}
                    {memberCount != null && (
                      <Chip size="sm">
                        {memberCount} {memberCount === 1 ? 'member' : 'members'}
                      </Chip>
                    )}
                    {role.hoist && <Chip size="sm">Hoisted</Chip>}
                    {canManage && (
                      <div className="flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => (isEditing ? onCancelRoleEditing() : onStartEditingRole(role))}
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </Button>
                        {/* The default role cannot be deleted — the server
                            refuses it — so it does not get a button that only
                            ever fails. Its name is fixed for the same reason. */}
                        {!isEveryone && (
                          <IconButton
                            label={`Delete role ${role.name}`}
                            tone="ghost"
                            onClick={() => onDeleteRole(role.id)}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        )}
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
                              className="pc-focusable h-[var(--h-control-phone)] w-[var(--h-control-phone)] cursor-pointer rounded-[var(--radius-control)] border-0 bg-transparent p-1"
                              aria-label="Role color"
                            />
                            <Input
                              aria-label="Role color hex"
                              value={editingRoleColor}
                              onChange={(e) => onEditingRoleColorChange(e.target.value)}
                              className="w-28 pc-mono"
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
                                checked={(editingRolePermissions & perm.flag) !== 0n}
                                onChange={() => onEditingRolePermissionsToggle(perm.flag)}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                      {/* The section's one emerald is "Create role" (§: one
                          primary action per screen); an inline row commit is
                          ghost. */}
                      <div className="flex items-center gap-2.5">
                        <Button variant="ghost" onClick={onSaveRoleEdits}>
                          Save changes
                        </Button>
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
  canKick: boolean;
  canBan: boolean;
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
  canKick,
  canBan,
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
    ? members.filter((m) => `${displayName(m.user, m.nick)} ${m.user.username}`.toLowerCase().includes(memberSearch.toLowerCase()))
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
        aria-label="Search members by name"
        placeholder="Search members by name"
        value={memberSearch}
        onChange={(e) => onMemberSearchChange(e.target.value)}
      />
      <section className="border-t border-border-subtle pt-2">
        {filteredMembers.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<Users size={20} />}
            title={memberSearch.trim() ? 'No member matches that search' : 'Nobody has joined yet'}
            description={
              memberSearch.trim()
                ? `Nobody in this server matches "${memberSearch.trim()}". Try part of a username instead.`
                : 'Hand out an invite from the Invites section and the people who accept show up here.'
            }
            action={
              memberSearch.trim() ? (
                <Button variant="ghost" onClick={() => onMemberSearchChange('')}>
                  Clear the search
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {filteredMembers.map((member) => (
              <li key={member.user.id}>
                <div className="group flex flex-wrap items-center gap-3 py-3">
                  <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-label font-semibold text-text-secondary">
                    {initialFor(displayName(member.user, member.nick))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-label text-text-primary">{displayName(member.user, member.nick)}</span>
                    {displayName(member.user, member.nick) !== member.user.username && <span className="text-meta text-text-muted">@{member.user.username}</span>}
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
                            <Chip key={roleId} size="sm" style={{ color: rColor }}>
                              <span
                                className="h-2 w-2 rounded-[var(--radius-full)]"
                                style={{ backgroundColor: rColor }}
                                aria-hidden
                              />
                              {role.name}
                            </Chip>
                          );
                        })}
                    </div>
                  )}
                  <div className="flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
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
                    {canKick && (
                      <Button variant="ghost" size="sm" onClick={() => onKickMember(member.user.id)}>
                        Kick
                      </Button>
                    )}
                    {canBan && (
                      <Button variant="danger" size="sm" onClick={() => onShowBanConfirm(member.user.id)}>
                        Ban
                      </Button>
                    )}
                  </div>
                </div>
                {banConfirmUserId === member.user.id && (
                  <div className="mb-3 ml-12 space-y-2.5 rounded-[var(--radius-well)] bg-danger-well p-4 shadow-[var(--shadow-well)]">
                    <p className="text-label text-accent-danger">
                      Ban {displayName(member.user, member.nick)}?
                    </p>
                    <Input
                      type="text"
                      aria-label={`Reason for banning ${displayName(member.user, member.nick)}`}
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
                      <Button variant="danger" size="sm" onClick={() => onBanMember(member.user.id, banReasonInput)}>
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
                      <p className="text-body leading-relaxed text-text-secondary">
                        There are no roles to assign yet — create one in the Roles section first.
                      </p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {assignableRoles.map((role) => {
                          const checked = draftMemberRoleIds.includes(role.id);
                          return (
                            <label
                              key={role.id}
                              className={cn(
                                'flex min-h-[var(--h-list-row)] cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-label transition-colors',
                                checked
                                  ? 'bg-bg-raised text-text-primary shadow-[var(--shadow-raised)]'
                                  : 'text-text-secondary hover:bg-bg-mod-subtle',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => onToggleDraftRoleId(role.id)}
                                className="pc-checkbox"
                              />
                              <span
                                className="h-2.5 w-2.5 rounded-[var(--radius-full)]"
                                style={{ backgroundColor: roleColorHex(role) }}
                                aria-hidden
                              />
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
  /** Whether this member may read the space's invite list at all. */
  canListInvites: boolean;
  onCreateInvite: () => void;
  onRevokeInvite: (code: string) => void;
}

export function InvitesSection({
  invites,
  canListInvites,
  onCreateInvite,
  onRevokeInvite,
}: InvitesSectionProps) {
  return (
    <SettingsPanel>
      <SectionHeader
        title="Invites"
        description={
          canListInvites
            ? 'Share these links to bring people in. Revoke any that leak or outlive their purpose.'
            : 'Make a link to bring people in. The full list belongs to the people who manage this server.'
        }
        action={
          <Button onClick={onCreateInvite}>
            <Plus size={15} aria-hidden />
            Create invite
          </Button>
        }
      />
      <section className="border-t border-border-subtle pt-6">
        {/* Anyone who can create an invite reaches this section, but listing a
            space's invites needs Manage Space — that request comes back 403 and
            leaves `invites` empty. Saying "no invite links yet" to someone who
            simply cannot see them is a lie; say what is actually true. */}
        {!canListInvites ? (
          <EmptyState
            className="!py-8"
            icon={<LinkIcon size={20} />}
            title="Existing links are not yours to see"
            description="You can make a link and hand it out. Seeing every link this server has — and revoking them — needs Manage Server."
            action={
              <Button variant="ghost" onClick={onCreateInvite}>
                <Plus size={15} aria-hidden />
                Make a link
              </Button>
            }
          />
        ) : invites.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<LinkIcon size={20} />}
            title="No invite links yet"
            description="Generate a link and hand it out — you can cap its uses and lifespan later."
            action={
              <Button variant="ghost" onClick={onCreateInvite}>
                <Plus size={15} aria-hidden />
                Generate the first link
              </Button>
            }
          />
        ) : (
          <>
            <div className="hidden items-center gap-3 border-b border-border-subtle pb-2 text-section text-text-faint sm:flex">
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
                  <span className="flex-1 pc-mono text-label text-text-primary">{invite.code}</span>
                  <span className="pc-mono text-meta text-text-muted sm:w-24">
                    {invite.uses}/{invite.max_uses || '∞'}
                  </span>
                  <span className="pc-mono text-meta text-text-muted sm:w-28">
                    {inviteExpiryLabel(invite)}
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    className="sm:opacity-0 sm:transition-opacity sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
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
  const newEmojiInputRef = useRef<HTMLInputElement>(null);
  // Each emoji thumbnail is an authenticated image; re-render when the
  // download ticket its URL needs is minted.
  useDownloadTicket();
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
              ref={newEmojiInputRef}
              aria-label="New emoji name"
              placeholder="emoji_name"
              value={newEmojiName}
              maxLength={32}
              onChange={(e) => onNewEmojiNameChange(e.target.value)}
            />
            <label className="pc-well inline-flex h-[var(--h-control-phone)] cursor-pointer items-center justify-center px-3.5 text-label text-text-secondary transition-colors hover:text-text-primary focus-within:shadow-[var(--shadow-well),var(--focus-ring)]">
              <input
                type="file"
                accept="image/png,image/gif"
                aria-label="Emoji image file"
                className="sr-only"
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
              <Upload size={15} aria-hidden />
              Upload
            </Button>
          </div>
          <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-muted">
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
            action={
              canManage ? (
                <Button variant="ghost" onClick={() => newEmojiInputRef.current?.focus()}>
                  Add an emoji
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {emojis
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((emoji) => {
                const editing = editingEmojiId === emoji.id;
                return (
                  <div key={emoji.id} className="pc-well group flex items-start gap-3 p-3">
                    <CustomEmojiImage
                      guildId={guildId}
                      emojiId={emoji.id}
                      alt={emoji.name}
                      className="h-11 w-11 shrink-0 rounded-[var(--radius-chip)] bg-bg-raised object-contain p-1"
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
                      <p className="mt-1 truncate pc-mono text-meta text-text-muted">
                        &lt;{emoji.animated ? 'a' : ''}:{emoji.name}:{emoji.id}&gt;
                      </p>
                      {canManage && (
                        <div className="mt-2.5 flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                          {editing ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => onSaveEmojiName(emoji.id)}>
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
                          <Button variant="danger" size="sm" onClick={() => onDeleteEmoji(emoji.id)}>
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
  const newWebhookInputRef = useRef<HTMLInputElement>(null);
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
                ref={newWebhookInputRef}
                aria-label="Webhook name"
                placeholder="Webhook name"
                value={newWebhookName}
                maxLength={80}
                onChange={(e) => onNewWebhookNameChange(e.target.value)}
              />
              <Select
                aria-label="Channel the webhook posts into"
                value={newWebhookChannelId}
                onChange={(e) => onNewWebhookChannelChange(e.target.value)}
              >
                {textChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name || 'unnamed'}
                  </option>
                ))}
              </Select>
              <Button onClick={onCreateWebhook} disabled={!newWebhookName.trim()}>
                <Plus size={15} aria-hidden />
                Create
              </Button>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-meta text-text-muted">
              <span className="text-section text-text-faint">Filter</span>
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
            action={
              canManage ? (
                <Button variant="ghost" onClick={() => newWebhookInputRef.current?.focus()}>
                  Name a webhook
                </Button>
              ) : undefined
            }
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
                          aria-label={`Rename webhook ${webhook.name}`}
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
                      <Chip size="sm">#{channelNameById.get(webhook.channel_id) || 'unknown'}</Chip>
                      <span className="pc-mono text-meta text-text-muted">Created {createdLabel}</span>
                    </div>

                    {/* A read-only readout is a well (§1.1), never a bordered box. */}
                    <div className="pc-well px-3 py-2 text-meta">
                      {issuedToken ? (
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="min-w-0 flex-1 truncate pc-mono text-text-secondary">
                            {buildWebhookExecuteUrl(webhook.id, issuedToken)}
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => onCopyWebhookUrl(webhook.id)}>
                            <Copy size={13} aria-hidden />
                            {copiedWebhookId === webhook.id ? 'Copied' : 'Copy URL'}
                          </Button>
                        </div>
                      ) : (
                        <span className="leading-relaxed text-text-muted">
                          Token hidden. Recreate this webhook to capture its execute URL.
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {editing ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => onSaveWebhookName(webhook.id)}>
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
                      <Button variant="danger" size="sm" onClick={() => onDeleteWebhook(webhook.id)}>
                        Delete
                      </Button>
                    </div>

                    {issuedToken && (
                      <div className="pc-well px-3 py-2.5">
                        <GroupLabel>Test execute</GroupLabel>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Input
                            className="min-w-[14rem] flex-1"
                            aria-label={`Test message for ${webhook.name}`}
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
                            variant="ghost"
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
              <Select
                aria-label="One of your developer apps"
                value={selectedOwnBotId}
                onChange={(e) => onSelectedOwnBotIdChange(e.target.value)}
              >
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
                aria-label="Third-party application ID"
                placeholder="Third-party application ID"
                value={addBotId}
                onChange={(e) => onAddBotIdChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addBotId.trim()) onAddBotById();
                }}
              />
              <Button variant="ghost" onClick={onAddBotById} disabled={!addBotId.trim()}>
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
                <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center text-text-secondary">
                  <Bot size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="pc-display text-name text-text-primary">{entry.application.name}</p>
                  {entry.application.description && (
                    <p className="truncate text-meta text-text-muted">{entry.application.description}</p>
                  )}
                  <p className="pc-mono text-meta text-text-muted">
                    Added {new Date(entry.install.created_at).toLocaleDateString()}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="danger"
                    size="sm"
                    className="sm:opacity-0 sm:transition-opacity sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                    onClick={() => onRemoveBot(entry.application.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {nativeBotEntries.map((entry) => (
              <li key={`native-${entry.id}`} className="group flex flex-wrap items-center gap-3 py-3">
                <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center text-text-secondary">
                  <Bot size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="pc-display text-name text-text-primary">{entry.name}</p>
                    <Chip size="sm">Built in</Chip>
                  </div>
                  <p className="truncate text-meta text-text-muted">{entry.description}</p>
                </div>
                {canManage && (
                  <Button
                    variant="danger"
                    size="sm"
                    className="sm:opacity-0 sm:transition-opacity sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
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
            title="Nobody is banned"
            description="When you ban a member their entry lands here, where you can review the reason or lift it."
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {bans.map((ban) => (
              <li key={ban.user.id} className="group flex flex-wrap items-center gap-3 py-3">
                <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-label font-semibold text-text-secondary">
                  {initialFor(displayName(ban.user))}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block text-label text-text-primary">{displayName(ban.user)}</span>
                  {ban.reason && (
                    <span className="text-meta leading-relaxed text-text-muted">{ban.reason}</span>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => void onUnban(ban.user.id)}>
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
            aria-label="Filter reports by status"
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
            title="The review queue is clear"
            description="No reports match this filter. When a member flags a message or AutoMod quarantines one, it queues up here for a moderator's call."
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {reports.map((report) => {
              const changes = (report.changes || {}) as Record<string, unknown>;
              const isQuarantineReport = String(changes.report_kind || '') === 'automod_quarantine';
              const targetType = String(changes.target_type || 'unknown');
              const targetId = String(changes.target_id || report.target_id || 'unknown');
              const reporter = members.find((member) => member.user.id === report.reporter_id);
              const reporterName = reporter ? displayName(reporter.user, reporter.nick) : report.reporter_id;
              const createdLabel = new Date(report.created_at).toLocaleString();
              const evidence = Array.isArray(changes.evidence)
                ? changes.evidence.filter((item): item is string => typeof item === 'string')
                : [];

              return (
                <li key={report.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-label text-text-primary">
                        <span className="capitalize">{targetType}</span> report on{' '}
                        <span className="pc-mono">{targetId}</span>
                      </div>
                      <div className="pc-mono text-meta text-text-muted">
                        by {reporterName} · {createdLabel}
                      </div>
                      {isQuarantineReport && (
                        <div className="mt-1 text-section text-text-faint">AutoMod quarantine review</div>
                      )}
                    </div>
                    <Chip size="sm" className="capitalize">
                      {report.status}
                    </Chip>
                  </div>

                  {report.reason && (
                    <div className="mt-2 max-w-prose text-body leading-relaxed text-text-secondary">
                      {report.reason}
                    </div>
                  )}

                  {evidence.length > 0 && (
                    <div className="pc-well mt-2 px-2.5 py-2">
                      <GroupLabel>Evidence</GroupLabel>
                      <div className="mt-1 space-y-1">
                        {evidence.map((item, idx) => (
                          <div key={`${report.id}-evidence-${idx}`} className="break-all pc-mono text-meta text-text-muted">
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
                          <Button size="sm" variant="ghost" onClick={() => void onResolveReport(report.id, 'approve')} disabled={reportResolvingId === report.id}>
                            Approve
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void onResolveReport(report.id, 'reject')} disabled={reportResolvingId === report.id}>
                            Reject
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void onResolveReport(report.id, 'dismiss')} disabled={reportResolvingId === report.id}>
                            Dismiss
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void onResolveReport(report.id, 'warn')} disabled={reportResolvingId === report.id}>
                            Warn
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void onResolveReport(report.id, 'mute')} disabled={reportResolvingId === report.id}>
                            Mute (15m)
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="danger" onClick={() => void onResolveReport(report.id, 'ban')} disabled={reportResolvingId === report.id}>
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
  loadError?: string | null;
  actionFilter?: string;
  userFilter?: string;
  onActionFilterChange?: (value: string) => void;
  onUserFilterChange?: (value: string) => void;
}

/// Every `ACTION_*` constant in `crates/paracord-api/src/routes/audit.rs`.
///
/// Eight were missing, so a log full of webhook, emoji and AutoMod activity read
/// as "Action 50", "Action 60", "Action 100" — and because the filter dropdown
/// is built from this same map, those entries could not be filtered for either.
/// Adding a constant on the server means adding it here.
export const ACTION_LABELS: Record<number, string> = {
  1: 'Server Updated',
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
  50: 'Webhook Created',
  51: 'Webhook Updated',
  52: 'Webhook Deleted',
  60: 'Emoji Created',
  61: 'Emoji Renamed',
  62: 'Emoji Deleted',
  71: 'Message Edited',
  72: 'Message Deleted',
  73: 'Messages Bulk Deleted',
  80: 'Bot Added',
  81: 'Bot Removed',
  90: 'Report Created',
  91: 'Report Resolved',
  100: 'AutoMod Rule Created',
  101: 'AutoMod Rule Updated',
  102: 'AutoMod Rule Deleted',
  103: 'AutoMod Acted',
};

export function AuditLogSection({
  auditEntries,
  members,
  channels,
  roles,
  loadError,
  actionFilter = '',
  userFilter = '',
  onActionFilterChange,
  onUserFilterChange,
}: AuditLogSectionProps) {
  return (
    <SettingsPanel>
      <SectionHeader title="Audit log" description="A running record of administrative actions in this server." />
      {(onActionFilterChange || onUserFilterChange) && (
        <div className="flex flex-wrap gap-3 border-t border-border-subtle pt-4">
          {onActionFilterChange && (
            <label className="block min-w-[12rem] flex-1">
              <FieldLabel>Action</FieldLabel>
              <Select
                value={actionFilter}
                onChange={(e) => onActionFilterChange(e.target.value)}
              >
                <option value="">All actions</option>
                {Object.entries(ACTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {onUserFilterChange && (
            <label className="block min-w-[12rem] flex-1">
              <FieldLabel>Actor</FieldLabel>
              <Select
                value={userFilter}
                onChange={(e) => onUserFilterChange(e.target.value)}
              >
                <option value="">Anyone</option>
                {members.map((member) => (
                  <option key={member.user.id} value={member.user.id}>
                    {displayName(member.user, member.nick)}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
      {loadError && <GateNotice>{loadError}</GateNotice>}
      <section className="max-h-[calc(100dvh-20rem)] overflow-y-auto border-t border-border-subtle pt-2">
        {auditEntries.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<ScrollText size={20} />}
            title={loadError ? 'Could not load the audit log' : 'No admin actions yet'}
            description={
              loadError
                ? 'You may lack the View Audit log permission, or the request failed. Refresh and try again.'
                : 'Role edits, bans, channel changes, and other admin actions will appear here as they happen.'
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {auditEntries.map((entry) => {
              const label = ACTION_LABELS[entry.action_type] || `Action ${entry.action_type}`;
              const actor = members.find((member) => member.user.id === entry.user_id);
              const actorName = actor ? displayName(actor.user, actor.nick) : entry.user_id;
              const targetDesc = entry.target_id
                ? (() => {
                    const targetChannel = channels.find((channel) => channel.id === entry.target_id);
                    if (targetChannel) return `#${targetChannel.name}`;
                    const targetMember = members.find((member) => member.user.id === entry.target_id);
                    if (targetMember) return displayName(targetMember.user, targetMember.nick);
                    const targetRole = roles.find((role) => role.id === entry.target_id);
                    if (targetRole) return `@${targetRole.name}`;
                    return entry.target_id;
                  })()
                : null;

              return (
                <li key={entry.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-label text-text-primary">{label}</span>
                    <span className="shrink-0 pc-mono text-meta text-text-muted">
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
                  {entry.reason && (
                    <div className="mt-1 text-meta leading-relaxed text-text-muted">
                      Reason: {entry.reason}
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
  const newTemplateInputRef = useRef<HTMLInputElement>(null);

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
        title="Mod templates"
        description="Reusable warn / mute / kick / ban actions with pre-written reasons and DMs — apply them in one step."
      />

      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>New template</GroupLabel>
        <div className="mt-4 grid gap-3">
          <Input
            ref={newTemplateInputRef}
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
                <option value={2}>Timed mute</option>
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
                  className="pc-mono"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <label className="block">
            <FieldLabel>
              Reason template <span className="text-text-muted">— {'{target}'}, {'{moderator}'}, {'{reason}'}</span>
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
              DM template <span className="text-text-muted">— sent to the user</span>
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
            action={
              <Button variant="ghost" onClick={() => newTemplateInputRef.current?.focus()}>
                Start a template
              </Button>
            }
          />
        ) : (
          <ul className="mt-2 divide-y divide-border-subtle">
            {templates.map((template) => (
              <li key={template.id} className="py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center text-text-secondary">
                    <Shield size={16} aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="pc-display text-name text-text-primary">{template.name}</span>
                      <Chip size="sm">
                        {ACTION_TYPE_LABELS[template.action_type] ?? `Type ${template.action_type}`}
                      </Chip>
                      {template.action_type === 2 && template.duration_minutes != null && (
                        <span className="pc-mono text-meta text-text-muted">{template.duration_minutes}m</span>
                      )}
                    </div>
                    {template.reason_template && (
                      <p className="mt-0.5 text-meta leading-relaxed text-text-muted">
                        Reason: {template.reason_template}
                      </p>
                    )}
                    {template.dm_template && (
                      <p className="mt-0.5 text-meta leading-relaxed text-text-muted">
                        DM: {template.dm_template}
                      </p>
                    )}
                  </div>
                  <IconButton
                    label={`Delete moderation template ${template.name}`}
                    tone="ghost"
                    onClick={() => void onDeleteTemplate(template.id)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
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
                      variant="ghost"
                      size="sm"
                      disabled={!getApplyDraft(template.id).targetUserId.trim() || applyingTemplateId !== null}
                    >
                      {applyingTemplateId === template.id ? 'Applying…' : 'Apply template'}
                    </Button>
                  </div>
                  {applyStatus[template.id] && (
                    <p className="text-meta leading-relaxed text-text-muted" role="status">
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
