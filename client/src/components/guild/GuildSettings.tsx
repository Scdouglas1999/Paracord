import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { X, Upload, GripVertical, Shield, Users, Hash, Link, Gavel, ScrollText, RefreshCw, Trash2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { guildApi } from '../../api/guilds';
import { inviteApi } from '../../api/invites';
import { channelApi } from '../../api/channels';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import type { AuditLogEntry, Ban, Channel, Guild, Invite, Member, Role } from '../../types';
import { isAllowedImageMimeType, isSafeImageDataUrl } from '../../lib/security';

interface GuildSettingsProps {
  guildId: string;
  guildName: string;
  onClose: () => void;
}

type SettingsSection = 'overview' | 'roles' | 'members' | 'channels' | 'invites' | 'bans' | 'audit-log';

const NAV_ITEMS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Hash size={16} /> },
  { id: 'roles', label: 'Roles', icon: <Shield size={16} /> },
  { id: 'members', label: 'Members', icon: <Users size={16} /> },
  { id: 'channels', label: 'Channels', icon: <Hash size={16} /> },
  { id: 'invites', label: 'Invites', icon: <Link size={16} /> },
  { id: 'bans', label: 'Bans', icon: <Gavel size={16} /> },
  { id: 'audit-log', label: 'Audit Log', icon: <ScrollText size={16} /> },
];

