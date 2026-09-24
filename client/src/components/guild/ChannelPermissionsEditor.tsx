import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey } from '../../lib/serverScope';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, Trash2, Plus, User, RotateCcw } from 'lucide-react';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import type { ChannelOverwrite, Role, Member } from '../../types';
import { Permissions } from '../../types';
import { cn } from '../../lib/utils';
import { useMemberStore } from '../../stores/memberStore';
import {
  Button,
  Divider,
  EmptyState,
  ErrorBanner,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
  Select,
  Tabs,
  Well,
} from '../ui';
import { GroupLabel } from './SettingsPrimitives';
import { displayName } from '../../lib/displayName';

const EMPTY_MEMBERS: Member[] = [];

interface ChannelPermissionsEditorProps {
  channelId: string;
  channelName: string;
  roles: Role[];
  guildId: string;
  onClose: () => void;
}

type PermKey = keyof typeof Permissions;

// Overrides grouped by category — headed with --text-section labels and divided,
// never tiled as identical cards (kill-list #5).
const PERMISSION_GROUPS: { group: string; perms: { key: PermKey; label: string }[] }[] = [
  {
    group: 'General',
    perms: [
      { key: 'VIEW_CHANNEL', label: 'View Channel' },
      { key: 'MANAGE_CHANNELS', label: 'Manage Channel' },
    ],
  },
  {
    group: 'Messages',
    perms: [
      { key: 'SEND_MESSAGES', label: 'Send Messages' },
      { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History' },
      { key: 'ATTACH_FILES', label: 'Attach Files' },
      { key: 'EMBED_LINKS', label: 'Embed Links' },
      { key: 'ADD_REACTIONS', label: 'Add reactions' },
      { key: 'MANAGE_MESSAGES', label: 'Manage Messages' },
      { key: 'MENTION_EVERYONE', label: 'Mention Everyone' },
      { key: 'USE_EXTERNAL_EMOJIS', label: 'Use External Emojis' },
    ],
  },
  {
    group: 'Voice',
    perms: [
      { key: 'CONNECT', label: 'Connect' },
      { key: 'SPEAK', label: 'Speak' },
      { key: 'MUTE_MEMBERS', label: 'Mute Members' },
      { key: 'DEAFEN_MEMBERS', label: 'Deafen Members' },
      { key: 'MOVE_MEMBERS', label: 'Move Members' },
      { key: 'USE_SOUNDBOARD', label: 'Use Soundboard' },
    ],
  },
];

function permissionEditorError(action: string, err: unknown): string {
  return `${action}: ${extractApiError(err)}`;
}

type PermState = 'allow' | 'deny' | 'inherit';

function computePermState(flag: bigint, allow: bigint, deny: bigint): PermState {
  if ((allow & flag) === flag) return 'allow';
  if ((deny & flag) === flag) return 'deny';
  return 'inherit';
}

// Overwrite bitsets are kept as bigint internally. Accepting `string | number`
// keeps the read path lossless if the API ever transports i64 values as strings
// (values above 2^53 survive), while preserving the current numeric behavior.
function permsToBigInt(value: number | string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

// The channel-overwrite REST endpoint accepts i64 permission bitsets as JSON
// numbers, so bigint state is narrowed at this boundary only. Every permission
// bit the server defines fits within Number.MAX_SAFE_INTEGER, so this is
// lossless for all valid overwrites.
function permsToWire(value: bigint): number {
  return Number(value);
}

const ALL_DEFINED_PERMISSIONS = Object.values(Permissions).reduce(
  (all, permission) => all | permission,
  0n,
);

function applyOverwrite(base: bigint, allow: bigint, deny: bigint): bigint {
  return (base & ~deny) | allow;
}

interface EditingOverwrite {
  targetId: string;
  targetType: number;
  allow: bigint;
  deny: bigint;
}

const PERM_STATES: { value: PermState; label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'inherit', label: 'Inherit' },
  { value: 'allow', label: 'Allow' },
];

export function ChannelPermissionsEditor({
  channelId,
  channelName,
  roles,
  guildId,
  onClose,
}: ChannelPermissionsEditorProps) {
  const [overwrites, setOverwrites] = useState<ChannelOverwrite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedOverwriteId, setSelectedOverwriteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingOverwrite | null>(null);
  const [addTargetId, setAddTargetId] = useState('');
  const [targetMode, setTargetMode] = useState<'role' | 'member'>('role');
  const [memberSearch, setMemberSearch] = useState('');

  const memberScope = useCurrentAccountScope();
  const { members, fetchMembers, membersLoaded } = useMemberStore();
  const guildMembers = (memberScope ? members.get(memberScopeKey(memberScope, guildId)) : undefined) ?? EMPTY_MEMBERS;

  useEffect(() => {
    if (memberScope && !membersLoaded[memberScopeKey(memberScope, guildId)]) {
      void fetchMembers(guildId, memberScope);
    }
  }, [guildId, membersLoaded, fetchMembers, memberScope]);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return guildMembers.slice(0, 20);
    const q = memberSearch.toLowerCase();
    return guildMembers
      .filter(
        (m) =>
          m.user.username.toLowerCase().includes(q) ||
          displayName(m.user, m.nick).toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [guildMembers, memberSearch]);

  const getMemberName = (userId: string) => {
    const member = guildMembers.find((m) => m.user.id === userId);
    if (member) return displayName(member.user, member.nick);
    return `User ${userId.slice(0, 6)}`;
  };

  const memberRoleId = guildId;
  const assignableRoles = roles.filter((r) => r.id !== memberRoleId);
  // Include @everyone (member role) at the top
  const everyoneRole = roles.find((r) => r.id === memberRoleId);
  const displayRoles = everyoneRole
    ? [everyoneRole, ...assignableRoles]
    : assignableRoles;

  const loadOverwrites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await channelApi.getOverwrites(channelId);
      setOverwrites(data);
    } catch (err) {
      setError(permissionEditorError('Failed to load permission overwrites', err));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void loadOverwrites();
  }, [loadOverwrites]);

  const startEditing = (ow: ChannelOverwrite) => {
    setSelectedOverwriteId(ow.target_id);
    setEditing({
      targetId: ow.target_id,
      targetType: ow.target_type,
      allow: permsToBigInt(ow.allow_perms),
      deny: permsToBigInt(ow.deny_perms),
    });
  };

  const applyPermState = (flag: bigint, next: PermState) => {
    if (!editing) return;
    let nextAllow = editing.allow;
    let nextDeny = editing.deny;
    if (next === 'allow') {
      nextAllow |= flag;
      nextDeny &= ~flag;
    } else if (next === 'deny') {
      nextDeny |= flag;
      nextAllow &= ~flag;
    } else {
      nextAllow &= ~flag;
      nextDeny &= ~flag;
    }
    setEditing({ ...editing, allow: nextAllow, deny: nextDeny });
  };

  const resetOverrides = () => {
    if (!editing) return;
    setEditing({ ...editing, allow: 0n, deny: 0n });
  };

  const hasOverrides = editing ? editing.allow !== 0n || editing.deny !== 0n : false;

  const effectivePreview = useMemo(() => {
    if (!editing) return null;
    const everyonePermissions = everyoneRole ? permsToBigInt(everyoneRole.permissions) : 0n;
    const targetRoleIds = editing.targetType === 0
      ? (editing.targetId === guildId ? [] : [editing.targetId])
      : guildMembers.find((member) => member.user.id === editing.targetId)?.roles ?? [];
    let base = everyonePermissions;
    for (const roleId of targetRoleIds) {
      const role = roles.find((candidate) => candidate.id === roleId);
      if (role) base |= permsToBigInt(role.permissions);
    }

    const administrator = (base & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR;
    if (administrator) {
      return {
        permissions: ALL_DEFINED_PERMISSIONS,
        administrator: true,
        missingMemberRoles: false,
      };
    }

    const overwriteBits = (overwrite: ChannelOverwrite) =>
      overwrite.target_id === editing.targetId
        ? { allow: editing.allow, deny: editing.deny }
        : {
            allow: permsToBigInt(overwrite.allow_perms),
            deny: permsToBigInt(overwrite.deny_perms),
          };
    const everyoneOverwrite = overwrites.find(
      (overwrite) => overwrite.target_type === 0 && overwrite.target_id === guildId,
    );
    if (everyoneOverwrite) {
      const bits = overwriteBits(everyoneOverwrite);
      base = applyOverwrite(base, bits.allow, bits.deny);
    }

    if (editing.targetType === 0 && editing.targetId !== guildId) {
      const roleOverwrite = overwrites.find(
        (overwrite) => overwrite.target_type === 0 && overwrite.target_id === editing.targetId,
      );
      if (roleOverwrite) {
        const bits = overwriteBits(roleOverwrite);
        base = applyOverwrite(base, bits.allow, bits.deny);
      }
    }

    if (editing.targetType === 1) {
      let roleAllow = 0n;
      let roleDeny = 0n;
      for (const overwrite of overwrites) {
        if (overwrite.target_type !== 0 || !targetRoleIds.includes(overwrite.target_id)) continue;
        const bits = overwriteBits(overwrite);
        roleAllow |= bits.allow;
        roleDeny |= bits.deny;
      }
      base = applyOverwrite(base, roleAllow, roleDeny);
      const memberOverwrite = overwrites.find(
        (overwrite) => overwrite.target_type === 1 && overwrite.target_id === editing.targetId,
      );
      if (memberOverwrite) {
        const bits = overwriteBits(memberOverwrite);
        base = applyOverwrite(base, bits.allow, bits.deny);
      }
    }

    return {
      permissions: base,
      administrator: false,
      missingMemberRoles:
        editing.targetType === 1
        && !guildMembers.some((member) => member.user.id === editing.targetId),
    };
  }, [editing, everyoneRole, guildId, guildMembers, overwrites, roles]);

  const previewAllowedCount = effectivePreview
    ? PERMISSION_GROUPS.flatMap((group) => group.perms).filter(
        ({ key }) => (effectivePreview.permissions & Permissions[key]) === Permissions[key],
      ).length
    : 0;
  const previewPermissionCount = PERMISSION_GROUPS.reduce((count, group) => count + group.perms.length, 0);

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await channelApi.upsertOverwrite(channelId, editing.targetId, {
        target_type: editing.targetType,
        allow_perms: permsToWire(editing.allow),
        deny_perms: permsToWire(editing.deny),
      });
      await loadOverwrites();
      setEditing(null);
      setSelectedOverwriteId(null);
    } catch (err) {
      setError(permissionEditorError('Failed to save overwrite', err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (targetId: string) => {
    setSaving(true);
    setError(null);
    try {
      await channelApi.deleteOverwrite(channelId, targetId);
      if (selectedOverwriteId === targetId) {
        setSelectedOverwriteId(null);
        setEditing(null);
      }
      await loadOverwrites();
    } catch (err) {
      setError(permissionEditorError('Failed to delete overwrite', err));
    } finally {
      setSaving(false);
    }
  };

  const handleAddTarget = async (targetId: string, targetType: number) => {
    if (!targetId) return;
    const alreadyExists = overwrites.some((ow) => ow.target_id === targetId);
    if (alreadyExists) {
      const existing = overwrites.find((ow) => ow.target_id === targetId)!;
      startEditing(existing);
      setAddTargetId('');
      setMemberSearch('');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await channelApi.upsertOverwrite(channelId, targetId, {
        target_type: targetType,
        allow_perms: 0,
        deny_perms: 0,
      });
      await loadOverwrites();
      setEditing({
        targetId,
        targetType,
        allow: 0n,
        deny: 0n,
      });
      setSelectedOverwriteId(targetId);
      setAddTargetId('');
      setMemberSearch('');
    } catch (err) {
      setError(permissionEditorError(`Failed to add ${targetType === 0 ? 'role' : 'member'} overwrite`, err));
    } finally {
      setSaving(false);
    }
  };

  const getTargetName = (targetId: string, targetType: number) => {
    if (targetType === 1) return getMemberName(targetId);
    if (targetId === guildId) return '@everyone';
    const role = roles.find((r) => r.id === targetId);
    return role?.name ?? `Role ${targetId.slice(0, 6)}`;
  };

  // A role's own colour is data, not design (spec §1 exception): the hex comes
  // from the role, and a role with no colour falls back to a text token.
  const getRoleColor = (targetId: string) => {
    const role = roles.find((r) => r.id === targetId);
    return role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)';
  };

  const availableRolesToAdd = displayRoles.filter(
    (r) => !overwrites.some((ow) => ow.target_id === r.id)
  );

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="channel-permissions-title"
      panelClassName="w-full max-w-3xl"
    >
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4">
          <div className="pc-well flex h-9 w-9 shrink-0 items-center justify-center text-text-secondary">
            <Shield size={18} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="channel-permissions-title" className="pc-display text-title text-text-primary">
              Permissions
            </h2>
            <div className="pc-mono truncate text-meta text-text-faint">#{channelName}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <Divider />

        <div className="flex max-h-[78vh] min-h-[20rem] flex-col sm:max-h-[70vh] sm:flex-row">
          {/* Left panel: list of overwrites */}
          <div className="flex max-h-[42vh] w-full shrink-0 flex-col sm:max-h-none sm:w-56">
            <div className="flex flex-col gap-1.5 px-3 pb-2 pt-3">
              <GroupLabel className="px-1">Overrides</GroupLabel>
              {loading ? (
                <LoadingSpinner size="sm" className="justify-start px-1 py-1.5" label="Loading overrides…" />
              ) : overwrites.length === 0 ? (
                <p className="px-1 text-meta leading-relaxed text-text-secondary">
                  #{channelName} follows the space-wide roles. Add a role or member below to change
                  what they can do in here.
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {overwrites.map((ow) => (
                    <button
                      key={ow.target_id}
                      onClick={() => startEditing(ow)}
                      aria-pressed={selectedOverwriteId === ow.target_id}
                      className={cn(
                        'pc-focusable flex h-[var(--h-list-row)] w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left',
                        'text-label transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                        selectedOverwriteId === ow.target_id
                          ? 'bg-bg-raised font-semibold text-text-primary shadow-[var(--shadow-raised)]'
                          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                      )}
                    >
                      {ow.target_type === 1 ? (
                        <User size={13} className="shrink-0 text-text-faint" aria-hidden />
                      ) : (
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-[var(--radius-full)]"
                          style={{ backgroundColor: getRoleColor(ow.target_id) }}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{getTargetName(ow.target_id, ow.target_type)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add overwrite */}
            <div className="mt-auto flex flex-col gap-2 px-3 py-3">
              <Divider className="mb-1" />
              <Tabs
                size="sm"
                fill
                label="Give the override to a role or a member"
                value={targetMode}
                onChange={(mode) => {
                  setTargetMode(mode);
                  if (mode === 'role') setMemberSearch('');
                  else setAddTargetId('');
                }}
                items={[
                  { value: 'role', label: 'Role' },
                  { value: 'member', label: 'Member' },
                ]}
              />
              {targetMode === 'role' ? (
                availableRolesToAdd.length === 0 ? (
                  <p className="px-1 text-meta leading-relaxed text-text-secondary">
                    Every role already has an override here. Pick one above to change it, or switch
                    to Member.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <Select
                      className="h-[var(--h-control)] w-full text-label"
                      aria-label="Role to add an override for"
                      value={addTargetId}
                      onChange={(e) => setAddTargetId(e.target.value)}
                    >
                      <option value="">Select role…</option>
                      {availableRolesToAdd.map((r) => (
                        <option key={r.id} value={r.id}>{r.id === guildId ? '@everyone' : r.name}</option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleAddTarget(addTargetId, 0)}
                      disabled={!addTargetId || saving}
                      className="w-full gap-1"
                    >
                      <Plus size={13} aria-hidden />
                      Add
                    </Button>
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Input
                    className="h-[var(--h-control)] w-full"
                    placeholder="Search members…"
                    aria-label="Search members"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                  />
                  <div className="flex max-h-28 flex-col gap-0.5 overflow-y-auto">
                    {filteredMembers.length === 0 ? (
                      <p className="px-1 text-meta leading-relaxed text-text-secondary">
                        Nobody in this server matches that search.
                      </p>
                    ) : (
                      filteredMembers.map((m) => (
                        <button
                          key={m.user.id}
                          className="pc-focusable flex h-[var(--h-list-row)] w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-label text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
                          onClick={() => void handleAddTarget(m.user.id, 1)}
                          disabled={saving}
                        >
                          <User size={13} className="shrink-0 text-text-faint" aria-hidden />
                          <span className="min-w-0 truncate">{displayName(m.user, m.nick)}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <Divider className="sm:hidden" />
          <Divider orientation="vertical" className="hidden sm:block" />

          {/* Right panel: permission editor */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {error && <ErrorBanner message={error} multiline className="mx-4 mt-4" />}

            {editing ? (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {editing.targetType === 1 ? (
                      <User size={14} className="shrink-0 text-text-faint" aria-hidden />
                    ) : (
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-[var(--radius-full)]"
                        style={{ backgroundColor: getRoleColor(editing.targetId) }}
                      />
                    )}
                    <span className="pc-display truncate text-name text-text-primary">
                      {getTargetName(editing.targetId, editing.targetType)}
                    </span>
                  </div>
                  <IconButton
                    label={`Remove permission overwrite for ${getTargetName(editing.targetId, editing.targetType)}`}
                    className="hover:bg-danger-well hover:text-accent-danger"
                    onClick={() => void handleDelete(editing.targetId)}
                    disabled={saving}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                <Divider />

                {effectivePreview && (
                  <Well className="mx-5 my-3 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <GroupLabel>Effective access preview</GroupLabel>
                      <span className="pc-mono text-meta text-text-secondary">
                        {previewAllowedCount} allowed · {previewPermissionCount - previewAllowedCount} denied
                      </span>
                    </div>
                    <p className="mt-1 text-meta leading-relaxed text-text-secondary">
                      {effectivePreview.administrator
                        ? 'Administrator access bypasses channel overrides, so every permission remains allowed.'
                        : effectivePreview.missingMemberRoles
                          ? 'This member is not in the loaded member list, so the preview uses @everyone plus the direct member override.'
                          : editing.targetType === 1
                            ? 'Combines @everyone, all assigned roles, role overrides, then this member override.'
                            : editing.targetId === guildId
                              ? 'Combines the @everyone base role with this channel override.'
                              : 'Shows a member with @everyone plus this role, then applies channel overrides.'}
                    </p>
                  </Well>
                )}

                <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
                  {PERMISSION_GROUPS.map(({ group, perms }) => (
                    <div key={group}>
                      <GroupLabel className="mb-2">{group}</GroupLabel>
                      <div className="divide-y divide-border-subtle">
                        {perms.map(({ key, label }) => {
                          const flag = Permissions[key];
                          const state = computePermState(flag, editing.allow, editing.deny);
                          const effectivelyAllowed = effectivePreview
                            ? (effectivePreview.permissions & flag) === flag
                            : false;
                          return (
                            <div key={key} data-testid={`permission-row-${key}`} className="flex items-center justify-between gap-3 py-2">
                              <span className="min-w-0">
                                <span className="block truncate text-label text-text-secondary">{label}</span>
                                <span className={cn(
                                  'block text-meta',
                                  effectivelyAllowed ? 'text-text-secondary' : 'text-text-faint',
                                )}>
                                  {state === 'inherit' ? 'Inherited' : 'Effective'} → {effectivelyAllowed ? 'allowed' : 'denied'}
                                </span>
                              </span>
                              <Tabs
                                size="sm"
                                className="shrink-0"
                                label={`${label} in this channel`}
                                value={state}
                                onChange={(next) => applyPermState(flag, next)}
                                items={PERM_STATES}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <Divider />
                <div className="flex items-center justify-between gap-2 px-5 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetOverrides}
                    disabled={!hasOverrides || saving}
                    className="gap-1.5"
                  >
                    <RotateCcw size={14} aria-hidden />
                    Reset to inherit
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(null);
                        setSelectedOverwriteId(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void handleSave()} disabled={saving} loading={saving}>
                      Save
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                className="flex-1 justify-center px-6"
                icon={<Shield size={20} aria-hidden />}
                title="Fine-tune who can do what"
                description={
                  overwrites.length === 0
                    ? `Add a role or member on the left, then allow or deny individual permissions for #${channelName}.`
                    : `Pick an override on the left to allow or deny permissions for it in #${channelName}.`
                }
              />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
