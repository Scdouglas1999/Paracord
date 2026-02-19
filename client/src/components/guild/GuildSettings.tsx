import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { X, Upload, GripVertical, Shield, Users, Hash, Link, Gavel, ScrollText, RefreshCw, Trash2, Smile, Calendar, Bot, ArrowLeft } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { guildApi } from '../../api/guilds';
import { inviteApi } from '../../api/invites';
import { webhookApi } from '../../api/webhooks';
import { botApi, type BotApplication, type GuildBotEntry } from '../../api/bots';
import { emojiApi } from '../../api/emojis';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { invalidateGuildPermissionCache, usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import type { AuditLogEntry, Ban, Channel, Guild, GuildEmoji, Invite, Member, Role } from '../../types';
import type { Webhook } from '../../types';
import { isAllowedImageMimeType, isSafeImageDataUrl } from '../../lib/security';
import { resolveApiBaseUrl } from '../../lib/apiBaseUrl';
import { cn } from '../../lib/utils';
import { confirm } from '../../stores/confirmStore';
import { buildGuildEmojiImageUrl } from '../../lib/customEmoji';
import { EventList } from './EventList';
import { ChannelManager } from './ChannelManager';

interface GuildSettingsProps {
  guildId: string;
  guildName: string;
  onClose: () => void;
}

type SettingsSection = 'overview' | 'roles' | 'members' | 'channels' | 'invites' | 'emojis' | 'webhooks' | 'bots' | 'events' | 'bans' | 'audit-log';

const NAV_ITEMS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Hash size={16} /> },
  { id: 'roles', label: 'Roles', icon: <Shield size={16} /> },
  { id: 'members', label: 'Members', icon: <Users size={16} /> },
  { id: 'channels', label: 'Channels', icon: <Hash size={16} /> },
  { id: 'invites', label: 'Invites', icon: <Link size={16} /> },
  { id: 'emojis', label: 'Emojis', icon: <Smile size={16} /> },
  { id: 'webhooks', label: 'Webhooks', icon: <Link size={16} /> },
  { id: 'bots', label: 'Bots', icon: <Bot size={16} /> },
  { id: 'events', label: 'Events', icon: <Calendar size={16} /> },
  { id: 'bans', label: 'Bans', icon: <Gavel size={16} /> },
  { id: 'audit-log', label: 'Audit Log', icon: <ScrollText size={16} /> },
];