export function GuildSettings({ guildId, guildName, onClose }: GuildSettingsProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const leaveGuild = useGuildStore((s) => s.leaveGuild);
  const authUser = useAuthStore((s) => s.user);
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const [guild, setGuild] = useState<Guild | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(guildName);
  const [description, setDescription] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleColor, setNewRoleColor] = useState('#99aab5');
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRolePermissions, setEditingRolePermissions] = useState<number>(0);
  const [editingRoleColor, setEditingRoleColor] = useState('#99aab5');
  const [editingRoleHoist, setEditingRoleHoist] = useState(false);
  const [editingRoleMentionable, setEditingRoleMentionable] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text');
  const [memberSearch, setMemberSearch] = useState('');
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [banReasonInput, setBanReasonInput] = useState('');
  const [banConfirmUserId, setBanConfirmUserId] = useState<string | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const getApiErrorMessage = (err: unknown, fallback: string) => {
    const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
    return responseData?.message || responseData?.error || fallback;
  };

  const runAction = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, fallback));
    }
  };

  const refreshAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [guildRes, rolesRes, membersRes, channelsRes, invitesRes, bansRes, auditRes] =
        await Promise.all([
          guildApi.get(guildId),
          guildApi.getRoles(guildId),
          guildApi.getMembers(guildId),
          guildApi.getChannels(guildId),
          guildApi.getInvites(guildId),
          guildApi.getBans(guildId),
          guildApi.getAuditLog(guildId),
        ]);
      setGuild(guildRes.data);
      setName(guildRes.data.name || guildName);
      setDescription(guildRes.data.description || '');
      const incomingIcon = guildRes.data.icon_hash;
      if (!incomingIcon) {
        setIconDataUrl(null);
      } else if (incomingIcon.startsWith('data:')) {
        setIconDataUrl(isSafeImageDataUrl(incomingIcon) ? incomingIcon : null);
      } else {
        setIconDataUrl(`/api/v1/guilds/${guildId}/icon`);
      }
      setRoles(rolesRes.data);
      setMembers(membersRes.data);
      setChannels(channelsRes.data);
      setInvites(invitesRes.data);
      setBans(bansRes.data);
      setAuditEntries(auditRes.data.audit_log_entries || []);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to load guild settings'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAll();
  }, [guildId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requested = params.get('section');
    if (
      requested === 'overview' ||
      requested === 'roles' ||
      requested === 'members' ||
      requested === 'channels' ||
      requested === 'invites' ||
      requested === 'bans' ||
      requested === 'audit-log'
    ) {
      setActiveSection(requested);
    }
  }, [location.search]);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return members;
    const q = memberSearch.toLowerCase();
    return members.filter((m) => (m.nick || m.user.username || '').toLowerCase().includes(q));
  }, [members, memberSearch]);

  const saveOverview = async () => {
    await runAction(async () => {
      await guildApi.update(guildId, {
        name,
        description,
        icon: iconDataUrl?.startsWith('data:') ? iconDataUrl : undefined,
      });
      await refreshAll();
    }, 'Failed to save server overview');
  };

  const onGuildIconChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isAllowedImageMimeType(file.type)) {
      setError('Please upload PNG, JPG, GIF, or WEBP.');
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setIconDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const createRole = async () => {
    if (!newRoleName.trim()) return;
    const colorInt = parseInt(newRoleColor.replace('#', ''), 16) || 0;
    await runAction(async () => {
      await guildApi.createRole(guildId, { name: newRoleName.trim(), color: colorInt, permissions: 0 });
      setNewRoleName('');
      setNewRoleColor('#99aab5');
      await refreshAll();
    }, 'Failed to create role');
  };

  const renameRole = async (roleId: string, nextName: string) => {
    if (!nextName.trim()) return;
    await runAction(async () => {
      await guildApi.updateRole(guildId, roleId, { name: nextName.trim() });
      await refreshAll();
    }, 'Failed to update role');
  };

  const startEditingRole = (role: Role) => {
    setEditingRoleId(role.id);
    setEditingRoleColor('#' + (role.color || 0).toString(16).padStart(6, '0'));
    setEditingRolePermissions(typeof role.permissions === 'string' ? parseInt(role.permissions, 10) || 0 : role.permissions);
    setEditingRoleHoist(role.hoist);
    setEditingRoleMentionable(role.mentionable);
  };

  const saveRoleEdits = async () => {
    if (!editingRoleId) return;
    const colorInt = parseInt(editingRoleColor.replace('#', ''), 16) || 0;
    await runAction(async () => {
      await guildApi.updateRole(guildId, editingRoleId!, {
        color: colorInt,
        permissions: editingRolePermissions,
        hoist: editingRoleHoist,
        mentionable: editingRoleMentionable,
      } as Partial<Role>);
      setEditingRoleId(null);
      await refreshAll();
    }, 'Failed to save role');
  };

  const cancelRoleEditing = () => {
    setEditingRoleId(null);
  };

  const togglePermission = (flag: number) => {
    setEditingRolePermissions((prev) =>
      (prev & flag) ? prev & ~flag : prev | flag
    );
  };

  const deleteRole = async (roleId: string) => {
    await runAction(async () => {
      await guildApi.deleteRole(guildId, roleId);
      await refreshAll();
    }, 'Failed to delete role');
  };

  const createChannel = async () => {
    if (!newChannelName.trim()) return;
    await runAction(async () => {
      await guildApi.createChannel(guildId, {
        name: newChannelName.trim(),
        channel_type: newChannelType === 'voice' ? 2 : 0,
        parent_id: null,
      });
      setNewChannelName('');
      await refreshAll();
    }, 'Failed to create channel');
  };

  const deleteChannel = async (channelId: string) => {
    await runAction(async () => {
      await channelApi.delete(channelId);
      await refreshAll();
    }, 'Failed to delete channel');
  };

  const kickMember = async (userId: string) => {
    await runAction(async () => {
      await guildApi.kickMember(guildId, userId);
      await refreshAll();
    }, 'Failed to kick member');
  };

  const banMember = async (userId: string, reason: string) => {
    await runAction(async () => {
      await guildApi.banMember(guildId, userId, reason || 'No reason provided');
      setBanConfirmUserId(null);
      setBanReasonInput('');
      await refreshAll();
    }, 'Failed to ban member');
  };

  const revokeInvite = async (code: string) => {
    await runAction(async () => {
      await inviteApi.delete(code);
      await refreshAll();
    }, 'Failed to revoke invite');
  };

  const createInvite = async () => {
    const firstTextChannel = channels.find((c) => c.type === 0) || channels.find((c) => c.type !== 4);
    if (!firstTextChannel) return;
    await runAction(async () => {
      await guildApi.createInvite(firstTextChannel.id, { max_age: 86400, max_uses: 0 });
      await refreshAll();
    }, 'Failed to create invite');
  };

  const unban = async (userId: string) => {
    await runAction(async () => {
      await guildApi.unbanMember(guildId, userId);
      await refreshAll();
    }, 'Failed to unban user');
  };

  const handleLeaveGuild = async () => {
    if (!window.confirm('Leave this server?')) return;
    await runAction(async () => {
      await leaveGuild(guildId);
      onClose();
      navigate('/app/friends');
    }, 'Failed to leave server');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex bg-bg-tertiary/95 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="pointer-events-none absolute -left-20 top-0 h-72 w-72 rounded-full bg-accent-primary/20 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-accent-success/10 blur-[140px]" />
      <div className="relative z-10 w-72 shrink-0 overflow-y-auto border-r border-border-subtle/70 bg-bg-secondary/65 px-4 py-10">
        <div className="ml-auto w-full max-w-[236px]">
          <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {guild?.name || guildName}
          </div>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`settings-nav-item ${activeSection === item.id ? 'active' : ''}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto px-6 py-10">
        <div className="w-full">
        <div className="fixed right-6 top-5 z-20 flex flex-col items-center gap-1">
          <button onClick={onClose} className="command-icon-btn rounded-full border border-border-strong bg-bg-secondary/75">
            <X size={18} />
          </button>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Esc</span>
        </div>

        {error && (
          <div className="mb-3 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm font-medium text-accent-danger">{error}</div>
        )}
        <div className="mb-5 flex items-center gap-2.5">
          <button
            onClick={() => void refreshAll()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-4 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          {loading && <span className="text-sm text-text-muted">Loading...</span>}
        </div>

        {activeSection === 'overview' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Server Overview</h2>
            <div className="flex gap-6">
              <div className="flex-shrink-0">
                <label className="cursor-pointer">
                  <input type="file" accept="image/*" className="hidden" onChange={onGuildIconChange} />
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
              <div className="flex-1 space-y-5">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Server Name</span>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field mt-2" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="input-field mt-2 resize-none"
                    placeholder="Describe your server"
                  />
                </label>
              </div>
            </div>
            <div className="mt-6 flex items-center gap-2.5">
              <button className="btn-primary" onClick={() => void saveOverview()}>Save Changes</button>
              {guild && authUser && guild.owner_id !== authUser.id && (
                <button className="btn-ghost" onClick={() => void handleLeaveGuild()}>
                  Leave Server
                </button>
              )}
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
                <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Members</div>
                <div className="mt-1 text-xl font-semibold text-text-primary">{members.length}</div>
              </div>
              <div className="min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
                <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Roles</div>
                <div className="mt-1 text-xl font-semibold text-text-primary">{roles.length}</div>
              </div>
              <div className="min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
                <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Channels</div>
                <div className="mt-1 text-xl font-semibold text-text-primary">{channels.length}</div>
              </div>
              <div className="min-h-[5.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3.5">
                <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Active Invites</div>
                <div className="mt-1 text-xl font-semibold text-text-primary">{invites.length}</div>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm leading-6 text-text-secondary">
              Keep this server profile complete so new members instantly recognize your community and can orient themselves faster.
            </div>
          </div>
        )}

        {activeSection === 'roles' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Roles</h2>
            <div className="space-y-2.5">
              {roles.map((role) => {
                const roleColor = role.color ? '#' + role.color.toString(16).padStart(6, '0') : '#99aab5';
                const isEditing = editingRoleId === role.id;
                return (
                  <div key={role.id}>
                    <div className="flex items-center gap-3.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                      <GripVertical size={16} style={{ color: 'var(--text-muted)' }} />
                      <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-border-subtle" style={{ backgroundColor: roleColor }} />
                      <input
                        className="flex-1 bg-transparent text-base leading-normal outline-none"
                        style={{ color: roleColor !== '#000000' ? roleColor : 'var(--text-primary)' }}
                        defaultValue={role.name}
                        onBlur={(e) => {
                          if (e.target.value !== role.name) void renameRole(role.id, e.target.value);
                        }}
                      />
                      {role.hoist && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border-subtle" style={{ color: 'var(--text-muted)' }}>Hoisted</span>
                      )}
                      {role.id !== guildId && (
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => isEditing ? cancelRoleEditing() : startEditingRole(role)}
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </button>
                      )}
                      {role.id !== guildId && (
                        <button className="icon-btn" onClick={() => void deleteRole(role.id)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    {isEditing && (
                      <div className="ml-8 mt-2 rounded-xl border border-border-subtle bg-bg-primary/60 p-4 space-y-4">
                        <div className="flex items-center gap-4">
                          <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Color</span>
                            <div className="mt-1 flex items-center gap-2">
                              <input
                                type="color"
                                value={editingRoleColor}
                                onChange={(e) => setEditingRoleColor(e.target.value)}
                                className="h-9 w-9 cursor-pointer rounded-lg border border-border-subtle bg-transparent"
                              />
                              <input
                                type="text"
                                value={editingRoleColor}
                                onChange={(e) => setEditingRoleColor(e.target.value)}
                                className="input-field w-28"
                                maxLength={7}
                              />
                            </div>
                          </label>
                        </div>
                        <div className="flex items-center gap-6">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editingRoleHoist}
                              onChange={(e) => setEditingRoleHoist(e.target.checked)}
                              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                            />
                            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Display separately (hoist)</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editingRoleMentionable}
                              onChange={(e) => setEditingRoleMentionable(e.target.checked)}
                              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                            />
                            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Allow anyone to @mention this role</span>
                          </label>
                        </div>
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Permissions</span>
                          <div className="mt-2 grid grid-cols-2 gap-2">
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
                                  onChange={() => togglePermission(perm.flag)}
                                  className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                                />
                                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{perm.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button className="btn-primary" onClick={() => void saveRoleEdits()}>Save Changes</button>
                          <button
                            className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                            onClick={cancelRoleEditing}
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
            <div className="mt-6 flex items-center gap-3">
              <input className="input-field flex-1" placeholder="New role name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
              <input
                type="color"
                value={newRoleColor}
                onChange={(e) => setNewRoleColor(e.target.value)}
                className="h-10 w-10 cursor-pointer rounded-lg border border-border-subtle bg-transparent"
                title="Role color"
              />
              <button className="btn-primary" onClick={() => void createRole()}>Create Role</button>
            </div>
          </div>
        )}

        {activeSection === 'members' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-4">Members</h2>
            <input type="text" placeholder="Search members" className="input-field mb-4" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} />
            <div className="space-y-2">
              {filteredMembers.map((member) => (
                <div key={member.user.id}>
                  <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
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
                    <div className="flex items-center gap-1">
                      {member.roles && member.roles.length > 0 && (
                        <div className="hidden sm:flex items-center gap-1 mr-2">
                          {member.roles.slice(0, 3).map((roleId) => {
                            const role = roles.find((r) => r.id === roleId);
                            if (!role) return null;
                            const rColor = role.color ? '#' + role.color.toString(16).padStart(6, '0') : 'var(--text-muted)';
                            return (
                              <span key={roleId} className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-[11px] font-medium" style={{ color: rColor }}>
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rColor }} />
                                {role.name}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <button className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary" onClick={() => void kickMember(member.user.id)}>Kick</button>
                      <button
                        className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                        onClick={() => {
                          setBanConfirmUserId(member.user.id);
                          setBanReasonInput('');
                        }}
                      >
                        Ban
                      </button>
                    </div>
                  </div>
                  {banConfirmUserId === member.user.id && (
                    <div className="ml-10 mt-2 rounded-xl border border-accent-danger/30 bg-accent-danger/5 p-3 space-y-2">
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Ban {member.user.username}?
                      </p>
                      <input
                        type="text"
                        placeholder="Reason for ban (optional)"
                        value={banReasonInput}
                        onChange={(e) => setBanReasonInput(e.target.value)}
                        className="input-field w-full"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void banMember(member.user.id, banReasonInput);
                          if (e.key === 'Escape') setBanConfirmUserId(null);
                        }}
                        autoFocus
                      />
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors"
                          style={{ backgroundColor: 'var(--accent-danger)', color: '#fff' }}
                          onClick={() => void banMember(member.user.id, banReasonInput)}
                        >
                          Confirm Ban
                        </button>
                        <button
                          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle"
                          onClick={() => setBanConfirmUserId(null)}
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
        )}

        {activeSection === 'channels' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-4">Channels</h2>
            <div className="space-y-2">
              {channels.sort((a, b) => a.position - b.position).map((channel) => (
                <div key={channel.id} className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
                  <Hash size={16} />
                  <span className="flex-1 text-sm" style={{ color: 'var(--text-primary)' }}>{channel.name || 'unnamed'}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{channel.type === 2 ? 'voice' : 'text'}</span>
                  <button className="icon-btn" onClick={() => void deleteChannel(channel.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              <div className="mt-2 flex items-center gap-2.5">
                <input className="input-field flex-1" placeholder="New channel name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
                <select className="select-field min-w-[8.75rem]" value={newChannelType} onChange={(e) => setNewChannelType(e.target.value as 'text' | 'voice')}>
                  <option value="text">Text</option>
                  <option value="voice">Voice</option>
                </select>
                <button className="btn-primary" onClick={() => void createChannel()}>Create</button>
              </div>
            </div>
          </div>
        )}

        {activeSection === 'invites' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="settings-section-title !mb-0">Invites</h2>
              <button className="btn-primary text-sm" onClick={() => void createInvite()}>
                Create Invite
              </button>
            </div>
            <div className="overflow-hidden rounded-xl border border-border-subtle">
              <div className="flex items-center bg-bg-secondary px-4 py-2.5 text-xs font-semibold uppercase text-text-muted">
                <span className="flex-1">Code</span>
                <span className="w-24">Uses</span>
                <span className="w-24">Expires</span>
                <span className="w-16"></span>
              </div>
              {invites.map((invite) => (
                <div key={invite.code} className="flex items-center gap-2 px-4 py-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <span className="flex-1" style={{ color: 'var(--text-primary)' }}>{invite.code}</span>
                  <span className="w-24" style={{ color: 'var(--text-muted)' }}>{invite.uses}/{invite.max_uses || 'inf'}</span>
                  <span className="w-24" style={{ color: 'var(--text-muted)' }}>{invite.max_age || 'never'}</span>
                  <button
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-transparent px-3 text-sm font-semibold text-accent-danger transition-colors hover:border-accent-danger/35 hover:bg-accent-danger/12"
                    onClick={() => void revokeInvite(invite.code)}
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
        )}

        {activeSection === 'bans' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-4">Bans</h2>
            <div className="space-y-2">
              {bans.map((ban) => (
                <div key={ban.user.id} className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0" style={{ backgroundColor: 'var(--accent-danger)' }}>
                    {ban.user.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm block" style={{ color: 'var(--text-primary)' }}>{ban.user.username}</span>
                    {ban.reason && (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Reason: {ban.reason}</span>
                    )}
                  </div>
                  <button className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary" onClick={() => void unban(ban.user.id)}>Unban</button>
                </div>
              ))}
              {bans.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8">
                  <Gavel size={36} style={{ color: 'var(--text-muted)' }} className="mb-2" />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No banned users.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeSection === 'audit-log' && (
          <div className="settings-surface-card min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-4">Audit Log</h2>
            <div className="space-y-2">
              {auditEntries.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
                  <div className="text-sm" style={{ color: 'var(--text-primary)' }}>Action {entry.action_type} on {entry.target_id || 'n/a'}</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    by {entry.user_id} at {new Date(entry.created_at).toLocaleString()}
                  </div>
                  {entry.reason && <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Reason: {entry.reason}</div>}
                </div>
              ))}
              {auditEntries.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8">
                  <ScrollText size={36} style={{ color: 'var(--text-muted)' }} className="mb-2" />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No audit log entries.</p>
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
