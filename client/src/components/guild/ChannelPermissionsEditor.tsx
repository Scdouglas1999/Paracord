import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Shield, Trash2, Plus, User, X } from 'lucide-react';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import type { ChannelOverwrite, Role } from '../../types';
import { Permissions } from '../../types';
import { cn } from '../../lib/utils';
import { useMemberStore } from '../../stores/memberStore';
import { LoadingSpinner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface ChannelPermissionsEditorProps {
  channelId: string;
  channelName: string;
  roles: Role[];
  guildId: string;
  onClose: () => void;
}

const PERMISSION_FLAGS: { key: keyof typeof Permissions; label: string }[] = [
  { key: 'VIEW_CHANNEL', label: 'View Channel' },
  { key: 'SEND_MESSAGES', label: 'Send Messages' },
  { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History' },
  { key: 'ATTACH_FILES', label: 'Attach Files' },
  { key: 'EMBED_LINKS', label: 'Embed Links' },
  { key: 'ADD_REACTIONS', label: 'Add Reactions' },
  { key: 'MANAGE_MESSAGES', label: 'Manage Messages' },
  { key: 'MANAGE_CHANNELS', label: 'Manage Channel' },
  { key: 'MENTION_EVERYONE', label: 'Mention Everyone' },
  { key: 'USE_EXTERNAL_EMOJIS', label: 'Use External Emojis' },
  { key: 'CONNECT', label: 'Connect (Voice)' },
  { key: 'SPEAK', label: 'Speak (Voice)' },
  { key: 'MUTE_MEMBERS', label: 'Mute Members' },
  { key: 'DEAFEN_MEMBERS', label: 'Deafen Members' },
  { key: 'MOVE_MEMBERS', label: 'Move Members' },
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

  const handleTogglePerm = (flag: bigint, current: PermState) => {
    if (!editing) return;
    let nextAllow = editing.allow;
    let nextDeny = editing.deny;

    // Cycle: inherit -> allow -> deny -> inherit
    if (current === 'inherit') {
      nextAllow |= flag;
      nextDeny &= ~flag;
    } else if (current === 'allow') {
      nextAllow &= ~flag;
      nextDeny |= flag;
    } else {
      nextAllow &= ~flag;
      nextDeny &= ~flag;
    }

    setEditing({ ...editing, allow: nextAllow, deny: nextDeny });
  };

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
        <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
          <Shield size={18} className="text-accent-primary" />
          <div className="flex-1 min-w-0">
            <div id="channel-permissions-title" className="text-sm font-semibold text-text-primary">
              Permissions
            </div>
            <div className="truncate text-xs text-text-muted">#{channelName}</div>
          </div>
          <button
            className="rounded-lg px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="flex max-h-[70vh] min-h-[20rem]">
          {/* Left panel: list of overwrites */}
          <div className="flex w-48 flex-shrink-0 flex-col border-r border-border-subtle">
            <div className="px-3 pt-3 pb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted px-1 mb-1.5">
                Overwrites
              </div>
              {loading ? (
                <LoadingSpinner size="sm" className="px-1 py-1.5" label="Loading..." />
              ) : overwrites.length === 0 ? (
                <div className="text-xs text-text-muted px-1">No overwrites</div>
              ) : (
                <div className="space-y-0.5">
                  {overwrites.map((ow) => (
                    <button
                      key={ow.target_id}
                      onClick={() => startEditing(ow)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                        selectedOverwriteId === ow.target_id
                          ? 'bg-accent-primary/20 text-text-primary'
                          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                      )}
                    >
                      {ow.target_type === 1 ? (
                        <User size={10} className="flex-shrink-0 text-text-muted" />
                      ) : (
                        <span
                          className="h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: getRoleColor(ow.target_id) }}
                        />
                      )}
                      <span className="flex-1 truncate text-xs">{getTargetName(ow.target_id, ow.target_type)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add overwrite */}
            <div className="mt-auto border-t border-border-subtle px-3 py-3 space-y-2">
              <div className="flex items-center gap-1">
                <button
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                    targetMode === 'role'
                      ? 'bg-accent-primary/20 text-accent-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  )}
                  onClick={() => { setTargetMode('role'); setMemberSearch(''); }}
                >
                  Role
                </button>
                <button
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                    targetMode === 'member'
                      ? 'bg-accent-primary/20 text-accent-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  )}
                  onClick={() => { setTargetMode('member'); setAddTargetId(''); }}
                >
                  Member
                </button>
              </div>
              {targetMode === 'role' ? (
                availableRolesToAdd.length === 0 ? (
                  <div className="text-xs text-text-muted">All roles added</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <select
                      className="w-full rounded-md border border-border-subtle bg-bg-secondary px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-primary"
                      value={addTargetId}
                      onChange={(e) => setAddTargetId(e.target.value)}
                    >
                      <option value="">Select role...</option>
                      {availableRolesToAdd.map((r) => (
                        <option key={r.id} value={r.id}>{r.id === guildId ? '@everyone' : r.name}</option>
                      ))}
                    </select>
                    <button
                      className="flex w-full items-center justify-center gap-1 rounded-md bg-accent-primary px-2 py-1.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
                      onClick={() => void handleAddTarget(addTargetId, 0)}
                      disabled={!addTargetId || saving}
                    >
                      <Plus size={12} />
                      Add
                    </button>
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  <input
                    className="w-full rounded-md border border-border-subtle bg-bg-secondary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary"
                    placeholder="Search members..."
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                  />
                  <div className="max-h-28 overflow-y-auto space-y-0.5">
                    {filteredMembers.length === 0 ? (
                      <div className="text-xs text-text-muted px-1">No members found</div>
                    ) : (
                      filteredMembers.map((m) => (
                        <button
                          key={m.user.id}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                          onClick={() => void handleAddTarget(m.user.id, 1)}
                          disabled={saving}
                        >
                          <User size={10} className="flex-shrink-0 text-text-muted" />
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
            {error && (
              <div role="alert" className="mx-4 mt-4 rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-xs text-accent-danger">
                {error}
              </div>
            )}

            {editing ? (
              <div className="flex flex-1 flex-col overflow-y-auto">
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                  <div className="flex items-center gap-2">
                    {editing.targetType === 1 ? (
                      <User size={12} className="flex-shrink-0 text-text-muted" />
                    ) : (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: getRoleColor(editing.targetId) }}
                      />
                    )}
                    <span className="text-sm font-semibold text-text-primary">
                      {getTargetName(editing.targetId, editing.targetType)}
                    </span>
                  </div>
                  <button
                    className="rounded p-1 text-text-muted transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                    title="Remove overwrite"
                    aria-label={`Remove permission overwrite for ${getTargetName(editing.targetId, editing.targetType)}`}
                    onClick={() => void handleDelete(editing.targetId)}
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
                  <div className="mb-2 grid grid-cols-3 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                    <span>Permission</span>
                    <span className="text-center text-accent-success">Allow</span>
                    <span className="text-center text-accent-danger">Deny</span>
                  </div>
                  {PERMISSION_FLAGS.map(({ key, label }) => {
                    const flag = Permissions[key];
                    const state = computePermState(flag, editing.allow, editing.deny);
                    return (
                      <div
                        key={key}
                        className="grid grid-cols-3 items-center rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-bg-mod-subtle"
                      >
                        <span className="text-xs text-text-secondary">{label}</span>
                        <div className="flex justify-center">
                          <button
                            onClick={() => handleTogglePerm(flag, state)}
                            className={cn(
                              'h-5 w-5 rounded border transition-all',
                              state === 'allow'
                                ? 'border-accent-success bg-accent-success text-on-accent'
                                : 'border-border-subtle bg-transparent hover:border-accent-success/50'
                            )}
                            title="Allow"
                            aria-label={`Allow ${label}`}
                          >
                            {state === 'allow' && (
                              <Check size={12} strokeWidth={3} aria-hidden="true" />
                            )}
                          </button>
                        </div>
                        <div className="flex justify-center">
                          <button
                            onClick={() => {
                              const nextState: PermState = state === 'deny' ? 'inherit' : 'deny';
                              const flag2 = Permissions[key];
                              let nextAllow = editing.allow;
                              let nextDeny = editing.deny;
                              if (nextState === 'deny') {
                                nextAllow &= ~flag2;
                                nextDeny |= flag2;
                              } else {
                                nextDeny &= ~flag2;
                              }
                              setEditing({ ...editing, allow: nextAllow, deny: nextDeny });
                            }}
                            className={cn(
                              'h-5 w-5 rounded border transition-all',
                              state === 'deny'
                                ? 'border-accent-danger bg-accent-danger text-on-accent'
                                : 'border-border-subtle bg-transparent hover:border-accent-danger/50'
                            )}
                            title="Deny"
                            aria-label={`Deny ${label}`}
                          >
                            {state === 'deny' && (
                              <X size={12} strokeWidth={3} aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-border-subtle px-4 py-3 flex gap-2 justify-end">
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
                  <Button
                    size="sm"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    loading={saving}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                {overwrites.length === 0
                  ? 'Add a role or member to configure permission overwrites'
                  : 'Select an overwrite to edit its permissions'}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