export function GuildSettings({ guildId, guildName, onClose }: GuildSettingsProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const leaveGuild = useGuildStore((s) => s.leaveGuild);
  const authUser = useAuthStore((s) => s.user);
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManageRoleSettings = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const canManageEmojis = isAdmin || hasPermission(permissions, Permissions.MANAGE_EMOJIS);
  const canManageWebhooks = isAdmin || hasPermission(permissions, Permissions.MANAGE_WEBHOOKS);
  const memberRoleId = guildId;
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const [guild, setGuild] = useState<Guild | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [emojis, setEmojis] = useState<GuildEmoji[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [guildBots, setGuildBots] = useState<GuildBotEntry[]>([]);
  const [userBotApps, setUserBotApps] = useState<BotApplication[]>([]);
  const [selectedOwnBotId, setSelectedOwnBotId] = useState('');
  const [addBotId, setAddBotId] = useState('');
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
  const [newWebhookName, setNewWebhookName] = useState('');
  const [newWebhookChannelId, setNewWebhookChannelId] = useState('');
  const [webhookFilterChannelId, setWebhookFilterChannelId] = useState<'all' | string>('all');
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null);
  const [editingWebhookName, setEditingWebhookName] = useState('');
  const [issuedWebhookTokens, setIssuedWebhookTokens] = useState<Record<string, string>>({});
  const [copiedWebhookId, setCopiedWebhookId] = useState<string | null>(null);
  const [webhookInspectingId, setWebhookInspectingId] = useState<string | null>(null);
  const [webhookExecutingId, setWebhookExecutingId] = useState<string | null>(null);
  const [webhookTestMessages, setWebhookTestMessages] = useState<Record<string, string>>({});
  const [newEmojiName, setNewEmojiName] = useState('');
  const [newEmojiFile, setNewEmojiFile] = useState<File | null>(null);
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null);
  const [editingEmojiName, setEditingEmojiName] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [editingMemberRoleUserId, setEditingMemberRoleUserId] = useState<string | null>(null);
  const [draftMemberRoleIds, setDraftMemberRoleIds] = useState<string[]>([]);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [banReasonInput, setBanReasonInput] = useState('');
  const [banConfirmUserId, setBanConfirmUserId] = useState<string | null>(null);
  const [ownershipTargetUserId, setOwnershipTargetUserId] = useState('');
  const [transferringOwnership, setTransferringOwnership] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

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
      const webhookPromise = canManageWebhooks
        ? webhookFilterChannelId === 'all'
          ? webhookApi.listGuild(guildId)
          : webhookApi.listChannel(webhookFilterChannelId)
        : Promise.resolve({ data: [] as Webhook[] });
      const botsPromise = canManageRoleSettings
        ? botApi.listGuildBots(guildId).catch(() => ({ data: [] as GuildBotEntry[] }))
        : Promise.resolve({ data: [] as GuildBotEntry[] });
      const ownAppsPromise = canManageRoleSettings
        ? botApi.list().catch(() => ({ data: [] as BotApplication[] }))
        : Promise.resolve({ data: [] as BotApplication[] });
      const [guildRes, rolesRes, membersRes, channelsRes, invitesRes, emojiRes, webhookRes, botsRes, ownAppsRes, bansRes, auditRes] =
        await Promise.all([
          guildApi.get(guildId),
          guildApi.getRoles(guildId),
          guildApi.getMembers(guildId),
          guildApi.getChannels(guildId),
          guildApi.getInvites(guildId),
          emojiApi.listGuild(guildId),
          webhookPromise,
          botsPromise,
          ownAppsPromise,
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
      const normalizedChannels = channelsRes.data.map((channel) => ({
        ...channel,
        required_role_ids: channel.required_role_ids ?? [],
      }));
      setChannels(normalizedChannels);
      setInvites(invitesRes.data);
      setEmojis(emojiRes.data);
      setWebhooks(webhookRes.data);
      setGuildBots(botsRes.data);
      setUserBotApps(ownAppsRes.data);
      setSelectedOwnBotId((current) => {
        if (!ownAppsRes.data.length) return '';
        if (current && ownAppsRes.data.some((app) => app.id === current)) return current;
        return ownAppsRes.data[0].id;
      });
      setBans(bansRes.data);
      setAuditEntries(auditRes.data.audit_log_entries || []);
      if (!newWebhookChannelId) {
        const firstTextChannel = normalizedChannels.find((c) => c.type === 0 || c.channel_type === 0);
        if (firstTextChannel) {
          setNewWebhookChannelId(firstTextChannel.id);
        }
      }
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to load guild settings'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAll();
  }, [guildId, canManageWebhooks, webhookFilterChannelId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requested = params.get('section');
    if (
      requested === 'overview' ||
      requested === 'roles' ||
      requested === 'members' ||
      requested === 'channels' ||
      requested === 'invites' ||
      requested === 'emojis' ||
      requested === 'webhooks' ||
      requested === 'bots' ||
      requested === 'events' ||
      requested === 'bans' ||
      requested === 'audit-log'
    ) {
      setActiveSection(requested);
    }
  }, [location.search]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener('change', updateIsMobile);
    return () => mediaQuery.removeEventListener('change', updateIsMobile);
  }, []);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return members;
    const q = memberSearch.toLowerCase();
    return members.filter((m) => (m.nick || m.user.username || '').toLowerCase().includes(q));
  }, [members, memberSearch]);
  const assignableRoles = useMemo(
    () => roles.filter((role) => role.id !== memberRoleId),
    [roles, memberRoleId]
  );
  const channelNameById = useMemo(
    () =>
      new Map(
        channels.map((channel) => [
          channel.id,
          channel.name || `channel-${channel.id.slice(0, 6)}`,
        ])
      ),
    [channels]
  );
  const ownershipCandidates = useMemo(
    () => members.filter((member) => member.user.id !== guild?.owner_id),
    [members, guild?.owner_id]
  );

  useEffect(() => {
    if (webhookFilterChannelId === 'all') return;
    const channelStillExists = channels.some((channel) => channel.id === webhookFilterChannelId);
    if (!channelStillExists) {
      setWebhookFilterChannelId('all');
    }
  }, [channels, webhookFilterChannelId]);

  useEffect(() => {
    if (!ownershipCandidates.length) {
      setOwnershipTargetUserId('');
      return;
    }
    if (ownershipTargetUserId && ownershipCandidates.some((member) => member.user.id === ownershipTargetUserId)) {
      return;
    }
    setOwnershipTargetUserId(ownershipCandidates[0].user.id);
  }, [ownershipCandidates, ownershipTargetUserId]);

  const roleColorHex = (role: Role) =>
    role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#99aab5';

  const toggleRoleId = (roleIds: string[], roleId: string) =>
    roleIds.includes(roleId)
      ? roleIds.filter((id) => id !== roleId)
      : [...roleIds, roleId];

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
    if (!canManageRoleSettings) return;
    if (!newRoleName.trim()) return;
    const colorInt = parseInt(newRoleColor.replace('#', ''), 16) || 0;
    await runAction(async () => {
      await guildApi.createRole(guildId, { name: newRoleName.trim(), color: colorInt, permissions: 0 });
      invalidateGuildPermissionCache(guildId);
      setNewRoleName('');
      setNewRoleColor('#99aab5');
      await refreshAll();
    }, 'Failed to create role');
  };

  const renameRole = async (roleId: string, nextName: string) => {
    if (!canManageRoleSettings) return;
    if (!nextName.trim()) return;
    await runAction(async () => {
      await guildApi.updateRole(guildId, roleId, { name: nextName.trim() });
      invalidateGuildPermissionCache(guildId);
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
    if (!canManageRoleSettings) return;
    if (!editingRoleId) return;
    const colorInt = parseInt(editingRoleColor.replace('#', ''), 16) || 0;
    await runAction(async () => {
      await guildApi.updateRole(guildId, editingRoleId!, {
        color: colorInt,
        permissions: editingRolePermissions,
        hoist: editingRoleHoist,
        mentionable: editingRoleMentionable,
      } as Partial<Role>);
      invalidateGuildPermissionCache(guildId);
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
    if (!canManageRoleSettings) return;
    await runAction(async () => {
      await guildApi.deleteRole(guildId, roleId);
      invalidateGuildPermissionCache(guildId);
      await refreshAll();
    }, 'Failed to delete role');
  };

  const startEditingMemberRoles = (member: Member) => {
    if (!canManageRoleSettings) return;
    setEditingMemberRoleUserId(member.user.id);
    setDraftMemberRoleIds((member.roles || []).filter((roleId) => roleId !== memberRoleId));
  };

  const saveMemberRoles = async (userId: string) => {
    if (!canManageRoleSettings) return;
    await runAction(async () => {
      await guildApi.updateMember(guildId, userId, {
        roles: [memberRoleId, ...draftMemberRoleIds],
      });
      invalidateGuildPermissionCache(guildId);
      setEditingMemberRoleUserId(null);
      setDraftMemberRoleIds([]);
      await refreshAll();
    }, 'Failed to update member roles');
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

  const createEmoji = async () => {
    if (!canManageEmojis) return;
    if (!newEmojiName.trim()) return;
    if (!newEmojiFile) {
      setError('Select a PNG or GIF file to upload.');
      return;
    }
    await runAction(async () => {
      await emojiApi.create(guildId, { name: newEmojiName, file: newEmojiFile });
      setNewEmojiName('');
      setNewEmojiFile(null);
      await refreshAll();
    }, 'Failed to create emoji');
  };

  const startEditingEmoji = (emoji: GuildEmoji) => {
    setEditingEmojiId(emoji.id);
    setEditingEmojiName(emoji.name);
  };

  const saveEmojiName = async (emojiId: string) => {
    if (!canManageEmojis) return;
    const trimmed = editingEmojiName.trim();
    if (!trimmed) return;
    await runAction(async () => {
      await emojiApi.update(guildId, emojiId, trimmed);
      setEditingEmojiId(null);
      setEditingEmojiName('');
      await refreshAll();
    }, 'Failed to rename emoji');
  };

  const deleteEmoji = async (emojiId: string) => {
    if (!canManageEmojis) return;
    await runAction(async () => {
      await emojiApi.delete(guildId, emojiId);
      if (editingEmojiId === emojiId) {
        setEditingEmojiId(null);
        setEditingEmojiName('');
      }
      await refreshAll();
    }, 'Failed to delete emoji');
  };

  const webhookBase = (() => {
    const base = resolveApiBaseUrl();
    if (base.startsWith('http://') || base.startsWith('https://')) {
      return base.replace(/\/api\/v1\/?$/, '');
    }
    if (typeof window !== 'undefined') {
      return window.location.origin;
    }
    return '';
  })();

  const buildWebhookExecuteUrl = (webhookId: string, token: string) =>
    `${webhookBase}/api/v1/webhooks/${webhookId}/${token}`;

  const createWebhook = async () => {
    if (!canManageWebhooks) return;
    const trimmed = newWebhookName.trim();
    if (!trimmed) return;
    await runAction(async () => {
      const payload: { name: string; channel_id?: string } = { name: trimmed };
      if (newWebhookChannelId) payload.channel_id = newWebhookChannelId;
      const { data } = await webhookApi.create(guildId, payload);
      if (data.token) {
        setIssuedWebhookTokens((prev) => ({ ...prev, [data.id]: data.token! }));
      }
      setWebhookTestMessages((prev) => ({ ...prev, [data.id]: '' }));
      setNewWebhookName('');
      await refreshAll();
    }, 'Failed to create webhook');
  };

  const startEditingWebhook = (webhook: Webhook) => {
    setEditingWebhookId(webhook.id);
    setEditingWebhookName(webhook.name);
  };

  const saveWebhookName = async (webhookId: string) => {
    if (!canManageWebhooks) return;
    const trimmed = editingWebhookName.trim();
    if (!trimmed) return;
    await runAction(async () => {
      await webhookApi.update(webhookId, { name: trimmed });
      setEditingWebhookId(null);
      setEditingWebhookName('');
      await refreshAll();
    }, 'Failed to update webhook');
  };

  const deleteWebhook = async (webhookId: string) => {
    if (!canManageWebhooks) return;
    await runAction(async () => {
      await webhookApi.delete(webhookId);
      setIssuedWebhookTokens((prev) => {
        const next = { ...prev };
        delete next[webhookId];
        return next;
      });
      setWebhookTestMessages((prev) => {
        const next = { ...prev };
        delete next[webhookId];
        return next;
      });
      await refreshAll();
    }, 'Failed to delete webhook');
  };

  const copyWebhookUrl = async (webhookId: string) => {
    const token = issuedWebhookTokens[webhookId];
    if (!token) return;
    try {
      await navigator.clipboard.writeText(buildWebhookExecuteUrl(webhookId, token));
      setCopiedWebhookId(webhookId);
      window.setTimeout(() => {
        setCopiedWebhookId((current) => (current === webhookId ? null : current));
      }, 1800);
    } catch {
      setError('Could not copy webhook URL');
    }
  };

  const inspectWebhook = async (webhookId: string) => {
    if (!canManageWebhooks || webhookInspectingId) return;
    setWebhookInspectingId(webhookId);
    try {
      const { data } = await webhookApi.get(webhookId);
      setWebhooks((prev) => prev.map((webhook) => (webhook.id === webhookId ? { ...webhook, ...data } : webhook)));
    } catch {
      setError('Failed to refresh webhook details');
    } finally {
      setWebhookInspectingId(null);
    }
  };

  const executeWebhookTest = async (webhookId: string) => {
    if (!canManageWebhooks || webhookExecutingId) return;
    const token = issuedWebhookTokens[webhookId];
    if (!token) {
      setError('Webhook token unavailable. Recreate this webhook to test execution from the UI.');
      return;
    }
    const content = (webhookTestMessages[webhookId] || '').trim();
    if (!content) {
      setError('Enter a test message before executing the webhook.');
      return;
    }
    setWebhookExecutingId(webhookId);
    try {
      await webhookApi.execute(webhookId, token, { content });
      setWebhookTestMessages((prev) => ({ ...prev, [webhookId]: '' }));
      setError(null);
    } catch {
      setError('Failed to execute webhook test message');
    } finally {
      setWebhookExecutingId(null);
    }
  };

  const transferOwnership = async () => {
    if (!guild || !authUser) return;
    if (guild.owner_id !== authUser.id) return;
    if (!ownershipTargetUserId) return;
    const targetMember = members.find((member) => member.user.id === ownershipTargetUserId);
    const targetName = targetMember?.nick || targetMember?.user.username || ownershipTargetUserId;
    if (!(await confirm({ title: 'Transfer ownership?', description: `Transfer server ownership to ${targetName}? This cannot be undone.`, confirmLabel: 'Transfer', variant: 'danger' }))) return;
    setTransferringOwnership(true);
    try {
      await runAction(async () => {
        await guildApi.transferOwnership(guildId, ownershipTargetUserId);
        await refreshAll();
      }, 'Failed to transfer ownership');
    } finally {
      setTransferringOwnership(false);
    }
  };

  const unban = async (userId: string) => {
    await runAction(async () => {
      await guildApi.unbanMember(guildId, userId);
      await refreshAll();
    }, 'Failed to unban user');
  };

  const handleLeaveGuild = async () => {
    if (!(await confirm({ title: 'Leave this server?', description: 'You will need a new invite to rejoin.', confirmLabel: 'Leave', variant: 'danger' }))) return;
    await runAction(async () => {
      await leaveGuild(guildId);
      onClose();
      navigate('/app/friends');
    }, 'Failed to leave server');
  };

  return (
    <div
      className={cn(
        'relative h-full min-h-0 overflow-hidden rounded-[1.5rem] border border-border-subtle/70 bg-bg-primary/90 backdrop-blur-sm',
        isMobile ? 'flex flex-col' : 'flex'
      )}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="pointer-events-none absolute -left-20 top-0 h-72 w-72 rounded-full blur-[120px]" style={{ backgroundColor: 'var(--ambient-glow-primary)' }} />
      <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full blur-[140px]" style={{ backgroundColor: 'var(--ambient-glow-success)' }} />

      {isMobile ? (
        <div className="relative z-10 border-b border-border-subtle/70 bg-bg-secondary/70 px-3 pb-2.5 pt-[calc(var(--safe-top)+0.75rem)]">
          <div className="mb-2 flex items-center justify-between">
            <div className="truncate text-xs font-semibold uppercase tracking-wide text-text-muted">
              {guild?.name || guildName}
            </div>
            <button onClick={onClose} className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75">
              <X size={17} />
            </button>
          </div>
          <div className="scrollbar-thin flex items-center gap-2 overflow-x-auto pb-1">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors',
                  activeSection === item.id
                    ? 'border-border-strong bg-bg-mod-strong text-text-primary'
                    : 'border-border-subtle/70 bg-bg-mod-subtle text-text-secondary'
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="relative z-10 w-72 shrink-0 overflow-y-auto border-r border-border-subtle/70 bg-bg-secondary/65 px-5 py-10">
          <div className="ml-auto w-full max-w-[236px]">
            <button
              onClick={onClose}
              className="group mb-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
            >
              <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
              Back
            </button>
            <div className="px-2 pb-4 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {guild?.name || guildName}
            </div>
            <div className="flex flex-col gap-3">
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
        </div>
      )}

      <div className={cn('relative z-10 flex-1 overflow-y-auto', isMobile ? 'px-6 pb-[calc(var(--safe-bottom)+1rem)] pt-6' : 'px-10 py-8')}>
        <div className="w-full max-w-[740px] space-y-8">
        {!isMobile && (
          <div className="sticky top-2 z-20 ml-auto mb-4 flex w-fit flex-col items-center gap-1 md:top-3">
            <button onClick={onClose} className="command-icon-btn rounded-full border border-border-strong bg-bg-secondary/75">
              <X size={18} />
            </button>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Esc</span>
          </div>
        )}

        {!isMobile && (
          <nav className="mb-4 flex items-center gap-1.5 text-xs text-text-muted" aria-label="Breadcrumb">
            <span className="font-medium">{guild?.name || guildName}</span>
            <span aria-hidden>/</span>
            <span className="font-medium">Settings</span>
            <span aria-hidden>/</span>
            <span className="font-semibold text-text-secondary">
              {NAV_ITEMS.find(i => i.id === activeSection)?.label ?? activeSection}
            </span>
          </nav>
        )}
        {error && (
          <div className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-2.5 text-sm font-medium text-accent-danger">{error}</div>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
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
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
            <h2 className="settings-section-title !mb-0">Server Overview</h2>
            <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
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
              <div className="flex-1 card-stack-relaxed">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Server Name</span>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field mt-3" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="input-field mt-3 resize-none"
                    placeholder="Describe your server"
                  />
                </label>
              </div>
            </div>
            <div className="settings-action-row">
              <button className="btn-primary" onClick={() => void saveOverview()}>Save Changes</button>
              {guild && authUser && guild.owner_id !== authUser.id && (
                <button className="btn-ghost" onClick={() => void handleLeaveGuild()}>
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
            {guild && authUser && guild.owner_id === authUser.id && (
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
                    onChange={(e) => setOwnershipTargetUserId(e.target.value)}
                  >
                    {ownershipCandidates.map((member) => (
                      <option key={member.user.id} value={member.user.id}>
                        {(member.nick || member.user.username) + ' (' + member.user.id + ')'}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
                    onClick={() => void transferOwnership()}
                    disabled={transferringOwnership || !ownershipTargetUserId}
                  >
                    {transferringOwnership ? 'Transferring...' : 'Transfer'}
                  </button>
                </div>
              </div>
            )}
            <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm leading-6 text-text-secondary">
              Keep this server profile complete so new members instantly recognize your community and can orient themselves faster.
            </div>
          </div>
        )}

        {activeSection === 'roles' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
            <h2 className="settings-section-title !mb-0">Roles</h2>
            {!canManageRoleSettings && (
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
                        disabled={!canManageRoleSettings}
                        onBlur={(e) => {
                          if (!canManageRoleSettings) return;
                          if (e.target.value !== role.name) void renameRole(role.id, e.target.value);
                        }}
                      />
                      {role.hoist && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border-subtle" style={{ color: 'var(--text-muted)' }}>Hoisted</span>
                      )}
                      {canManageRoleSettings && role.id !== guildId && (
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => isEditing ? cancelRoleEditing() : startEditingRole(role)}
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </button>
                      )}
                      {canManageRoleSettings && role.id !== guildId && (
                        <button className="icon-btn" onClick={() => void deleteRole(role.id)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    {isEditing && (
                      <div className="card-surface ml-0 mt-3 rounded-xl border border-border-subtle bg-bg-primary/60 p-6 space-y-6 sm:ml-8">
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
                        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
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
                                  onChange={() => togglePermission(perm.flag)}
                                  className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                                />
                                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{perm.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="settings-action-row">
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
            {canManageRoleSettings && (
              <div className="settings-action-row">
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
            )}
          </div>
        )}

        {activeSection === 'members' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Members</h2>
            <input type="text" placeholder="Search members" className="input-field" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} />
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
                      {canManageRoleSettings && (
                        <button
                          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => {
                            if (editingMemberRoleUserId === member.user.id) {
                              setEditingMemberRoleUserId(null);
                              setDraftMemberRoleIds([]);
                              return;
                            }
                            startEditingMemberRoles(member);
                          }}
                        >
                          {editingMemberRoleUserId === member.user.id ? 'Close Roles' : 'Roles'}
                        </button>
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
                    <div className="card-surface ml-10 mt-2 rounded-xl border border-accent-danger/30 bg-accent-danger/5 p-3 space-y-2">
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
                  {canManageRoleSettings && editingMemberRoleUserId === member.user.id && (
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
                                onChange={() =>
                                  setDraftMemberRoleIds((prev) => toggleRoleId(prev, role.id))
                                }
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
                        <button
                          className="btn-primary"
                          onClick={() => void saveMemberRoles(member.user.id)}
                        >
                          Save Roles
                        </button>
                        <button
                          className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => {
                            setEditingMemberRoleUserId(null);
                            setDraftMemberRoleIds([]);
                          }}
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
          <ChannelManager
            guildId={guildId}
            channels={channels}
            roles={roles}
            canManageRoles={canManageRoleSettings}
            onRefresh={refreshAll}
          />
        )}

        {activeSection === 'invites' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Invites</h2>
            <div className="settings-action-row">
              <button className="btn-primary text-sm" onClick={() => void createInvite()}>
                Create Invite
              </button>
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

        {activeSection === 'emojis' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Emojis</h2>
            {!canManageEmojis && (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
                You can view server emojis, but Manage Emojis permission is required to add, rename, or delete.
              </div>
            )}

            {canManageEmojis && (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <input
                    className="input-field"
                    placeholder="emoji_name"
                    value={newEmojiName}
                    maxLength={32}
                    onChange={(e) => setNewEmojiName(e.target.value)}
                  />
                  <label className="inline-flex h-[2.9rem] cursor-pointer items-center justify-center rounded-lg border border-border-subtle bg-bg-primary/50 px-3.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary">
                    <input
                      type="file"
                      accept="image/png,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (!file) {
                          setNewEmojiFile(null);
                          return;
                        }
                        if (file.type !== 'image/png' && file.type !== 'image/gif') {
                          setError('Only PNG and GIF emoji files are supported.');
                          e.currentTarget.value = '';
                          return;
                        }
                        if (file.size > 256 * 1024) {
                          setError('Emoji image must be 256 KB or less.');
                          e.currentTarget.value = '';
                          return;
                        }
                        setError(null);
                        setNewEmojiFile(file);
                      }}
                    />
                    <span className="truncate">
                      {newEmojiFile ? newEmojiFile.name : 'Select PNG/GIF (256 KB max)'}
                    </span>
                  </label>
                  <button className="btn-primary h-[2.9rem] min-w-[8rem]" onClick={() => void createEmoji()}>
                    Upload
                  </button>
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
                              value={editingEmojiName}
                              maxLength={32}
                              onChange={(e) => setEditingEmojiName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveEmojiName(emoji.id);
                                if (e.key === 'Escape') {
                                  setEditingEmojiId(null);
                                  setEditingEmojiName('');
                                }
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
                      {canManageEmojis && (
                        <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                          {editing ? (
                            <>
                              <button className="btn-primary" onClick={() => void saveEmojiName(emoji.id)}>
                                Save
                              </button>
                              <button
                                className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                                onClick={() => {
                                  setEditingEmojiId(null);
                                  setEditingEmojiName('');
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                              onClick={() => startEditingEmoji(emoji)}
                            >
                              Rename
                            </button>
                          )}
                          <button
                            className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/12"
                            onClick={() => void deleteEmoji(emoji.id)}
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
                <p className="text-sm text-text-muted">No custom emojis uploaded yet.</p>
              </div>
            )}
          </div>
        )}

        {activeSection === 'webhooks' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Webhooks</h2>
            {!canManageWebhooks && (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
                You need the Manage Webhooks permission to create, edit, or delete webhooks.
              </div>
            )}
            {canManageWebhooks && (
              <>
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Filter</div>
                  <select
                    className="select-field"
                    value={webhookFilterChannelId}
                    onChange={(e) => setWebhookFilterChannelId(e.target.value)}
                  >
                    <option value="all">All channels</option>
                    {channels
                      .filter((channel) => channel.type === 0 || channel.channel_type === 0)
                      .sort((a, b) => a.position - b.position)
                      .map((channel) => (
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
                      onChange={(e) => setNewWebhookName(e.target.value)}
                    />
                    <select
                      className="select-field"
                      value={newWebhookChannelId}
                      onChange={(e) => setNewWebhookChannelId(e.target.value)}
                    >
                      {channels
                        .filter((channel) => channel.type === 0 || channel.channel_type === 0)
                        .sort((a, b) => a.position - b.position)
                        .map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            #{channel.name || 'unnamed'}
                          </option>
                        ))}
                    </select>
                    <button className="btn-primary h-[2.9rem] min-w-[8rem]" onClick={() => void createWebhook()}>
                      Create
                    </button>
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
                              onChange={(e) => setEditingWebhookName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveWebhookName(webhook.id);
                                if (e.key === 'Escape') {
                                  setEditingWebhookId(null);
                                  setEditingWebhookName('');
                                }
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
                                onClick={() => void copyWebhookUrl(webhook.id)}
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
                              <button className="btn-primary" onClick={() => void saveWebhookName(webhook.id)}>
                                Save
                              </button>
                              <button
                                className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                                onClick={() => {
                                  setEditingWebhookId(null);
                                  setEditingWebhookName('');
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                              onClick={() => startEditingWebhook(webhook)}
                            >
                              Rename
                            </button>
                          )}
                          <button
                            className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary disabled:opacity-60"
                            onClick={() => void inspectWebhook(webhook.id)}
                            disabled={webhookInspectingId === webhook.id}
                          >
                            {webhookInspectingId === webhook.id ? 'Refreshing...' : 'Refresh'}
                          </button>
                          <button
                            className="rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/12"
                            onClick={() => void deleteWebhook(webhook.id)}
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
                                onChange={(e) =>
                                  setWebhookTestMessages((prev) => ({ ...prev, [webhook.id]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void executeWebhookTest(webhook.id);
                                  }
                                }}
                              />
                              <button
                                className="btn-primary"
                                onClick={() => void executeWebhookTest(webhook.id)}
                                disabled={webhookExecutingId === webhook.id || !testMessage.trim()}
                              >
                                {webhookExecutingId === webhook.id ? 'Sending...' : 'Send Test'}
                              </button>
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
        )}

        {activeSection === 'bots' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Bots</h2>
            {!canManageRoleSettings && (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
                You need Manage Server permission to add or remove bots.
              </div>
            )}
            {canManageRoleSettings && (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
                <div className="space-y-3.5">
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <select
                      className="select-field"
                      value={selectedOwnBotId}
                      onChange={(e) => setSelectedOwnBotId(e.target.value)}
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
                    <button
                      className="btn-primary h-[2.9rem] min-w-[8rem]"
                      onClick={() => {
                        if (!selectedOwnBotId) return;
                        void runAction(async () => {
                          await botApi.addBotToGuild(guildId, { application_id: selectedOwnBotId });
                          await refreshAll();
                        }, 'Failed to add bot');
                      }}
                      disabled={!selectedOwnBotId}
                    >
                      Add Owned Bot
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <input
                      className="input-field"
                      placeholder="Third-party Bot Application ID"
                      value={addBotId}
                      onChange={(e) => setAddBotId(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && addBotId.trim()) {
                          void runAction(async () => {
                            await botApi.addBotToGuild(guildId, { application_id: addBotId.trim() });
                            setAddBotId('');
                            await refreshAll();
                          }, 'Failed to add bot');
                        }
                      }}
                    />
                    <button
                      className="btn-primary h-[2.9rem] min-w-[8rem]"
                      onClick={() => {
                        if (!addBotId.trim()) return;
                        void runAction(async () => {
                          await botApi.addBotToGuild(guildId, { application_id: addBotId.trim() });
                          setAddBotId('');
                          await refreshAll();
                        }, 'Failed to add bot');
                      }}
                    >
                      Add by ID
                    </button>
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
                  {canManageRoleSettings && (
                    <button
                      className="rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
                      onClick={() => {
                        void runAction(async () => {
                          await botApi.removeBotFromGuild(guildId, entry.application.id);
                          await refreshAll();
                        }, 'Failed to remove bot');
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {guildBots.length === 0 && (
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
                  <Bot size={36} className="mx-auto mb-2 text-text-muted" />
                  <p className="text-sm text-text-muted">No bots installed in this server.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeSection === 'bans' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Bans</h2>
            <div className="card-stack">
              {bans.map((ban) => (
                <div key={ban.user.id} className="card-surface flex flex-wrap items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
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

        {activeSection === 'events' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-0 max-sm:!p-0">
            <EventList guildId={guildId} />
          </div>
        )}

        {activeSection === 'audit-log' && (
          <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
            <h2 className="settings-section-title !mb-0">Audit Log</h2>
            <div className="card-stack">
              {auditEntries.map((entry) => (
                <div key={entry.id} className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-3.5 py-3">
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
