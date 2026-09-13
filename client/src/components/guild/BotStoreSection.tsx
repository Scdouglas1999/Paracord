import { useCurrentChannelStore } from '../../hooks/useChannels';
import { useGuild } from '../../hooks/useGuilds';
import { useId, useCallback, useState, useMemo, useEffect, type ReactNode } from 'react';
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
import { useGuildStore } from '../../stores/guildStore';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorBanner,
  IconButton,
  Input,
  Raised,
  SearchWell,
  Select,
  Tabs,
  Textarea,
  Well,
  type TabItem,
} from '../ui';
import { Skeleton } from '../ui/Skeleton';
import { GroupLabel, SectionHeader, Switch, ToggleRow } from './SettingsPrimitives';
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
  onOpenSettings?: (section: 'onboarding' | 'economy') => void;
  onOpenChannel?: (channelId: string) => void;
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
    name: 'Welcome bot',
    description: 'Automatically greet new members when they join the server.',
    icon: <Smile size={22} aria-hidden />,
    features: ['Customizable welcome message', 'Channel selection'],
  },
  {
    id: 'auto_mod',
    name: 'Auto-moderator',
    description: 'Rule-based moderation, raid protection, and verification gates.',
    icon: <Shield size={22} aria-hidden />,
    features: ['Rule engine', 'Quarantine + mod log', 'Anti-raid + verification gate'],
  },
];

const INCLUDED_TOOLS: BuiltInBot[] = [
  {
    id: 'system-roles',
    name: 'Member onboarding',
    description: 'Let new members choose optional roles and acknowledge community rules.',
    icon: <Zap size={22} aria-hidden />,
    features: ['Self-selected roles', 'Rules acknowledgement', 'Welcome prompts'],
  },
  {
    id: 'system-economy',
    name: 'Economy & levels',
    description: 'Gamify your server with XP, levels, and leaderboards for active members.',
    icon: <Gamepad2 size={22} aria-hidden />,
    features: ['Activity tracking', 'Level up alerts', 'Server leaderboard'],
  },
  {
    id: 'system-polls',
    name: 'Polls',
    description: 'Quickly spin up robust, multi-option polls with real-time tracking.',
    icon: <Volume2 size={22} aria-hidden />,
    features: ['Multiple choices', 'Anonymous voting', 'Timed polls'],
  },
];

/** The two views of the store (spec §6.8: one Tabs recipe, sentence case). */
const STORE_TABS: readonly TabItem<'built-in' | 'public'>[] = [
  { value: 'built-in', label: 'Built-in bots' },
  { value: 'public', label: 'Public store' },
];

/** The label above a control inside the configure panel (§2 Section step). */
const fieldLabelClass = 'mb-2 block text-section text-text-faint';

const DEFAULT_ANTI_RAID = {
  enabled: false,
  join_window_seconds: 30,
  join_threshold: 10,
  lockdown_minutes: 10,
  min_account_age_minutes: 0,
  auto_action: 'none',
} as const;

const DEFAULT_VERIFICATION_GATE: {
  enabled: boolean;
  require_ack: boolean;
  waiting_period_minutes: number;
  questions: { question: string; answer: string }[];
} = {
  enabled: false,
  require_ack: true,
  waiting_period_minutes: 0,
  questions: [],
};

const EMPTY_GUILD_CHANNELS: Channel[] = [];

