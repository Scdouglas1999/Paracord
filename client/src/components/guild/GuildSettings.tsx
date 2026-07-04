import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { X, Shield, Users, Hash, Link, Gavel, ScrollText, RefreshCw, Smile, Calendar, Bot, ArrowLeft, HardDrive, LayoutTemplate, MessageSquare, TrendingUp } from 'lucide-react';
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
import type { AuditLogEntry, Ban, Channel, Guild, GuildBotConfig, GuildEmoji, Invite, Member, ModerationReport, Role } from '../../types';
import type { Webhook } from '../../types';
import { isAllowedImageMimeType, isSafeImageDataUrl, safeStoredImageDataUrl } from '../../lib/security';
import { resolveApiBaseUrl } from '../../lib/config/apiBaseUrl';
import { cn } from '../../lib/utils';
import { writeClipboardText } from '../../lib/clipboard';
import { confirm } from '../../stores/confirmStore';
import { useMobile } from '../../hooks/useMobile';
import { toast } from '../../stores/toastStore';
import { EventList } from './EventList';
import { ChannelManager } from './ChannelManager';
import { FileStorageSection } from './FileStorageSection';
import { ServerHubSettings } from './ServerHubSettings';
import { BotStoreSection } from './BotStoreSection';
import { OnboardingSettingsSection } from './OnboardingSettingsSection';
import { EconomySettingsSection } from './EconomySettingsSection';
import {
  AuditLogSection,
  BansSection,
  BotsSection,
  EmojisSection,
  InvitesSection,
  MembersSection,
  ModerationTemplatesSection,
  OverviewSection,
  ReportsSection,
  RolesSection,
  WebhooksSection,
} from './GuildSettingsSections';
import { moderationTemplateApi } from '../../api/moderationTemplates';
import type { ModerationTemplate } from '../../api/moderationTemplates';
import { ErrorBanner, LoadingSpinner } from '../ui/Feedback';
import { Button } from '../ui/Button';

interface GuildSettingsProps {
  guildId: string;
  guildName: string;
  onClose: () => void;
  initialSection?: string | null;
  initialChannelId?: string | null;
}

type SettingsSection = 'overview' | 'server-hub' | 'bot-store' | 'roles' | 'members' | 'channels' | 'invites' | 'emojis' | 'webhooks' | 'bots' | 'events' | 'onboarding' | 'bans' | 'reports' | 'audit-log' | 'file-storage' | 'mod-templates' | 'economy';

export function getGuildSettingsErrorMessage(err: unknown, fallback: string): string {
  const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
  if (responseData?.message) return responseData.message;
  if (responseData?.error) return responseData.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const NAV_ITEMS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Hash size={16} /> },
  { id: 'server-hub', label: 'Server Hub', icon: <LayoutTemplate size={16} /> },
  { id: 'bot-store', label: 'Bot Store', icon: <Bot size={16} /> },
  { id: 'roles', label: 'Roles', icon: <Shield size={16} /> },
  { id: 'members', label: 'Members', icon: <Users size={16} /> },
  { id: 'channels', label: 'Channels', icon: <Hash size={16} /> },
  { id: 'invites', label: 'Invites', icon: <Link size={16} /> },
  { id: 'emojis', label: 'Emojis', icon: <Smile size={16} /> },
  { id: 'webhooks', label: 'Webhooks', icon: <Link size={16} /> },
  { id: 'bots', label: 'Bots', icon: <Bot size={16} /> },
  { id: 'events', label: 'Events', icon: <Calendar size={16} /> },
  { id: 'onboarding', label: 'Onboarding', icon: <Users size={16} /> },
  { id: 'economy', label: 'Economy', icon: <TrendingUp size={16} /> },
  { id: 'file-storage', label: 'File Storage', icon: <HardDrive size={16} /> },
  { id: 'bans', label: 'Bans', icon: <Gavel size={16} /> },
  { id: 'mod-templates', label: 'Mod Templates', icon: <Shield size={16} /> },
  { id: 'reports', label: 'Reports', icon: <MessageSquare size={16} /> },
  { id: 'audit-log', label: 'Audit Log', icon: <ScrollText size={16} /> },
];

function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return Boolean(value && NAV_ITEMS.some((item) => item.id === value));
}

