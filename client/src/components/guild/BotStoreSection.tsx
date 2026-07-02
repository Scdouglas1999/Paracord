import { useCallback, useState, useMemo, useEffect, type ReactNode } from 'react';
import {
  Bot,
  Check,
  Shield,
  Search,
  Zap,
  Volume2,
  Gamepad2,
  Wrench,
  ArrowRight,
  Smile,
  Settings,
  Save,
  Trash2,
  X,
  Plus,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { Button } from '../ui/Button';
import type { Channel, GuildBotConfig } from '../../types';
import { botStoreApi, type StoreBot } from '../../api/botStore';
import { BotStoreCard } from './BotStoreCard';
import { botApi } from '../../api/bots';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';

interface BotStoreSectionProps {
  guildId: string;
  canManage: boolean;
  onBotSettingsChanged?: () => Promise<void> | void;
}

type RuleType =
  | 'keyword'
  | 'regex'
  | 'link_allowlist'
  | 'link_blocklist'
  | 'spam_duplicate'
  | 'mention_spam'
  | 'account_age_gate';

interface AutoModRule {
  id: string;
  name: string;
  enabled: boolean;
  type: RuleType;
  value: string;
}

interface AutoModConfig extends GuildBotConfig {
  mod_log_channel_id?: string;
  quarantine_channel_id?: string;
  rules?: AutoModRule[];
  anti_raid?: {
    enabled: boolean;
    join_window_seconds: number;
    join_threshold: number;
    lockdown_minutes: number;
    min_account_age_minutes: number;
    auto_action: 'none' | 'kick' | 'ban';
  };
  verification_gate?: {
    enabled: boolean;
    require_ack: boolean;
    waiting_period_minutes: number;
    questions: Array<{ question: string; answer: string }>;
  };
  trigger_logs?: Array<Record<string, unknown>>;
}

interface BuiltInBot {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  features: string[];
}

const BUILT_IN_BOTS: BuiltInBot[] = [
  {
    id: 'welcome_bot',
    name: 'Welcome Bot',
    description: 'Automatically greet new members when they join the server.',
    icon: <Smile className="text-accent-success" size={24} />,
    features: ['Customizable welcome message', 'Channel selection'],
  },
  {
    id: 'auto_mod',
    name: 'Auto-Moderator',
    description: 'Rule-based moderation, raid protection, and verification gates.',
    icon: <Shield className="text-accent-danger" size={24} />,
    features: ['Rule engine', 'Quarantine + mod log', 'Anti-raid + verification gate'],
  },
];

const UPCOMING_BOTS: BuiltInBot[] = [
  {
    id: 'system-roles',
    name: 'Role Assigner',
    description: 'Let users instantly self-assign optional roles via clickable buttons.',
    icon: <Zap className="text-accent-primary" size={24} />,
    features: ['Reaction roles', 'Button UI', 'Multiple role categories'],
  },
  {
    id: 'system-economy',
    name: 'Economy & Leveling',
    description: 'Gamify your server with XP, levels, and leaderboards for active members.',
    icon: <Gamepad2 className="text-accent-warning" size={24} />,
    features: ['Activity tracking', 'Level up alerts', 'Server leaderboard'],
  },
  {
    id: 'system-polls',
    name: 'Polls & Voting',
    description: 'Quickly spin up robust, multi-option polls with real-time tracking.',
    icon: <Volume2 className="text-text-secondary" size={24} />,
    features: ['Multiple choices', 'Anonymous voting', 'Timed polls'],
  },
];

const BOT_ICON_BG_CLASS: Record<string, string> = {
  welcome_bot: 'bg-accent-success/15',
  auto_mod: 'bg-accent-danger/15',
  'system-roles': 'bg-accent-primary/15',
  'system-economy': 'bg-accent-warning/15',
  'system-polls': 'bg-bg-mod-strong',
};

const EMPTY_GUILD_CHANNELS: Channel[] = [];

function makeRule(): AutoModRule {
  return {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'New Rule',
    enabled: true,
    type: 'keyword',
    value: '',
  };
}

function normalizeAutoMod(raw: GuildBotConfig): AutoModConfig {
  const cfg = raw as AutoModConfig;
  return {
    ...cfg,
    mod_log_channel_id: typeof cfg.mod_log_channel_id === 'string' ? cfg.mod_log_channel_id : '',
    quarantine_channel_id:
      typeof cfg.quarantine_channel_id === 'string' ? cfg.quarantine_channel_id : '',
    rules: Array.isArray(cfg.rules)
      ? cfg.rules.map((rule) => ({
          id: String(rule.id || makeRule().id),
          name: String(rule.name || 'Rule'),
          enabled: rule.enabled !== false,
          type: (rule.type as RuleType) || 'keyword',
          value: String(rule.value || ''),
        }))
      : [
          {
            ...makeRule(),
            name: 'Restricted Words',
            value: 'badword1,badword2',
          },
        ],
    anti_raid: {
      enabled: cfg.anti_raid?.enabled === true,
      join_window_seconds: Number(cfg.anti_raid?.join_window_seconds || 30),
      join_threshold: Number(cfg.anti_raid?.join_threshold || 10),
      lockdown_minutes: Number(cfg.anti_raid?.lockdown_minutes || 10),
      min_account_age_minutes: Number(cfg.anti_raid?.min_account_age_minutes || 0),
      auto_action:
        cfg.anti_raid?.auto_action === 'kick' || cfg.anti_raid?.auto_action === 'ban'
          ? cfg.anti_raid.auto_action
          : 'none',
    },
    verification_gate: {
      enabled: cfg.verification_gate?.enabled === true,
      require_ack: cfg.verification_gate?.require_ack !== false,
      waiting_period_minutes: Number(cfg.verification_gate?.waiting_period_minutes || 0),
      questions: Array.isArray(cfg.verification_gate?.questions)
        ? cfg.verification_gate.questions.map((q) => ({
            question: String(q.question || ''),
            answer: String(q.answer || ''),
          }))
        : [],
    },
    trigger_logs: Array.isArray(cfg.trigger_logs) ? cfg.trigger_logs : [],
  };
}

function serializeAutoMod(config: AutoModConfig): GuildBotConfig {
  return {
    enabled: true,
    mod_log_channel_id: config.mod_log_channel_id || undefined,
    quarantine_channel_id: config.quarantine_channel_id || undefined,
    rules: (config.rules || []).map((rule) => ({
      id: rule.id,
      name: rule.name.trim() || 'Rule',
      enabled: rule.enabled,
      type: rule.type,
      value: rule.value,
    })),
    anti_raid: {
      enabled: config.anti_raid?.enabled === true,
      join_window_seconds: Math.max(5, Math.floor(config.anti_raid?.join_window_seconds || 30)),
      join_threshold: Math.max(2, Math.floor(config.anti_raid?.join_threshold || 10)),
      lockdown_minutes: Math.max(1, Math.floor(config.anti_raid?.lockdown_minutes || 10)),
      min_account_age_minutes: Math.max(
        0,
        Math.floor(config.anti_raid?.min_account_age_minutes || 0),
      ),
      auto_action:
        config.anti_raid?.auto_action === 'kick' || config.anti_raid?.auto_action === 'ban'
          ? config.anti_raid.auto_action
          : 'none',
    },
    verification_gate: {
      enabled: config.verification_gate?.enabled === true,
      require_ack: config.verification_gate?.require_ack !== false,
      waiting_period_minutes: Math.max(
        0,
        Math.floor(config.verification_gate?.waiting_period_minutes || 0),
      ),
      questions: (config.verification_gate?.questions || [])
        .map((q) => ({ question: q.question.trim(), answer: q.answer.trim() }))
        .filter((q) => q.question.length && q.answer.length),
    },
    trigger_logs: config.trigger_logs || [],
  };
}

function botStoreSectionError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

export function BotStoreSection({ guildId, canManage, onBotSettingsChanged }: BotStoreSectionProps) {
  const [activeTab, setActiveTab] = useState<'built-in' | 'public'>('built-in');
  const [searchQuery, setSearchQuery] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configState, setConfigState] = useState<GuildBotConfig>({});

  // Public bot store state
  const [publicBots, setPublicBots] = useState<StoreBot[]>([]);
  const [publicBotsLoading, setPublicBotsLoading] = useState(false);
  const [publicBotsError, setPublicBotsError] = useState('');
  const [addingPublicBotId, setAddingPublicBotId] = useState<string | null>(null);

  const guild = useGuildStore((state) => state.guilds.find((g) => g.id === guildId));
  const guildChannels = useChannelStore((state) => state.channelsByGuild[guildId] ?? EMPTY_GUILD_CHANNELS);
  const updateGuild = useGuildStore((state) => state.updateGuild);
  const botSettings = useMemo<Record<string, GuildBotConfig>>(() => guild?.bot_settings || {}, [guild?.bot_settings]);

  useEffect(() => {
    if (configuringId && botSettings[configuringId]) {
      setConfigState(configuringId === 'auto_mod' ? normalizeAutoMod(botSettings[configuringId]) : botSettings[configuringId]);
    } else {
      setConfigState({});
    }
  }, [configuringId, botSettings]);

  const filteredBots = useMemo(() => {
    const allBots = [...BUILT_IN_BOTS, ...UPCOMING_BOTS];
    if (!searchQuery.trim()) return allBots;
    const q = searchQuery.toLowerCase();
    return allBots.filter((b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q));
  }, [searchQuery]);

  const textLikeChannels = useMemo(() => guildChannels.filter((channel) => {
    const type = channel.channel_type ?? channel.type;
    return type === 0 || type === 5;
  }), [guildChannels]);

  const loadPublicBots = useCallback(() => {
    setPublicBotsLoading(true);
    setPublicBotsError('');
    botStoreApi.search({ q: searchQuery.trim() || undefined, limit: 24 })
      .then(({ data }) => {
        setPublicBots(data.bots);
      })
      .catch((err: unknown) => {
        setPublicBots([]);
        setPublicBotsError(botStoreSectionError('Failed to load public bots', err));
      })
      .finally(() => setPublicBotsLoading(false));
  }, [searchQuery]);

  useEffect(() => {
    if (activeTab !== 'public') return;
    loadPublicBots();
  }, [activeTab, loadPublicBots]);

  const handleAddPublicBot = async (bot: StoreBot) => {
    if (!canManage) return;
    setAddingPublicBotId(bot.id);
    try {
      await botApi.addBotToGuild(guildId, { application_id: bot.id });
      toast.success(`${bot.name} added to server!`);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError(`Failed to add ${bot.name}`, err));
    } finally {
      setAddingPublicBotId(null);
    }
  };

  const autoModConfig = configuringId === 'auto_mod' ? normalizeAutoMod(configState) : normalizeAutoMod({ enabled: false });

  const setAutoModConfig = (next: AutoModConfig) => setConfigState(next);

  const handleInstall = async (botId: string) => {
    if (!canManage) return;
    setInstallingId(botId);
    let initialConfig: GuildBotConfig = { enabled: true };
    if (botId === 'welcome_bot') {
      initialConfig = {
        ...initialConfig,
        channel_id: guild?.default_channel_id || '',
        message_template: 'Welcome to the server, {user}!',
      };
    } else if (botId === 'auto_mod') {
      initialConfig = serializeAutoMod(normalizeAutoMod({ enabled: true }));
    }
    const newSettings = { ...botSettings, [botId]: initialConfig };
    try {
      await updateGuild(guildId, { bot_settings: newSettings });
      setConfiguringId(botId);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to install bot', err));
    } finally {
      setInstallingId(null);
    }
  };

  const handleUninstall = async (botId: string) => {
    if (!canManage) return;
    const newSettings = { ...botSettings };
    if (newSettings[botId]) newSettings[botId].enabled = false;
    try {
      await updateGuild(guildId, { bot_settings: newSettings });
      setConfiguringId(null);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to remove bot', err));
    }
  };

  const saveConfig = async () => {
    if (!canManage || !configuringId) return;
    const normalized = configuringId === 'auto_mod' ? serializeAutoMod(normalizeAutoMod(configState)) : { ...configState };
    const newSettings = { ...botSettings, [configuringId]: { ...normalized, enabled: true } };
    try {
      await updateGuild(guildId, { bot_settings: newSettings });
      setConfiguringId(null);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to save bot settings', err));
    }
  };

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
      <div className="flex flex-col gap-2 mb-6">
        <h2 className="settings-section-title !mb-0 flex items-center gap-2">
          <Bot size={20} className="text-accent-primary" />
          Bot Store
        </h2>
        <p className="text-sm text-text-muted">
          Install official bots, configure moderation rules, or browse the public bot store.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 rounded-xl border border-border-subtle bg-bg-mod-subtle/40 p-1">
        <button
          onClick={() => setActiveTab('built-in')}
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
            activeTab === 'built-in'
              ? 'bg-accent-primary text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          )}
        >
          Built-in Bots
        </button>
        <button
          onClick={() => setActiveTab('public')}
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
            activeTab === 'public'
              ? 'bg-accent-primary text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          )}
        >
          Public Store
        </button>
      </div>

      <div className="relative mb-6">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-text-muted"><Search size={16} /></div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={activeTab === 'public' ? 'Search public bots...' : 'Search for bots...'}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-interactive-normal focus:bg-bg-mod-subtle"
        />
      </div>

      {activeTab === 'public' && (
        <div>
          {publicBotsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-48 animate-pulse rounded-2xl border border-border-subtle bg-bg-mod-subtle/40" />
              ))}
            </div>
          ) : publicBotsError ? (
            <div
              role="alert"
              className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{publicBotsError}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => loadPublicBots()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : publicBots.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bot size={32} className="mb-3 text-text-muted" />
              <p className="text-sm text-text-muted">No public bots found.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {publicBots.map((bot) => (
                <BotStoreCard
                  key={bot.id}
                  bot={bot}
                  onAdd={handleAddPublicBot}
                  adding={addingPublicBotId === bot.id}
                  canManage={canManage}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'built-in' && <>
      {configuringId && (
        <div className="mb-6 p-5 border border-border-subtle bg-bg-mod-subtle rounded-xl shadow-lg relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-accent-primary" />
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-text-primary text-base">Configure {filteredBots.find((b) => b.id === configuringId)?.name}</h3>
            <button onClick={() => setConfiguringId(null)} className="text-text-muted hover:text-text-primary transition-colors"><X size={20} /></button>
          </div>

          <div className="flex flex-col gap-4 mb-5">
            {configuringId === 'welcome_bot' && (
              <>
                <div>
                  <label className="settings-label">Welcome Channel</label>
                  <select
                    aria-label="Welcome Channel"
                    value={String(configState.channel_id || '')}
                    onChange={(e) => setConfigState({ ...configState, channel_id: e.target.value })}
                    className="select-field"
                  >
                    {textLikeChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="settings-label">Message Template</label>
                  <textarea
                    aria-label="Message Template"
                    value={String(configState.message_template || '')}
                    onChange={(e) => setConfigState({ ...configState, message_template: e.target.value })}
                    className="w-full h-24 p-3 rounded-lg border border-border-subtle bg-bg-secondary text-sm text-text-primary outline-none transition-colors focus:border-interactive-normal resize-none"
                    placeholder="Welcome to the server, {user}!"
                  />
                </div>
              </>
            )}

            {configuringId === 'auto_mod' && (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="settings-label">Mod Log Channel</label>
                    <select aria-label="Mod Log Channel" className="select-field" value={autoModConfig.mod_log_channel_id || ''} onChange={(e) => setAutoModConfig({ ...autoModConfig, mod_log_channel_id: e.target.value || undefined })}>
                      <option value="">Disabled</option>
                      {textLikeChannels.map((channel) => (<option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="settings-label">Quarantine Channel</label>
                    <select aria-label="Quarantine Channel" className="select-field" value={autoModConfig.quarantine_channel_id || ''} onChange={(e) => setAutoModConfig({ ...autoModConfig, quarantine_channel_id: e.target.value || undefined })}>
                      <option value="">Disabled</option>
                      {textLikeChannels.map((channel) => (<option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>))}
                    </select>
                  </div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-primary/35 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-text-primary">Rules</h4>
                    <Button size="sm" variant="secondary" onClick={() => setAutoModConfig({ ...autoModConfig, rules: [...(autoModConfig.rules || []), makeRule()] })}><Plus size={14} />Add Rule</Button>
                  </div>
                  <div className="space-y-2">
                    {(autoModConfig.rules || []).map((rule) => (
                      <div key={rule.id} className="rounded-lg border border-border-subtle bg-bg-secondary/35 p-3">
                        <div className="grid gap-2 md:grid-cols-4">
                          <input className="input-field" value={rule.name} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, name: e.target.value } : r) })} placeholder="Rule name" />
                          <select className="select-field" value={rule.type} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, type: e.target.value as RuleType } : r) })}>
                            <option value="keyword">Keyword</option>
                            <option value="regex">Regex</option>
                            <option value="link_allowlist">Link allowlist</option>
                            <option value="link_blocklist">Link blocklist</option>
                            <option value="spam_duplicate">Duplicate spam</option>
                            <option value="mention_spam">Mention spam</option>
                            <option value="account_age_gate">Account age gate</option>
                          </select>
                          <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-xs text-text-secondary"><input type="checkbox" checked={rule.enabled} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, enabled: e.target.checked } : r) })} />Enabled</label>
                          <Button size="sm" variant="destructive" onClick={() => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).filter((r) => r.id !== rule.id) })}><Trash2 size={14} />Remove</Button>
                        </div>
                        <input className="input-field mt-2" value={rule.value} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r) })} placeholder="Rule value (comma list, regex, domain list, or numeric params)" />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-primary/35 p-4">
                  <h4 className="text-sm font-semibold text-text-primary mb-2">Anti-Raid</h4>
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm text-text-secondary"><input type="checkbox" checked={autoModConfig.anti_raid?.enabled === true} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), enabled: e.target.checked } })} />Enabled</label>
                    <select className="select-field" value={autoModConfig.anti_raid?.auto_action || 'none'} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), auto_action: e.target.value as 'none' | 'kick' | 'ban' } })}>
                      <option value="none">No auto-action</option>
                      <option value="kick">Kick suspicious</option>
                      <option value="ban">Ban suspicious</option>
                    </select>
                    <input type="number" min={5} className="input-field" value={autoModConfig.anti_raid?.join_window_seconds || 30} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), join_window_seconds: Number(e.target.value || 30) } })} placeholder="Join window (seconds)" />
                    <input type="number" min={2} className="input-field" value={autoModConfig.anti_raid?.join_threshold || 10} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), join_threshold: Number(e.target.value || 10) } })} placeholder="Join threshold" />
                    <input type="number" min={1} className="input-field" value={autoModConfig.anti_raid?.lockdown_minutes || 10} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), lockdown_minutes: Number(e.target.value || 10) } })} placeholder="Lockdown minutes" />
                    <input type="number" min={0} className="input-field" value={autoModConfig.anti_raid?.min_account_age_minutes || 0} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || { enabled: false, join_window_seconds: 30, join_threshold: 10, lockdown_minutes: 10, min_account_age_minutes: 0, auto_action: 'none' }), min_account_age_minutes: Number(e.target.value || 0) } })} placeholder="Min account age minutes" />
                  </div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-primary/35 p-4">
                  <h4 className="text-sm font-semibold text-text-primary mb-2">Verification Gate</h4>
                  <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm text-text-secondary mb-2"><input type="checkbox" checked={autoModConfig.verification_gate?.enabled === true} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), enabled: e.target.checked } })} />Enabled</label>
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm text-text-secondary"><input type="checkbox" checked={autoModConfig.verification_gate?.require_ack !== false} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), require_ack: e.target.checked } })} />Require acknowledgement</label>
                    <input type="number" min={0} className="input-field" value={autoModConfig.verification_gate?.waiting_period_minutes || 0} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), waiting_period_minutes: Number(e.target.value || 0) } })} placeholder="Waiting period (minutes)" />
                  </div>
                  <div className="mt-2 space-y-2">
                    {(autoModConfig.verification_gate?.questions || []).map((q, idx) => (
                      <div key={`${idx}-${q.question}`} className="grid gap-2 md:grid-cols-2">
                        <input className="input-field" value={q.question} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), questions: (autoModConfig.verification_gate?.questions || []).map((item, i) => i === idx ? { ...item, question: e.target.value } : item) } })} placeholder="Question" />
                        <div className="flex gap-2"><input className="input-field flex-1" value={q.answer} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), questions: (autoModConfig.verification_gate?.questions || []).map((item, i) => i === idx ? { ...item, answer: e.target.value } : item) } })} placeholder="Expected answer" /><Button size="sm" variant="destructive" onClick={() => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), questions: (autoModConfig.verification_gate?.questions || []).filter((_, i) => i !== idx) } })}><Trash2 size={14} /></Button></div>
                      </div>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || { enabled: false, require_ack: true, waiting_period_minutes: 0, questions: [] }), questions: [...(autoModConfig.verification_gate?.questions || []), { question: '', answer: '' }] } })}><Plus size={14} />Add Question</Button>
                  </div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-primary/35 p-4">
                  <h4 className="text-sm font-semibold text-text-primary mb-1">Trigger Logs</h4>
                  <p className="text-xs text-text-muted mb-2">Recent server-side AutoMod triggers.</p>
                  <div className="max-h-52 overflow-y-auto space-y-2">
                    {(autoModConfig.trigger_logs || []).length === 0 && <div className="rounded-lg border border-border-subtle bg-bg-secondary/30 px-3 py-4 text-center text-xs text-text-muted">No trigger logs yet.</div>}
                    {(autoModConfig.trigger_logs || []).map((entry, idx) => (
                      <div key={String(entry.id || idx)} className="rounded-lg border border-border-subtle bg-bg-secondary/30 px-3 py-2">
                        <div className="text-xs font-semibold text-text-primary">{String(entry.rule || 'Rule')}</div>
                        <div className="text-[11px] text-text-muted">user {String(entry.user_id || 'unknown')} in channel {String(entry.channel_id || 'unknown')}</div>
                        {Boolean(entry.excerpt) && <div className="mt-1 text-xs text-text-secondary">{String(entry.excerpt)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-border-subtle/50">
            <Button variant="destructive" size="sm" onClick={() => configuringId && void handleUninstall(configuringId)} className="gap-1.5 flex items-center"><Trash2 size={14} /> Remove Bot</Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfiguringId(null)}>Cancel</Button>
              <Button variant="default" size="sm" onClick={() => void saveConfig()} className="gap-1.5 flex items-center shadow-lg shadow-accent-primary/20"><Save size={14} /> Save Changes</Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredBots.map((bot) => {
          const isUpcoming = UPCOMING_BOTS.some((b) => b.id === bot.id);
          const installed = botSettings[bot.id]?.enabled === true;
          return (
            <div key={bot.id} className={cn('card-surface flex flex-col rounded-2xl border border-border-subtle bg-bg-mod-subtle/40 p-5 transition-colors', installed ? 'border-accent-primary/50 shadow-sm shadow-accent-primary/5' : 'hover:border-border-strong hover:bg-bg-mod-subtle/60')}>
              <div className="flex items-start gap-4 mb-4">
                <div
                  className={cn(
                    'h-12 w-12 shrink-0 rounded-xl flex items-center justify-center',
                    BOT_ICON_BG_CLASS[bot.id] || 'bg-bg-mod-strong',
                  )}
                >
                  {bot.icon}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-text-primary">{bot.name}</h3>
                    {installed && <span className="text-[10px] font-bold uppercase tracking-wider text-accent-primary bg-accent-primary/10 px-2 py-0.5 rounded-full">Active</span>}
                    {isUpcoming && <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted bg-bg-secondary px-2 py-0.5 rounded-full">Coming Soon</span>}
                  </div>
                  <p className="text-[13px] text-text-muted mt-0.5 line-clamp-2 leading-relaxed">{bot.description}</p>
                </div>
              </div>
              <div className="flex flex-col gap-2 mb-6 flex-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Features</span>
                <ul className="flex flex-col gap-1.5">{bot.features.map((feature) => <li key={feature} className="flex items-center gap-2 text-[13px] text-text-secondary"><Check size={14} className="text-text-muted" />{feature}</li>)}</ul>
              </div>
              <div className="mt-auto pt-4 border-t border-border-subtle/50 flex items-center justify-between">
                <span className="text-xs font-semibold text-text-muted flex items-center gap-1"><Wrench size={12} />Native App</span>
                {isUpcoming ? (
                  <Button disabled size="sm" variant="outline" className="cursor-not-allowed">
                    In Development
                  </Button>
                ) : installed ? (
                  <Button
                    onClick={() => setConfiguringId(bot.id)}
                    disabled={!canManage}
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                  >
                    <Settings size={14} /> Configure
                  </Button>
                ) : (
                  <Button
                    onClick={() => void handleInstall(bot.id)}
                    disabled={!canManage || installingId === bot.id}
                    size="sm"
                    className="gap-1.5 shadow-sm shadow-accent-primary/20 hover:shadow-accent-primary/40"
                  >
                    {installingId === bot.id ? 'Installing...' : 'Add to Server'}
                    {installingId !== bot.id && <ArrowRight size={14} />}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </>}
    </div>
  );
}
