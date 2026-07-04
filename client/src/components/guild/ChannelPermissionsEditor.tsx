import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, Trash2, Plus, User, RotateCcw } from 'lucide-react';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import type { ChannelOverwrite, Role } from '../../types';
import { Permissions } from '../../types';
import { cn } from '../../lib/utils';
import { useMemberStore } from '../../stores/memberStore';
import { LoadingSpinner, ErrorBanner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

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
      { key: 'ADD_REACTIONS', label: 'Add Reactions' },
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

  const { getMembersForGuild, fetchMembers, membersLoaded } = useMemberStore();
  const guildMembers = getMembersForGuild(guildId);

  useEffect(() => {
    if (!membersLoaded[guildId]) {
      void fetchMembers(guildId);
    }
  }, [guildId, membersLoaded, fetchMembers]);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return guildMembers.slice(0, 20);
    const q = memberSearch.toLowerCase();
    return guildMembers
      .filter(
        (m) =>
          m.user.username.toLowerCase().includes(q) ||
          (m.nick && m.nick.toLowerCase().includes(q))
      )
      .slice(0, 20);
  }, [guildMembers, memberSearch]);

  const getMemberName = (userId: string) => {
    const member = guildMembers.find((m) => m.user.id === userId);
    if (member) return member.nick || member.user.username;
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

  const getRoleColor = (targetId: string) => {
    const role = roles.find((r) => r.id === targetId);
    return role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#99aab5';
  };

  const availableRolesToAdd = displayRoles.filter(
    (r) => !overwrites.some((ow) => ow.target_id === r.id)
  );

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="channel-permissions-title"
      panelClassName="w-full max-w-2xl"
    >
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-secondary px-6 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Shield size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div id="channel-permissions-title" className="font-display text-heading text-text-primary">
              Permissions
            </div>
            <div className="truncate font-code text-meta text-text-muted">#{channelName}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="flex max-h-[70vh] min-h-[20rem]">
          {/* Left panel: list of overwrites */}
          <div className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary/40">
            <div className="px-3 pb-2 pt-3">
              <div className="mb-1.5 px-1 text-section uppercase text-text-muted">Overrides</div>
              {loading ? (
                <LoadingSpinner size="sm" className="px-1 py-1.5" label="Loading…" />
              ) : overwrites.length === 0 ? (
                <p className="px-1 text-meta leading-relaxed text-text-muted">
                  No overrides yet. Add a role or member below to fine-tune access.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {overwrites.map((ow) => (
                    <button
                      key={ow.target_id}
                      onClick={() => startEditing(ow)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                        selectedOverwriteId === ow.target_id
                          ? 'bg-accent-tint text-text-primary'
                          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                      )}
                    >
                      {ow.target_type === 1 ? (
                        <User size={13} className="shrink-0 text-text-muted" />
                      ) : (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: getRoleColor(ow.target_id) }}
                        />
                      )}
                      <span className="flex-1 truncate text-label">{getTargetName(ow.target_id, ow.target_type)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add overwrite */}
            <div className="mt-auto space-y-2 border-t border-border-subtle px-3 py-3">
              <div className="flex items-center gap-1 rounded-sm bg-bg-tertiary p-1">
                {(['role', 'member'] as const).map((mode) => (
                  <button
                    key={mode}
                    className={cn(
                      'flex-1 rounded-sm px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                      targetMode === mode
                        ? 'bg-accent-primary text-text-on-accent'
                        : 'text-text-muted hover:text-text-secondary'
                    )}
                    onClick={() => {
                      setTargetMode(mode);
                      if (mode === 'role') setMemberSearch('');
                      else setAddTargetId('');
                    }}
                  >
                    {mode === 'role' ? 'Role' : 'Member'}
                  </button>
                ))}
              </div>
              {targetMode === 'role' ? (
                availableRolesToAdd.length === 0 ? (
                  <div className="px-1 text-meta text-text-muted">Every role already has an override.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <select
                      className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1.5 text-label text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                      value={addTargetId}
                      onChange={(e) => setAddTargetId(e.target.value)}
                    >
                      <option value="">Select role…</option>
                      {availableRolesToAdd.map((r) => (
                        <option key={r.id} value={r.id}>{r.id === guildId ? '@everyone' : r.name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      onClick={() => void handleAddTarget(addTargetId, 0)}
                      disabled={!addTargetId || saving}
                      className="w-full gap-1"
                    >
                      <Plus size={13} />
                      Add
                    </Button>
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  <input
                    className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1.5 text-label text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] placeholder:text-text-muted focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                    placeholder="Search members…"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                  />
                  <div className="max-h-28 space-y-0.5 overflow-y-auto">
                    {filteredMembers.length === 0 ? (
                      <div className="px-1 text-meta text-text-muted">No members match that search.</div>
                    ) : (
                      filteredMembers.map((m) => (
                        <button
                          key={m.user.id}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-label text-text-secondary outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                          onClick={() => void handleAddTarget(m.user.id, 1)}
                          disabled={saving}
                        >
                          <User size={13} className="shrink-0 text-text-muted" />
                          <span className="truncate">{m.nick || m.user.username}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right panel: permission editor */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {error && <ErrorBanner message={error} className="mx-4 mt-4" />}

            {editing ? (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-5 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {editing.targetType === 1 ? (
                      <User size={14} className="shrink-0 text-text-muted" />
                    ) : (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: getRoleColor(editing.targetId) }}
                      />
                    )}
                    <span className="truncate text-label font-semibold text-text-primary">
                      {getTargetName(editing.targetId, editing.targetType)}
                    </span>
                  </div>
                  <button
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                    title="Remove overwrite"
                    aria-label={`Remove permission overwrite for ${getTargetName(editing.targetId, editing.targetType)}`}
                    onClick={() => void handleDelete(editing.targetId)}
                    disabled={saving}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
                  {PERMISSION_GROUPS.map(({ group, perms }) => (
                    <div key={group}>
                      <div className="mb-2 text-section uppercase text-text-muted">{group}</div>
                      <div className="divide-y divide-border-subtle">
                        {perms.map(({ key, label }) => {
                          const flag = Permissions[key];
                          const state = computePermState(flag, editing.allow, editing.deny);
                          return (
                            <div key={key} className="flex items-center justify-between gap-3 py-2">
                              <span className="min-w-0 truncate text-label text-text-secondary">{label}</span>
                              <div className="flex shrink-0 items-center rounded-sm border border-border-subtle bg-bg-tertiary p-0.5">
                                {PERM_STATES.map(({ value, label: stateLabel }) => {
                                  const active = state === value;
                                  return (
                                    <button
                                      key={value}
                                      type="button"
                                      onClick={() => applyPermState(flag, value)}
                                      aria-pressed={active}
                                      aria-label={`${stateLabel} ${label}`}
                                      title={stateLabel}
                                      className={cn(
                                        'rounded-xs px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                                        active && value === 'allow' && 'bg-accent-success text-text-on-accent',
                                        active && value === 'deny' && 'bg-accent-danger text-text-on-danger',
                                        active && value === 'inherit' && 'bg-bg-mod-strong text-text-primary',
                                        !active && 'text-text-muted hover:text-text-secondary',
                                      )}
                                    >
                                      {stateLabel}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetOverrides}
                    disabled={!hasOverrides || saving}
                    className="gap-1.5"
                  >
                    <RotateCcw size={14} />
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
              <div className="flex flex-1 flex-col items-start justify-center px-6 py-8">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-text-muted">
                  <Shield size={20} />
                </div>
                <h3 className="text-subhead text-text-primary">Fine-tune who can do what</h3>
                <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-secondary">
                  {overwrites.length === 0
                    ? 'Add a role or member on the left, then allow or deny individual permissions for #' + channelName + '.'
                    : 'Pick an override on the left to allow or deny permissions for it.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