const NATIVE_BOT_LABELS: Record<string, { name: string; description: string }> = {
  welcome_bot: {
    name: 'Welcome Bot',
    description: 'Automatically greets new members.',
  },
  auto_mod: {
    name: 'Auto-Moderator',
    description: 'Filters restricted words and basic spam.',
  },
};

export function GuildSettings({ guildId, guildName, onClose, initialSection, initialChannelId }: GuildSettingsProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const leaveGuild = useGuildStore((s) => s.leaveGuild);
  const removeGuild = useGuildStore((s) => s.removeGuild);
  const authUser = useAuthStore((s) => s.user);
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManageRoleSettings = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const canManageEmojis = isAdmin || hasPermission(permissions, Permissions.MANAGE_EMOJIS);
  const canManageWebhooks = isAdmin || hasPermission(permissions, Permissions.MANAGE_WEBHOOKS);
  const memberRoleId = guildId;
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    isSettingsSection(initialSection) ? initialSection : 'overview'
  );
  const [mobileShowNav, setMobileShowNav] = useState(true);
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
  const [modTemplates, setModTemplates] = useState<ModerationTemplate[]>([]);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [reportStatusFilter, setReportStatusFilter] = useState<
    'all' | 'open' | 'dismissed' | 'warned' | 'muted' | 'banned' | 'approved' | 'rejected'
  >('open');
  const [reportResolvingId, setReportResolvingId] = useState<string | null>(null);
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
  const [vanityCode, setVanityCode] = useState('');
  const [savingVanity, setSavingVanity] = useState(false);
  const [showDeleteGuildDialog, setShowDeleteGuildDialog] = useState(false);
  const [deleteGuildConfirmName, setDeleteGuildConfirmName] = useState('');
  const [deletingGuild, setDeletingGuild] = useState(false);
  const isMobile = useMobile();

  useEffect(() => {
    if (!isSettingsSection(initialSection)) return;
    setActiveSection(initialSection);
    if (isMobile) {
      setMobileShowNav(false);
    }
  }, [initialSection, isMobile]);

  const selectMobileSection = useCallback((section: SettingsSection) => {
    setActiveSection(section);
    setMobileShowNav(false);
    history.pushState({ settingsSection: section }, '');
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const handlePopState = (e: PopStateEvent) => {
      if (mobileShowNav) {
        onClose();
      } else {
        e.preventDefault?.();
        setMobileShowNav(true);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, mobileShowNav, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const runAction = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(getGuildSettingsErrorMessage(err, fallback));
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
      const reportsPromise = canManageRoleSettings
        ? guildApi.getReports(guildId, reportStatusFilter === 'all' ? undefined : { status: reportStatusFilter }).catch(() => ({ data: { reports: [] as ModerationReport[] } }))
        : Promise.resolve({ data: { reports: [] as ModerationReport[] } });
      const modTemplatesPromise = canManageRoleSettings
        ? moderationTemplateApi.list(guildId).catch(() => ({ data: [] as ModerationTemplate[] }))
        : Promise.resolve({ data: [] as ModerationTemplate[] });
      const results = await Promise.allSettled([
          guildApi.get(guildId),
          guildApi.getRoles(guildId),
          guildApi.getMembers(guildId),
          guildApi.getChannels(guildId),
          guildApi.getInvites(guildId),
          emojiApi.listGuild(guildId),
          webhookPromise,
          botsPromise,
          ownAppsPromise,
          reportsPromise,
          guildApi.getBans(guildId),
          guildApi.getAuditLog(guildId),
          modTemplatesPromise,
        ]);
      // Guild info is essential — if it fails, show an error
      const guildResult = results[0];
      if (guildResult.status === 'rejected') {
        throw guildResult.reason;
      }
      const guildRes = guildResult.value;
      setGuild(guildRes.data);
      setName(guildRes.data.name || guildName);
      setDescription(guildRes.data.description || '');
      setVanityCode(guildRes.data.vanity_url_code || '');
      setIconDataUrl(safeStoredImageDataUrl(guildRes.data.icon_hash));
      // Non-essential data — use results if available, fall back to defaults
      if (results[1].status === 'fulfilled') setRoles(results[1].value.data);
      if (results[2].status === 'fulfilled') setMembers(results[2].value.data);
      let normalizedChannels: typeof channels = [];
      if (results[3].status === 'fulfilled') {
        normalizedChannels = results[3].value.data.map((channel) => ({
          ...channel,
          required_role_ids: channel.required_role_ids ?? [],
        }));
        setChannels(normalizedChannels);
      }
      if (results[4].status === 'fulfilled') setInvites(results[4].value.data);
      if (results[5].status === 'fulfilled') setEmojis(results[5].value.data);
      if (results[6].status === 'fulfilled') setWebhooks(results[6].value.data);
      if (results[7].status === 'fulfilled') setGuildBots(results[7].value.data);
      if (results[8].status === 'fulfilled') {
        const ownAppsData = results[8].value.data;
        setUserBotApps(ownAppsData);
        setSelectedOwnBotId((current) => {
          if (!ownAppsData.length) return '';
          if (current && ownAppsData.some((app) => app.id === current)) return current;
          return ownAppsData[0].id;
        });
      }
      if (results[9].status === 'fulfilled') setReports(results[9].value.data.reports || []);
      if (results[10].status === 'fulfilled') setBans(results[10].value.data);
      if (results[11].status === 'fulfilled') setAuditEntries(results[11].value.data.audit_log_entries || []);
      if (results[12].status === 'fulfilled') setModTemplates(results[12].value.data);
      if (!newWebhookChannelId && normalizedChannels.length > 0) {
        const firstTextChannel = normalizedChannels.find((c) => c.type === 0 || c.channel_type === 0);
        if (firstTextChannel) {
          setNewWebhookChannelId(firstTextChannel.id);
        }
      }
    } catch (err: unknown) {
      setError(getGuildSettingsErrorMessage(err, 'Failed to load guild settings'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAll();
  }, [guildId, canManageWebhooks, webhookFilterChannelId, canManageRoleSettings, reportStatusFilter]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requested = params.get('section');
    if (
      requested === 'overview' ||
      requested === 'server-hub' ||
      requested === 'bot-store' ||
      requested === 'roles' ||
      requested === 'members' ||
      requested === 'channels' ||
      requested === 'invites' ||
      requested === 'emojis' ||
      requested === 'webhooks' ||
      requested === 'bots' ||
      requested === 'events' ||
      requested === 'onboarding' ||
      requested === 'bans' ||
      requested === 'mod-templates' ||
      requested === 'reports' ||
      requested === 'audit-log' ||
      requested === 'file-storage' ||
      requested === 'economy'
    ) {
      setActiveSection(requested);
    }
  }, [location.search]);

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
  const nativeBotEntries = useMemo(() => {
    const settings = guild?.bot_settings;
    if (!settings || typeof settings !== 'object') return [] as Array<{ id: string; name: string; description: string }>;

    const entries: Array<{ id: string; name: string; description: string }> = [];
    for (const [botId, rawConfig] of Object.entries(settings as Record<string, unknown>)) {
      if (!rawConfig || typeof rawConfig !== 'object') continue;
      if ((rawConfig as { enabled?: boolean }).enabled !== true) continue;
      const meta = NATIVE_BOT_LABELS[botId];
      entries.push({
        id: botId,
        name: meta?.name ?? botId.replace(/_/g, ' '),
        description: meta?.description ?? 'Native Paracord bot',
      });
    }
    return entries;
  }, [guild?.bot_settings]);

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

  const saveOverview = async () => {
    await runAction(async () => {
      await guildApi.update(guildId, {
        name,
        description,
        icon: iconDataUrl && isSafeImageDataUrl(iconDataUrl) ? iconDataUrl : undefined,
      });
      await refreshAll();
    }, 'Failed to save server overview');
  };

  const saveVanityUrl = async () => {
    setSavingVanity(true);
    setError(null);
    try {
      const code = vanityCode.trim() || null;
      await guildApi.updateVanityUrl(guildId, code);
      await refreshAll();
    } catch (err: unknown) {
      setError(getGuildSettingsErrorMessage(err, 'Failed to update vanity URL'));
    } finally {
      setSavingVanity(false);
    }
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
    const deletedRole = roles.find((role) => role.id === roleId);
    await runAction(async () => {
      await guildApi.deleteRole(guildId, roleId);
      invalidateGuildPermissionCache(guildId);
      await refreshAll();
      if (deletedRole) {
        toast.info('Role deleted.', 6000, {
          label: 'Undo',
          onClick: async () => {
            const rawPermissions =
              typeof deletedRole.permissions === 'string'
                ? Number.parseInt(deletedRole.permissions, 10)
                : deletedRole.permissions;
            await guildApi.createRole(guildId, {
              name: deletedRole.name,
              color: deletedRole.color,
              permissions: Number.isFinite(rawPermissions) ? rawPermissions : undefined,
              hoist: deletedRole.hoist,
              mentionable: deletedRole.mentionable,
            });
            await refreshAll();
            invalidateGuildPermissionCache(guildId);
            toast.success('Role restored.');
          },
        });
      }
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
    const deletedEmoji = emojis.find((emoji) => emoji.id === emojiId);
    let undoFile: File | null = null;
    if (deletedEmoji) {
      try {
        const emojiResponse = await fetch(emojiApi.imageUrl(guildId, emojiId), {
          credentials: 'include',
        });
        if (emojiResponse.ok) {
          const blob = await emojiResponse.blob();
          const mime = deletedEmoji.animated ? 'image/gif' : 'image/png';
          undoFile = new File([blob], `${deletedEmoji.name}.${deletedEmoji.animated ? 'gif' : 'png'}`, {
            type: blob.type || mime,
          });
        }
      } catch {
        // Best-effort snapshot for undo.
      }
    }
    await runAction(async () => {
      await emojiApi.delete(guildId, emojiId);
      if (editingEmojiId === emojiId) {
        setEditingEmojiId(null);
        setEditingEmojiName('');
      }
      await refreshAll();
      if (deletedEmoji && undoFile) {
        toast.info('Emoji deleted.', 6000, {
          label: 'Undo',
          onClick: async () => {
            await emojiApi.create(guildId, {
              name: deletedEmoji.name,
              file: undoFile,
            });
            await refreshAll();
            toast.success('Emoji restored.');
          },
        });
      }
    }, 'Failed to delete emoji');
  };

  const removeNativeBot = async (botId: string) => {
    if (!canManageRoleSettings) return;
    await runAction(async () => {
      const currentSettings =
        guild?.bot_settings && typeof guild.bot_settings === 'object'
          ? ({ ...guild.bot_settings } as Record<string, GuildBotConfig>)
          : {};
      const currentConfig = currentSettings[botId];
      if (!currentConfig) return;
      currentSettings[botId] = {
        ...currentConfig,
        enabled: false,
      };
      await guildApi.update(guildId, { bot_settings: currentSettings });
      await refreshAll();
    }, 'Failed to remove native bot');
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
    const deletedWebhook = webhooks.find((webhook) => webhook.id === webhookId);
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
      if (deletedWebhook) {
        toast.info('Webhook deleted.', 6000, {
          label: 'Undo',
          onClick: async () => {
            const payload: { name: string; channel_id?: string } = {
              name: deletedWebhook.name,
            };
            if (deletedWebhook.channel_id) {
              payload.channel_id = deletedWebhook.channel_id;
            }
            await webhookApi.create(guildId, payload);
            await refreshAll();
            toast.success('Webhook restored.');
          },
        });
      }
    }, 'Failed to delete webhook');
  };

  const copyWebhookUrl = async (webhookId: string) => {
    const token = issuedWebhookTokens[webhookId];
    if (!token) return;
    const url = `${webhookBase}/api/v1/webhooks/${webhookId}/${token}`;
    try {
      await writeClipboardText(url);
      setCopiedWebhookId(webhookId);
      window.setTimeout(() => {
        setCopiedWebhookId((current) => (current === webhookId ? null : current));
      }, 1800);
    } catch (err) {
      setError(`Could not copy webhook URL: ${getGuildSettingsErrorMessage(err, 'Clipboard unavailable')}`);
    }
  };

  const inspectWebhook = async (webhookId: string) => {
    if (!canManageWebhooks || webhookInspectingId) return;
    setWebhookInspectingId(webhookId);
    try {
      const { data } = await webhookApi.get(webhookId);
      setWebhooks((prev) => prev.map((webhook) => (webhook.id === webhookId ? { ...webhook, ...data } : webhook)));
    } catch (err) {
      setError(`Failed to refresh webhook details: ${getGuildSettingsErrorMessage(err, 'Request failed')}`);
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
    } catch (err) {
      setError(`Failed to execute webhook test message: ${getGuildSettingsErrorMessage(err, 'Request failed')}`);
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

  const createModTemplate = async (data: {
    name: string;
    action_type: number;
    duration_minutes?: number;
    reason_template?: string;
    dm_template?: string;
  }) => {
    await runAction(async () => {
      await moderationTemplateApi.create(guildId, data);
      const res = await moderationTemplateApi.list(guildId);
      setModTemplates(res.data);
    }, 'Failed to create template');
  };

  const deleteModTemplate = async (templateId: string) => {
    const ok = await confirm({
      title: 'Delete Template',
      description: 'Are you sure you want to delete this moderation template?',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    await runAction(async () => {
      await moderationTemplateApi.delete(guildId, templateId);
      setModTemplates((prev) => prev.filter((t) => t.id !== templateId));
    }, 'Failed to delete template');
  };

  const applyModTemplate = async (
    templateId: string,
    data: { target_user_id: string; reason?: string; dm_message?: string }
  ) => {
    setError(null);
    try {
      await moderationTemplateApi.apply(guildId, templateId, data);
      await refreshAll();
    } catch (err: unknown) {
      const message = getGuildSettingsErrorMessage(err, 'Failed to apply template');
      setError(message);
      throw new Error(message);
    }
  };

  const resolveReport = async (
    reportId: string,
    action: 'dismiss' | 'warn' | 'mute' | 'ban' | 'approve' | 'reject'
  ) => {
    if (reportResolvingId) return;
    setReportResolvingId(reportId);
    try {
      await runAction(async () => {
        await guildApi.resolveReport(guildId, reportId, {
          action,
          mute_minutes: action === 'mute' ? 15 : undefined,
        });
        await refreshAll();
      }, 'Failed to resolve report');
    } finally {
      setReportResolvingId(null);
    }
  };

  const handleLeaveGuild = async () => {
    if (!(await confirm({ title: 'Leave this server?', description: 'You will need a new invite to rejoin.', confirmLabel: 'Leave', variant: 'danger' }))) return;
    await runAction(async () => {
      await leaveGuild(guildId);
      onClose();
      navigate('/app/friends');
    }, 'Failed to leave server');
  };

  const handleDeleteGuild = async () => {
    if (!guild || !authUser || guild.owner_id !== authUser.id) return;
    if (deleteGuildConfirmName !== guild.name) return;
    setDeletingGuild(true);
    try {
      await guildApi.delete(guildId);
      removeGuild(guildId);
      onClose();
      navigate('/app/friends');
    } catch (err: unknown) {
      setError(getGuildSettingsErrorMessage(err, 'Failed to delete server'));
      setDeletingGuild(false);
      setShowDeleteGuildDialog(false);
      setDeleteGuildConfirmName('');
    }
  };

  return (
    <div
      className={cn(
        'relative h-full min-h-0 overflow-hidden rounded-[1rem] border border-border-subtle bg-bg-primary',
        isMobile ? 'flex flex-col' : 'flex'
      )}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {!isMobile && (
        <div className="absolute right-6 top-6 z-50 flex flex-col items-center gap-1">
          <button
            onClick={onClose}
            className="command-icon-btn rounded-full border border-border-strong bg-bg-secondary/75 hover:bg-bg-mod-subtle"
            aria-label="Close server settings"
            title="Close server settings"
          >
            <X size={18} />
          </button>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Esc</span>
        </div>
      )}

      {isMobile ? (
        mobileShowNav ? (
          <div className="relative z-10 flex flex-1 flex-col overflow-y-auto bg-bg-secondary/70 pt-[calc(var(--safe-top)+0.75rem)]">
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="truncate text-xs font-semibold uppercase tracking-wide text-text-muted">
                {guild?.name || guildName}
              </div>
              <button
                onClick={onClose}
                className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
                aria-label="Close server settings"
                title="Close server settings"
              >
                <X size={17} />
              </button>
            </div>
            <div className="flex flex-col px-2 pb-[calc(var(--safe-bottom)+1rem)]">
              {NAV_ITEMS.map(item => (
                <button
                  key={item.id}
                  onClick={() => selectMobileSection(item.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-mod-subtle active:bg-bg-mod-strong"
                >
                  <span className="text-text-muted">{item.icon}</span>
                  <span className="flex-1 text-left">{item.label}</span>
                  <ArrowLeft size={14} className="rotate-180 text-text-muted" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="relative z-10 flex items-center gap-2 border-b border-border-subtle/70 bg-bg-secondary/70 px-3 pb-2.5 pt-[calc(var(--safe-top)+0.75rem)]">
            <button
              onClick={() => setMobileShowNav(true)}
              className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
              aria-label="Back to settings menu"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="flex-1 truncate text-sm font-semibold text-text-primary">
              {NAV_ITEMS.find(i => i.id === activeSection)?.label ?? activeSection}
            </div>
            <button
              onClick={onClose}
              className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
              aria-label="Close server settings"
              title="Close server settings"
            >
              <X size={17} />
            </button>
          </div>
        )
      ) : (
        <div className="relative z-10 w-72 shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-secondary px-5 py-10">
          <div className="ml-auto w-full max-w-[236px]">
            <button
              onClick={onClose}
              className="group mb-4 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-label text-text-muted outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
              Back
            </button>
            <div className="px-2 pb-3 text-section uppercase text-text-muted">
              {guild?.name || guildName}
            </div>
            <div className="flex flex-col gap-1">
              {NAV_ITEMS.map(item => {
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`settings-nav-item relative ${active ? 'active' : ''}`}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-secondary"
                      />
                    )}
                    <span className={active ? 'text-accent-primary' : 'text-channel-icon'}>{item.icon}</span>
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {(!isMobile || !mobileShowNav) && (
        <div className={cn('relative z-10 flex-1 overflow-y-auto', isMobile ? 'px-6 pb-[calc(var(--safe-bottom)+1rem)] pt-6' : 'px-10 py-8')}>
          <div className="w-full max-w-[740px] space-y-8">
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
            {error && <ErrorBanner className="mb-8" message={error} onRetry={() => void refreshAll()} />}
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                onClick={() => void refreshAll()}
                variant="outline"
                size="sm"
                className="h-10 gap-2"
              >
                <RefreshCw size={15} />
                Refresh
              </Button>
              {loading && <LoadingSpinner size="sm" label="Loading..." />}
            </div>

            {activeSection === 'overview' && (
              <OverviewSection
                guild={guild}
                authUserId={authUser?.id}
                name={name}
                description={description}
                vanityCode={vanityCode}
                savingVanity={savingVanity}
                iconDataUrl={iconDataUrl}
                ownershipTargetUserId={ownershipTargetUserId}
                ownershipCandidates={ownershipCandidates}
                transferringOwnership={transferringOwnership}
                members={members}
                roles={roles}
                channels={channels}
                invites={invites}
                showDeleteGuildDialog={showDeleteGuildDialog}
                deleteGuildConfirmName={deleteGuildConfirmName}
                deletingGuild={deletingGuild}
                onNameChange={setName}
                onDescriptionChange={setDescription}
                onVanityCodeChange={setVanityCode}
                onIconChange={onGuildIconChange}
                onOwnershipTargetChange={setOwnershipTargetUserId}
                onDeleteGuildConfirmNameChange={setDeleteGuildConfirmName}
                onSave={() => void saveOverview()}
                onSaveVanity={() => void saveVanityUrl()}
                onLeave={() => void handleLeaveGuild()}
                onTransferOwnership={() => void transferOwnership()}
                onShowDeleteDialog={() => { setShowDeleteGuildDialog(true); setDeleteGuildConfirmName(''); }}
                onHideDeleteDialog={() => { setShowDeleteGuildDialog(false); setDeleteGuildConfirmName(''); }}
                onDeleteGuild={() => void handleDeleteGuild()}
              />
            )}

            {activeSection === 'server-hub' && guild && (
              <ServerHubSettings
                guild={guild}
                channels={channels}
                onUpdate={() => refreshAll()}
                setError={setError}
              />
            )}

            {activeSection === 'roles' && (
              <RolesSection
                roles={roles}
                canManage={canManageRoleSettings}
                guildId={guildId}
                newRoleName={newRoleName}
                newRoleColor={newRoleColor}
                editingRoleId={editingRoleId}
                editingRolePermissions={editingRolePermissions}
                editingRoleColor={editingRoleColor}
                editingRoleHoist={editingRoleHoist}
                editingRoleMentionable={editingRoleMentionable}
                onNewRoleNameChange={setNewRoleName}
                onNewRoleColorChange={setNewRoleColor}
                onEditingRoleColorChange={setEditingRoleColor}
                onEditingRolePermissionsToggle={togglePermission}
                onEditingRoleHoistChange={setEditingRoleHoist}
                onEditingRoleMentionableChange={setEditingRoleMentionable}
                onCreateRole={() => void createRole()}
                onRenameRole={(roleId, name) => void renameRole(roleId, name)}
                onStartEditingRole={startEditingRole}
                onSaveRoleEdits={() => void saveRoleEdits()}
                onCancelRoleEditing={cancelRoleEditing}
                onDeleteRole={(roleId) => void deleteRole(roleId)}
                roleColorHex={roleColorHex}
              />
            )}

            {activeSection === 'members' && (
              <MembersSection
                members={members}
                roles={roles}
                canManage={canManageRoleSettings}
                memberRoleId={memberRoleId}
                memberSearch={memberSearch}
                editingMemberRoleUserId={editingMemberRoleUserId}
                draftMemberRoleIds={draftMemberRoleIds}
                banConfirmUserId={banConfirmUserId}
                banReasonInput={banReasonInput}
                onMemberSearchChange={setMemberSearch}
                onStartEditingMemberRoles={startEditingMemberRoles}
                onCancelEditingMemberRoles={() => { setEditingMemberRoleUserId(null); setDraftMemberRoleIds([]); }}
                onToggleDraftRoleId={(roleId) => setDraftMemberRoleIds((prev) => prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId])}
                onSaveMemberRoles={(userId) => void saveMemberRoles(userId)}
                onKickMember={(userId) => void kickMember(userId)}
                onShowBanConfirm={(userId) => { setBanConfirmUserId(userId); setBanReasonInput(''); }}
                onCancelBanConfirm={() => setBanConfirmUserId(null)}
                onBanReasonChange={setBanReasonInput}
                onBanMember={(userId, reason) => void banMember(userId, reason)}
                roleColorHex={roleColorHex}
              />
            )}

            {activeSection === 'channels' && (
              <ChannelManager
                guildId={guildId}
                channels={channels}
                roles={roles}
                canManageRoles={canManageRoleSettings}
                highlightedChannelId={initialChannelId}
                onRefresh={refreshAll}
              />
            )}

            {activeSection === 'invites' && (
              <InvitesSection
                invites={invites}
                onCreateInvite={() => void createInvite()}
                onRevokeInvite={(code) => void revokeInvite(code)}
              />
            )}

            {activeSection === 'emojis' && (
              <EmojisSection
                guildId={guildId}
                emojis={emojis}
                canManage={canManageEmojis}
                newEmojiName={newEmojiName}
                newEmojiFile={newEmojiFile}
                editingEmojiId={editingEmojiId}
                editingEmojiName={editingEmojiName}
                onNewEmojiNameChange={setNewEmojiName}
                onNewEmojiFileChange={(file, err) => {
                  setNewEmojiFile(file);
                  if (err) setError(err);
                  else setError(null);
                }}
                onEditingEmojiNameChange={setEditingEmojiName}
                onCreateEmoji={() => void createEmoji()}
                onStartEditingEmoji={startEditingEmoji}
                onSaveEmojiName={(emojiId) => void saveEmojiName(emojiId)}
                onCancelEditingEmoji={() => { setEditingEmojiId(null); setEditingEmojiName(''); }}
                onDeleteEmoji={(emojiId) => void deleteEmoji(emojiId)}
              />
            )}

            {activeSection === 'webhooks' && (
              <WebhooksSection
                webhooks={webhooks}
                channels={channels}
                canManage={canManageWebhooks}
                webhookFilterChannelId={webhookFilterChannelId}
                newWebhookName={newWebhookName}
                newWebhookChannelId={newWebhookChannelId}
                editingWebhookId={editingWebhookId}
                editingWebhookName={editingWebhookName}
                issuedWebhookTokens={issuedWebhookTokens}
                copiedWebhookId={copiedWebhookId}
                webhookInspectingId={webhookInspectingId}
                webhookExecutingId={webhookExecutingId}
                webhookTestMessages={webhookTestMessages}
                webhookBase={webhookBase}
                onFilterChannelChange={setWebhookFilterChannelId}
                onNewWebhookNameChange={setNewWebhookName}
                onNewWebhookChannelChange={setNewWebhookChannelId}
                onEditingWebhookNameChange={setEditingWebhookName}
                onWebhookTestMessageChange={(webhookId, msg) => setWebhookTestMessages((prev) => ({ ...prev, [webhookId]: msg }))}
                onCreateWebhook={() => void createWebhook()}
                onStartEditingWebhook={startEditingWebhook}
                onSaveWebhookName={(webhookId) => void saveWebhookName(webhookId)}
                onCancelEditingWebhook={() => { setEditingWebhookId(null); setEditingWebhookName(''); }}
                onDeleteWebhook={(webhookId) => void deleteWebhook(webhookId)}
                onCopyWebhookUrl={(webhookId) => void copyWebhookUrl(webhookId)}
                onInspectWebhook={(webhookId) => void inspectWebhook(webhookId)}
                onExecuteWebhookTest={(webhookId) => void executeWebhookTest(webhookId)}
                channelNameById={channelNameById}
              />
            )}

            {activeSection === 'bots' && (
              <BotsSection
                guildId={guildId}
                guildBots={guildBots}
                nativeBotEntries={nativeBotEntries}
                userBotApps={userBotApps}
                selectedOwnBotId={selectedOwnBotId}
                addBotId={addBotId}
                canManage={canManageRoleSettings}
                onSelectedOwnBotIdChange={setSelectedOwnBotId}
                onAddBotIdChange={setAddBotId}
                onAddOwnBot={() => {
                  if (!selectedOwnBotId) return;
                  void runAction(async () => {
                    await botApi.addBotToGuild(guildId, { application_id: selectedOwnBotId });
                    await refreshAll();
                  }, 'Failed to add bot');
                }}
                onAddBotById={() => {
                  if (!addBotId.trim()) return;
                  void runAction(async () => {
                    await botApi.addBotToGuild(guildId, { application_id: addBotId.trim() });
                    setAddBotId('');
                    await refreshAll();
                  }, 'Failed to add bot');
                }}
                onRemoveBot={(applicationId) => {
                  void runAction(async () => {
                    await botApi.removeBotFromGuild(guildId, applicationId);
                    await refreshAll();
                  }, 'Failed to remove bot');
                }}
                onRemoveNativeBot={(botId) => void removeNativeBot(botId)}
              />
            )}

            {activeSection === 'bot-store' && (
              <BotStoreSection
                guildId={guildId}
                canManage={canManageRoleSettings}
                onBotSettingsChanged={() => refreshAll()}
              />
            )}

            {activeSection === 'file-storage' && (
              <FileStorageSection
                guildId={guildId}
                canManage={canManageRoleSettings}
              />
            )}

            {activeSection === 'bans' && (
              <BansSection bans={bans} onUnban={(userId) => unban(userId)} />
            )}
            {activeSection === 'mod-templates' && (
              <ModerationTemplatesSection
                templates={modTemplates}
                onCreateTemplate={createModTemplate}
                onDeleteTemplate={deleteModTemplate}
                onApplyTemplate={applyModTemplate}
              />
            )}
            {activeSection === 'reports' && (
              <ReportsSection
                reports={reports}
                members={members}
                reportStatusFilter={reportStatusFilter}
                onReportStatusFilterChange={setReportStatusFilter}
                reportResolvingId={reportResolvingId}
                onResolveReport={resolveReport}
              />
            )}
            {activeSection === 'events' && (
              <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-0 max-sm:!p-0">
                <EventList guildId={guildId} />
              </div>
            )}

            {activeSection === 'onboarding' && (
              <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
                <OnboardingSettingsSection guildId={guildId} roles={roles} />
              </div>
            )}

            {activeSection === 'economy' && (
              <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
                <EconomySettingsSection guildId={guildId} roles={roles} />
              </div>
            )}

            {activeSection === 'audit-log' && (
              <AuditLogSection
                auditEntries={auditEntries}
                members={members}
                channels={channels}
                roles={roles}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