function makeRule(): AutoModRule {
  return {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'New rule',
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
            name: 'Restricted words',
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

export function BotStoreSection({
  guildId,
  canManage,
  onBotSettingsChanged,
  onOpenSettings,
  onOpenChannel,
}: BotStoreSectionProps) {
  const formId = useId();
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

  const guild = useGuild(guildId);
  const guildChannels = useCurrentChannelStore((state) => state.channelsByGuild[guildId] ?? EMPTY_GUILD_CHANNELS);
  const updateGuild = useGuildStore((state) => state.updateGuild);
  const botSettings = useMemo<Record<string, GuildBotConfig | undefined>>(() => guild?.bot_settings || {}, [guild?.bot_settings]);

  useEffect(() => {
    if (configuringId && botSettings[configuringId]) {
      setConfigState(configuringId === 'auto_mod' ? normalizeAutoMod(botSettings[configuringId]) : botSettings[configuringId]);
    } else {
      setConfigState({});
    }
  }, [configuringId, botSettings]);

  const filteredBots = useMemo(() => {
    if (!searchQuery.trim()) return BUILT_IN_BOTS;
    const q = searchQuery.toLowerCase();
    return BUILT_IN_BOTS.filter((b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q));
  }, [searchQuery]);

  const textLikeChannels = useMemo(() => guildChannels.filter((channel) => {
    const type = channel.channel_type ?? channel.type;
    return type === 0 || type === 5;
  }), [guildChannels]);
  const firstTextChannel = textLikeChannels[0];

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
    if (!canManage || !guild) return;
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
    if (!canManage || !guild) return;
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
      await updateGuild(guildId, { bot_settings: newSettings }, guild.scope);
      setConfiguringId(botId);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to install bot', err));
    } finally {
      setInstallingId(null);
    }
  };

  const handleUninstall = async (botId: string) => {
    if (!canManage || !guild) return;
    const newSettings = { ...botSettings };
    if (newSettings[botId]) newSettings[botId].enabled = false;
    try {
      await updateGuild(guildId, { bot_settings: newSettings }, guild.scope);
      setConfiguringId(null);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to remove bot', err));
    }
  };

  const saveConfig = async () => {
    if (!canManage || !guild || !configuringId) return;
    const normalized = configuringId === 'auto_mod' ? serializeAutoMod(normalizeAutoMod(configState)) : { ...configState };
    const newSettings = { ...botSettings, [configuringId]: { ...normalized, enabled: true } };
    try {
      await updateGuild(guildId, { bot_settings: newSettings }, guild.scope);
      setConfiguringId(null);
      await Promise.resolve(onBotSettingsChanged?.());
    } catch (err: unknown) {
      toast.error(botStoreSectionError('Failed to save bot settings', err));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Bot store"
        description="Install the bots that ship with Paracord, tune their moderation rules, or browse what other developers have published."
      />

      <Tabs
        label="Bot store view"
        items={STORE_TABS}
        value={activeTab}
        onChange={(next) => setActiveTab(next)}
        fill
      />

      <SearchWell
        label={activeTab === 'public' ? 'Search public bots' : 'Search built-in bots'}
        icon={<Search size={16} />}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      {activeTab === 'public' && (
        <div>
          {publicBotsLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} height={132} borderRadius="var(--radius-well)" />
              ))}
            </div>
          ) : publicBotsError ? (
            <ErrorBanner
              message={publicBotsError}
              multiline
              onRetry={() => loadPublicBots()}
            />
          ) : publicBots.length === 0 ? (
            <EmptyState
              icon={<Bot size={20} />}
              title="Nothing published matches"
              description={
                searchQuery.trim()
                  ? `No public bot is listed under “${searchQuery.trim()}”. Try a shorter word, or use the bots that already ship with this space.`
                  : 'No developer has published a bot to this server yet. The built-in bots cover welcomes and moderation without an install.'
              }
              action={
                <Button variant="ghost" onClick={() => setActiveTab('built-in')}>
                  Show built-in bots
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
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
        <Raised bare lifted className="flex flex-col gap-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="pc-display min-w-0 text-heading text-text-primary">
              Configure {filteredBots.find((b) => b.id === configuringId)?.name}
            </h3>
            <IconButton label="Close bot settings" onClick={() => setConfiguringId(null)}>
              <X size={18} />
            </IconButton>
          </div>

          <div className="flex flex-col gap-5">
            {configuringId === 'welcome_bot' && (
              <>
                <div>
                  <label htmlFor={`${formId}-welcome-channel`} className={fieldLabelClass}>Welcome channel</label>
                  <Select
                    id={`${formId}-welcome-channel`} aria-label="Welcome channel"
                    value={String(configState.channel_id || '')}
                    onChange={(e) => setConfigState({ ...configState, channel_id: e.target.value })}
                  >
                    {textLikeChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor={`${formId}-message-template`} className={fieldLabelClass}>Message template</label>
                  <Textarea
                    id={`${formId}-message-template`} aria-label="Message template"
                    value={String(configState.message_template || '')}
                    onChange={(e) => setConfigState({ ...configState, message_template: e.target.value })}
                    className="h-24 resize-none"
                    placeholder="Welcome to the server, {user}!"
                  />
                </div>
              </>
            )}

            {configuringId === 'auto_mod' && (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label htmlFor={`${formId}-mod-log-channel`} className={fieldLabelClass}>Mod log channel</label>
                    <Select id={`${formId}-mod-log-channel`} aria-label="Mod log channel" value={autoModConfig.mod_log_channel_id || ''} onChange={(e) => setAutoModConfig({ ...autoModConfig, mod_log_channel_id: e.target.value || undefined })}>
                      <option value="">Disabled</option>
                      {textLikeChannels.map((channel) => (<option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>))}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor={`${formId}-quarantine-channel`} className={fieldLabelClass}>Quarantine channel</label>
                    <Select id={`${formId}-quarantine-channel`} aria-label="Quarantine channel" value={autoModConfig.quarantine_channel_id || ''} onChange={(e) => setAutoModConfig({ ...autoModConfig, quarantine_channel_id: e.target.value || undefined })}>
                      <option value="">Disabled</option>
                      {textLikeChannels.map((channel) => (<option key={channel.id} value={channel.id}>#{channel.name || channel.id}</option>))}
                    </Select>
                  </div>
                </div>

                <Divider />

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <GroupLabel>Rules</GroupLabel>
                    <Button size="sm" variant="ghost" onClick={() => setAutoModConfig({ ...autoModConfig, rules: [...(autoModConfig.rules || []), makeRule()] })}><Plus size={14} />Add rule</Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {(autoModConfig.rules || []).map((rule) => (
                      <Well key={rule.id} bare className="flex flex-col gap-2 p-3">
                        <div className="grid gap-2 md:grid-cols-4">
                          <Input aria-label="Rule name" value={rule.name} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, name: e.target.value } : r) })} placeholder="Rule name" />
                          <Select aria-label={`Trigger for ${rule.name}`} value={rule.type} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, type: e.target.value as RuleType } : r) })}>
                            <option value="keyword">Keyword</option>
                            <option value="regex">Regex</option>
                            <option value="link_allowlist">Link allowlist</option>
                            <option value="link_blocklist">Link blocklist</option>
                            <option value="spam_duplicate">Duplicate spam</option>
                            <option value="mention_spam">Mention spam</option>
                            <option value="account_age_gate">Account age gate</option>
                          </Select>
                          <div className="flex h-[var(--h-control-phone)] items-center gap-2.5">
                            <Switch checked={rule.enabled} onChange={(next) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, enabled: next } : r) })} label={`Enable ${rule.name}`} size="sm" />
                            <span className="text-label text-text-secondary">Enabled</span>
                          </div>
                          <Button size="sm" variant="danger" onClick={() => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).filter((r) => r.id !== rule.id) })}><Trash2 size={14} />Remove</Button>
                        </div>
                        <Input aria-label={`Value for ${rule.name}`} value={rule.value} onChange={(e) => setAutoModConfig({ ...autoModConfig, rules: (autoModConfig.rules || []).map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r) })} placeholder="Rule value (comma list, regex, domain list, or numeric params)" />
                      </Well>
                    ))}
                  </div>
                </section>

                <Divider />

                <section className="flex flex-col gap-3">
                  <GroupLabel>Anti-raid</GroupLabel>
                  <Well bare className="px-4">
                    <ToggleRow
                      label="Watch for raids"
                      description="Locks the space down when a burst of accounts joins at once."
                      checked={autoModConfig.anti_raid?.enabled === true}
                      onChange={(next) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), enabled: next } })}
                    />
                  </Well>
                  <div className="grid gap-2 md:grid-cols-2">
                    <Select aria-label="Automatic action on a suspected raid" value={autoModConfig.anti_raid?.auto_action || 'none'} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), auto_action: e.target.value as 'none' | 'kick' | 'ban' } })}>
                      <option value="none">No auto-action</option>
                      <option value="kick">Kick suspicious</option>
                      <option value="ban">Ban suspicious</option>
                    </Select>
                    <Input type="number" min={5} aria-label="Join window in seconds" value={autoModConfig.anti_raid?.join_window_seconds || 30} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), join_window_seconds: Number(e.target.value || 30) } })} placeholder="Join window (seconds)" />
                    <Input type="number" min={2} aria-label="Join threshold" value={autoModConfig.anti_raid?.join_threshold || 10} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), join_threshold: Number(e.target.value || 10) } })} placeholder="Join threshold" />
                    <Input type="number" min={1} aria-label="Lockdown minutes" value={autoModConfig.anti_raid?.lockdown_minutes || 10} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), lockdown_minutes: Number(e.target.value || 10) } })} placeholder="Lockdown minutes" />
                    <Input type="number" min={0} aria-label="Minimum account age in minutes" value={autoModConfig.anti_raid?.min_account_age_minutes || 0} onChange={(e) => setAutoModConfig({ ...autoModConfig, anti_raid: { ...(autoModConfig.anti_raid || DEFAULT_ANTI_RAID), min_account_age_minutes: Number(e.target.value || 0) } })} placeholder="Min account age minutes" />
                  </div>
                </section>

                <Divider />

                <section className="flex flex-col gap-3">
                  <GroupLabel>Verification gate</GroupLabel>
                  <Well bare className="divide-y divide-border-subtle px-4">
                    <ToggleRow
                      label="Ask new members to verify"
                      description="Members stay in the gate until they answer and acknowledge."
                      checked={autoModConfig.verification_gate?.enabled === true}
                      onChange={(next) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), enabled: next } })}
                    />
                    <ToggleRow
                      label="Require acknowledgement"
                      description="They have to tick the rules before they can post."
                      checked={autoModConfig.verification_gate?.require_ack !== false}
                      onChange={(next) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), require_ack: next } })}
                    />
                  </Well>
                  <Input type="number" min={0} className="md:max-w-xs" aria-label="Waiting period in minutes" value={autoModConfig.verification_gate?.waiting_period_minutes || 0} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), waiting_period_minutes: Number(e.target.value || 0) } })} placeholder="Waiting period (minutes)" />
                  <div className="flex flex-col gap-2">
                    {(autoModConfig.verification_gate?.questions || []).map((q, idx) => (
                      <div key={`${idx}-${q.question}`} className="grid gap-2 md:grid-cols-2">
                        <Input aria-label={`Question ${idx + 1}`} value={q.question} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), questions: (autoModConfig.verification_gate?.questions || []).map((item, i) => i === idx ? { ...item, question: e.target.value } : item) } })} placeholder="Question" />
                        <div className="flex gap-2"><Input aria-label={`Expected answer ${idx + 1}`} className="flex-1" value={q.answer} onChange={(e) => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), questions: (autoModConfig.verification_gate?.questions || []).map((item, i) => i === idx ? { ...item, answer: e.target.value } : item) } })} placeholder="Expected answer" /><IconButton label={`Remove question ${idx + 1}`} tone="danger" size="lg" onClick={() => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), questions: (autoModConfig.verification_gate?.questions || []).filter((_, i) => i !== idx) } })}><Trash2 size={14} /></IconButton></div>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" className="self-start" onClick={() => setAutoModConfig({ ...autoModConfig, verification_gate: { ...(autoModConfig.verification_gate || DEFAULT_VERIFICATION_GATE), questions: [...(autoModConfig.verification_gate?.questions || []), { question: '', answer: '' }] } })}><Plus size={14} />Add question</Button>
                  </div>
                </section>

                <Divider />

                <section className="flex flex-col gap-3">
                  <GroupLabel>Trigger log</GroupLabel>
                  {(autoModConfig.trigger_logs || []).length === 0 ? (
                    <EmptyState
                      icon={<Shield size={20} />}
                      title="Auto-moderator has not acted yet"
                      description="Each time a rule catches a message, the rule, the member and the channel are recorded here."
                    />
                  ) : (
                    <Well bare className="max-h-52 divide-y divide-border-subtle overflow-y-auto px-4">
                      {(autoModConfig.trigger_logs || []).map((entry, idx) => (
                        <div key={String(entry.id || idx)} className="py-2.5">
                          <div className="pc-display text-name text-text-primary">{String(entry.rule || 'Rule')}</div>
                          <div className="text-meta text-text-faint">user <span className="pc-mono">{String(entry.user_id || 'unknown')}</span> in channel <span className="pc-mono">{String(entry.channel_id || 'unknown')}</span></div>
                          {Boolean(entry.excerpt) && <div className="mt-1 text-meta leading-relaxed text-text-secondary">{String(entry.excerpt)}</div>}
                        </div>
                      ))}
                    </Well>
                  )}
                </section>
              </>
            )}
          </div>

          <Divider />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="danger" size="sm" onClick={() => configuringId && void handleUninstall(configuringId)}><Trash2 size={14} /> Remove Bot</Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfiguringId(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void saveConfig()}><Save size={14} /> Save changes</Button>
            </div>
          </div>
        </Raised>
      )}

      <section className="flex flex-col gap-3">
        <GroupLabel>Bots that ship with Paracord</GroupLabel>
        <Well bare className="divide-y divide-border-subtle px-4">
          {filteredBots.map((bot) => {
            const installed = botSettings[bot.id]?.enabled === true;
            return (
              <div key={bot.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-bg-raised text-text-secondary shadow-[var(--shadow-raised)]">
                    {bot.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="pc-display text-name text-text-primary">{bot.name}</h3>
                      {installed && <Chip size="sm" tone="accent">Installed</Chip>}
                    </div>
                    <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{bot.description}</p>
                    <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                      {bot.features.map((feature) => (
                        <li key={feature} className="flex items-center gap-1.5 text-meta text-text-faint">
                          <Check size={13} aria-hidden />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 sm:pl-3">
                  <span className="inline-flex items-center gap-1.5 text-meta text-text-faint">
                    <Wrench size={12} aria-hidden />
                    Runs in the app
                  </span>
                  {installed ? (
                    <Button
                      onClick={() => setConfiguringId(bot.id)}
                      disabled={!canManage}
                      size="sm"
                      variant="ghost"
                    >
                      <Settings size={14} /> Configure
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void handleInstall(bot.id)}
                      disabled={!canManage || installingId === bot.id}
                      size="sm"
                      variant="ghost"
                    >
                      {installingId === bot.id ? 'Installing...' : 'Add to server'}
                      {installingId !== bot.id && <ArrowRight size={14} />}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </Well>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="included-tools-heading">
        <div>
          <h3 id="included-tools-heading" className="pc-display text-heading text-text-primary">Already included with every space</h3>
          <p className="mt-1 text-body leading-relaxed text-text-secondary">These are native Paracord tools, so there is no bot to install.</p>
        </div>
        <Well bare className="divide-y divide-border-subtle px-4">
          {INCLUDED_TOOLS.map((tool) => {
            const action = tool.id === 'system-roles'
              ? { label: 'Open onboarding', disabled: !onOpenSettings, run: () => onOpenSettings?.('onboarding') }
              : tool.id === 'system-economy'
                ? { label: 'Open economy', disabled: !onOpenSettings, run: () => onOpenSettings?.('economy') }
                : { label: 'Open a channel', disabled: !firstTextChannel || !onOpenChannel, run: () => firstTextChannel && onOpenChannel?.(firstTextChannel.id) };
            return (
              <div key={tool.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-bg-raised text-text-secondary shadow-[var(--shadow-raised)]">
                    {tool.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="pc-display text-name text-text-primary">{tool.name}</h4>
                      <Chip size="sm" tone="accent">Available now</Chip>
                    </div>
                    <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{tool.description}</p>
                  </div>
                </div>
                <Button type="button" size="sm" variant="ghost" className="shrink-0 self-start sm:self-center" disabled={action.disabled} onClick={action.run}>
                  {action.label}
                </Button>
              </div>
            );
          })}
        </Well>
      </section>
      </>}
    </div>
  );
}
