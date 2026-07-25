import { getApi } from './activeClient';

/** Trigger discriminants — mirrors `paracord_core::automod::TriggerKind`. */
export const TriggerType = {
  Keyword: 1,
  Regex: 2,
  MentionFlood: 3,
  MessageSpam: 4,
  Link: 5,
} as const;

export type TriggerTypeValue = (typeof TriggerType)[keyof typeof TriggerType];

export type TriggerMetadata =
  | { kind: 'keyword'; keywords: string[]; whole_word?: boolean }
  | { kind: 'regex'; patterns: string[] }
  | { kind: 'mention_flood'; max_mentions: number }
  | { kind: 'message_spam'; max_messages: number; window_seconds: number }
  | {
      kind: 'link';
      block_all?: boolean;
      block_invites?: boolean;
      allowed_domains?: string[];
    };

export type RuleAction =
  | { kind: 'block_message'; reason?: string | null }
  | { kind: 'alert_channel'; channel_id: string }
  | { kind: 'timeout_member'; duration_seconds: number };

export interface AutomodRule {
  id: string;
  guild_id: string;
  name: string;
  creator_id: string | null;
  event_type: number;
  trigger_type: number;
  trigger_metadata: TriggerMetadata;
  actions: RuleAction[];
  enabled: boolean;
  exempt_role_ids: string[];
  exempt_channel_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface AutomodHit {
  id: string;
  guild_id: string;
  rule_id: string;
  rule_name: string;
  user_id: string;
  channel_id: string;
  trigger_type: number;
  actions_taken: string[];
  matched_excerpt: string | null;
  content_excerpt: string | null;
  created_at: string;
}

export interface CreateAutomodRuleRequest {
  name: string;
  trigger_type: number;
  trigger_metadata: TriggerMetadata;
  actions: RuleAction[];
  enabled?: boolean;
  exempt_role_ids?: string[];
  exempt_channel_ids?: string[];
}

export type UpdateAutomodRuleRequest = Partial<
  Omit<CreateAutomodRuleRequest, 'trigger_type'>
>;

export const automodApi = {
  listRules: (guildId: string) =>
    getApi().get<{ rules: AutomodRule[] }>(`/guilds/${guildId}/automod/rules`),
  createRule: (guildId: string, data: CreateAutomodRuleRequest) =>
    getApi().post<AutomodRule>(`/guilds/${guildId}/automod/rules`, data),
  updateRule: (guildId: string, ruleId: string, data: UpdateAutomodRuleRequest) =>
    getApi().patch<AutomodRule>(`/guilds/${guildId}/automod/rules/${ruleId}`, data),
  deleteRule: (guildId: string, ruleId: string) =>
    getApi().delete(`/guilds/${guildId}/automod/rules/${ruleId}`),
  listHits: (guildId: string, limit = 50) =>
    getApi().get<{ hits: AutomodHit[] }>(`/guilds/${guildId}/automod/hits`, {
      params: { limit },
    }),
  /** Dry-run a trigger against sample text. Nothing is persisted. */
  testRule: (
    guildId: string,
    data: {
      trigger_type: number;
      trigger_metadata: TriggerMetadata;
      content: string;
      recent_message_count?: number;
    },
  ) =>
    getApi().post<{ matched: boolean; matched_excerpt: string | null }>(
      `/guilds/${guildId}/automod/test`,
      data,
    ),
};

export const TRIGGER_LABELS: Record<number, string> = {
  [TriggerType.Keyword]: 'Keywords',
  [TriggerType.Regex]: 'Pattern',
  [TriggerType.MentionFlood]: 'Mention flood',
  [TriggerType.MessageSpam]: 'Message spam',
  [TriggerType.Link]: 'Links & invites',
};

export const TRIGGER_DESCRIPTIONS: Record<number, string> = {
  [TriggerType.Keyword]: 'Match a list of words or phrases.',
  [TriggerType.Regex]: 'Match a regular expression.',
  [TriggerType.MentionFlood]: 'Catch messages that mention too many people at once.',
  [TriggerType.MessageSpam]: 'Catch a burst of messages from one member.',
  [TriggerType.Link]: 'Block links, invites, or both — with an allowlist.',
};

export const ACTION_LABELS: Record<string, string> = {
  block_message: 'Block the message',
  alert_channel: 'Alert a channel',
  timeout_member: 'Time the member out',
};

/** Sensible starting config when the operator picks a trigger type. */
export function defaultTriggerMetadata(triggerType: number): TriggerMetadata {
  switch (triggerType) {
    case TriggerType.Regex:
      return { kind: 'regex', patterns: [] };
    case TriggerType.MentionFlood:
      return { kind: 'mention_flood', max_mentions: 5 };
    case TriggerType.MessageSpam:
      return { kind: 'message_spam', max_messages: 5, window_seconds: 10 };
    case TriggerType.Link:
      return { kind: 'link', block_all: false, block_invites: true, allowed_domains: [] };
    case TriggerType.Keyword:
    default:
      return { kind: 'keyword', keywords: [], whole_word: true };
  }
}

/** One-line human summary of a rule's trigger, for the rule list. */
export function describeTrigger(rule: AutomodRule): string {
  const meta = rule.trigger_metadata;
  if (!meta) return TRIGGER_LABELS[rule.trigger_type] ?? 'Unknown';
  switch (meta.kind) {
    case 'keyword': {
      const n = meta.keywords?.length ?? 0;
      return `${n} keyword${n === 1 ? '' : 's'}${meta.whole_word ? ' · whole word' : ''}`;
    }
    case 'regex': {
      const n = meta.patterns?.length ?? 0;
      return `${n} pattern${n === 1 ? '' : 's'}`;
    }
    case 'mention_flood':
      return `More than ${meta.max_mentions} mentions`;
    case 'message_spam':
      return `${meta.max_messages}+ messages in ${meta.window_seconds}s`;
    case 'link': {
      const parts: string[] = [];
      if (meta.block_all) parts.push('all links');
      if (meta.block_invites) parts.push('invites');
      const allowed = meta.allowed_domains?.length ?? 0;
      const base = parts.length ? `Blocks ${parts.join(' + ')}` : 'Links';
      return allowed ? `${base} · ${allowed} allowed` : base;
    }
    default:
      return TRIGGER_LABELS[rule.trigger_type] ?? 'Unknown';
  }
}

export function describeActions(actions: RuleAction[]): string {
  if (!actions?.length) return 'No actions';
  return actions
    .map((a) => {
      if (a.kind === 'timeout_member') {
        const mins = Math.round(a.duration_seconds / 60);
        return mins >= 60
          ? `Timeout ${Math.round(mins / 60)}h`
          : `Timeout ${mins}m`;
      }
      return ACTION_LABELS[a.kind] ?? a.kind;
    })
    .join(' · ');
}
