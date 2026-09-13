import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Plus, ShieldAlert, Trash2, FlaskConical, Loader2 } from 'lucide-react';

import {
  ACTION_LABELS,
  TRIGGER_DESCRIPTIONS,
  TRIGGER_LABELS,
  TriggerType,
  automodApi,
  defaultTriggerMetadata,
  describeActions,
  describeTrigger,
  type AutomodHit,
  type AutomodRule,
  type RuleAction,
  type TriggerMetadata,
} from '../../api/automod';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  IconButton,
  Input,
  Raised,
  Select,
  Tabs,
  Textarea,
  Well,
  type TabItem,
} from '../ui';
import { Skeleton } from '../ui/Skeleton';
import { FieldLabel, GroupLabel, SectionHeader, Switch, ToggleRow } from './SettingsPrimitives';

interface AutomodSectionProps {
  guildId: string;
  // Channels/roles come straight from the settings page's loaded lists, where
  // `name` is nullable on the shared Channel type.
  channels: Array<{ id: string; name?: string | null; type?: number; channel_type?: number }>;
  roles: Array<{ id: string; name?: string | null }>;
}

const TRIGGER_ORDER = [
  TriggerType.Keyword,
  TriggerType.Link,
  TriggerType.MentionFlood,
  TriggerType.MessageSpam,
  TriggerType.Regex,
];

/** Ready-made rules so a new space gets protection without authoring anything. */
const PRESETS: Array<{
  key: string;
  name: string;
  blurb: string;
  trigger_type: number;
  trigger_metadata: TriggerMetadata;
  actions: RuleAction[];
}> = [
  {
    key: 'invites',
    name: 'Block space invites',
    blurb: 'Stops drive-by advertising of other spaces.',
    trigger_type: TriggerType.Link,
    trigger_metadata: { kind: 'link', block_all: false, block_invites: true, allowed_domains: [] },
    actions: [{ kind: 'block_message', reason: 'Space invites are not allowed here.' }],
  },
  {
    key: 'mentions',
    name: 'Stop mention spam',
    blurb: 'Blocks messages that ping more than five people at once.',
    trigger_type: TriggerType.MentionFlood,
    trigger_metadata: { kind: 'mention_flood', max_mentions: 5 },
    actions: [{ kind: 'block_message', reason: 'That message mentions too many people.' }],
  },
  {
    key: 'flood',
    name: 'Slow down flooding',
    blurb: 'Times a member out for 5 minutes after 8 messages in 10 seconds.',
    trigger_type: TriggerType.MessageSpam,
    trigger_metadata: { kind: 'message_spam', max_messages: 8, window_seconds: 10 },
    actions: [
      { kind: 'block_message', reason: 'You are sending messages too quickly.' },
      { kind: 'timeout_member', duration_seconds: 300 },
    ],
  },
];

function textAreaList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function AutomodSection({ guildId, channels, roles }: AutomodSectionProps) {
  const [rules, setRules] = useState<AutomodRule[] | null>(null);
  const [hits, setHits] = useState<AutomodHit[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const textChannels = useMemo(
    () => channels.filter((c) => (c.type ?? c.channel_type) === 0),
    [channels],
  );

  const load = useCallback(async () => {
    try {
      const [rulesRes, hitsRes] = await Promise.all([
        automodApi.listRules(guildId),
        automodApi.listHits(guildId, 25),
      ]);
      setRules(rulesRes.data.rules ?? []);
      setHits(hitsRes.data.hits ?? []);
    } catch (err) {
      setRules([]);
      toast.error(`Failed to load AutoMod: ${extractApiError(err)}`);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleRule = async (rule: AutomodRule) => {
    setBusyId(rule.id);
    try {
      const { data } = await automodApi.updateRule(guildId, rule.id, {
        enabled: !rule.enabled,
      });
      setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? data : r)));
    } catch (err) {
      toast.error(`Failed to update rule: ${extractApiError(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const removeRule = async (rule: AutomodRule) => {
    setBusyId(rule.id);
    try {
      await automodApi.deleteRule(guildId, rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
      toast.success(`Removed “${rule.name}”`);
    } catch (err) {
      toast.error(`Failed to delete rule: ${extractApiError(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const addPreset = async (preset: (typeof PRESETS)[number]) => {
    setBusyId(preset.key);
    try {
      const { data } = await automodApi.createRule(guildId, {
        name: preset.name,
        trigger_type: preset.trigger_type,
        trigger_metadata: preset.trigger_metadata,
        actions: preset.actions,
      });
      setRules((prev) => [...(prev ?? []), data]);
      toast.success(`Added “${preset.name}”`);
    } catch (err) {
      toast.error(`Failed to add rule: ${extractApiError(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const existingNames = new Set((rules ?? []).map((r) => r.name));
  const availablePresets = PRESETS.filter((p) => !existingNames.has(p.name));

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="AutoMod"
        description="Rules that check every message before it posts. Members who can manage this space are never filtered."
        action={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            <Plus size={15} /> New rule
          </Button>
        }
      />

      {creating && (
        <RuleEditor
          guildId={guildId}
          channels={textChannels}
          roles={roles}
          onCancel={() => setCreating(false)}
          onCreated={(rule) => {
            setRules((prev) => [...(prev ?? []), rule]);
            setCreating(false);
          }}
        />
      )}

      {/* Rules */}
      <section className="flex flex-col gap-3">
        <GroupLabel>Active rules</GroupLabel>
        {rules === null ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} height={56} borderRadius="var(--radius-well)" />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="Nothing is filtered yet"
            description="AutoMod checks every message against the rules listed here. Add one of the ready-made rules below, or write your own."
            action={
              <Button variant="ghost" onClick={() => setCreating(true)} disabled={creating}>
                <Plus size={15} /> Write a rule
              </Button>
            }
          />
        ) : (
          <Well bare className="divide-y divide-border-subtle px-4">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="pc-display truncate text-name text-text-primary">
                      {rule.name}
                    </span>
                    <Chip size="sm">{TRIGGER_LABELS[rule.trigger_type] ?? 'Rule'}</Chip>
                  </div>
                  <div className="mt-0.5 truncate text-meta text-text-secondary">
                    {describeTrigger(rule)} → {describeActions(rule.actions)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    checked={rule.enabled}
                    onChange={() => void toggleRule(rule)}
                    disabled={busyId === rule.id}
                    label={`Enable ${rule.name}`}
                  />
                  <IconButton
                    label={`Delete ${rule.name}`}
                    onClick={() => void removeRule(rule)}
                    disabled={busyId === rule.id}
                    className="hover:text-accent-danger"
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </div>
            ))}
          </Well>
        )}
      </section>

      {/* Presets */}
      {availablePresets.length > 0 && (
        <section className="flex flex-col gap-3">
          <GroupLabel>Add a common rule</GroupLabel>
          <Well bare className="divide-y divide-border-subtle px-4">
            {availablePresets.map((preset) => (
              <div key={preset.key} className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <div className="pc-display text-name text-text-primary">{preset.name}</div>
                  <div className="mt-0.5 text-meta leading-relaxed text-text-secondary">
                    {preset.blurb}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => void addPreset(preset)}
                  disabled={busyId === preset.key}
                >
                  {busyId === preset.key ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Add
                </Button>
              </div>
            ))}
          </Well>
        </section>
      )}

      {/* Recent activity */}
      <section className="flex flex-col gap-3">
        <GroupLabel>Recent activity</GroupLabel>
        {hits.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="AutoMod has not acted yet"
            description="Every message AutoMod blocks, and every member it times out, is logged here with the rule that caught it."
          />
        ) : (
          <Well bare className="divide-y divide-border-subtle px-4">
            {hits.map((hit) => (
              <div key={hit.id} className="flex items-start gap-3 py-3">
                <ShieldAlert size={15} className="mt-0.5 shrink-0 text-accent-warning" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="pc-display text-name text-text-primary">{hit.rule_name}</span>
                    <span className="pc-mono text-meta text-text-faint">
                      {new Date(hit.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 text-meta leading-relaxed text-text-secondary">
                    {hit.matched_excerpt}
                    {hit.actions_taken.length > 0 && (
                      <>
                        {' · '}
                        {hit.actions_taken.map((a) => ACTION_LABELS[a] ?? a).join(', ')}
                      </>
                    )}
                  </div>
                  {hit.content_excerpt && (
                    <div className="mt-1.5 rounded-[var(--radius-chip)] bg-bg-mod-subtle px-2 py-1 text-meta leading-relaxed text-text-muted">
                      {hit.content_excerpt}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </Well>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule editor
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  guildId: string;
  channels: Array<{ id: string; name?: string | null }>;
  roles: Array<{ id: string; name?: string | null }>;
  onCancel: () => void;
  onCreated: (rule: AutomodRule) => void;
}

function RuleEditor({ guildId, channels, roles, onCancel, onCreated }: RuleEditorProps) {
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<number>(TriggerType.Keyword);
  const [meta, setMeta] = useState<TriggerMetadata>(defaultTriggerMetadata(TriggerType.Keyword));
  const [block, setBlock] = useState(true);
  const [blockReason, setBlockReason] = useState('');
  const [timeoutEnabled, setTimeoutEnabled] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState(10);
  const [alertChannelId, setAlertChannelId] = useState('');
  const [exemptRoleIds, setExemptRoleIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Dry-run tester
  const [sample, setSample] = useState('');
  const [testResult, setTestResult] = useState<{ matched: boolean; excerpt: string | null } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  const changeTrigger = (next: number) => {
    setTriggerType(next);
    setMeta(defaultTriggerMetadata(next));
    setTestResult(null);
  };

  const triggerTabs = useMemo<TabItem[]>(
    () => TRIGGER_ORDER.map((t) => ({ value: String(t), label: TRIGGER_LABELS[t] })),
    [],
  );

  const buildActions = (): RuleAction[] => {
    const actions: RuleAction[] = [];
    if (block) {
      actions.push({
        kind: 'block_message',
        reason: blockReason.trim() || undefined,
      });
    }
    if (alertChannelId) actions.push({ kind: 'alert_channel', channel_id: alertChannelId });
    if (timeoutEnabled) {
      actions.push({ kind: 'timeout_member', duration_seconds: Math.max(1, timeoutMinutes) * 60 });
    }
    return actions;
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const { data } = await automodApi.testRule(guildId, {
        trigger_type: triggerType,
        trigger_metadata: meta,
        content: sample,
        // Make the spam trigger testable without sending real messages.
        recent_message_count:
          meta.kind === 'message_spam' ? meta.max_messages : undefined,
      });
      setTestResult({ matched: data.matched, excerpt: data.matched_excerpt });
    } catch (err) {
      toast.error(`Test failed: ${extractApiError(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const actions = buildActions();
    if (!name.trim()) {
      toast.error('Give the rule a name');
      return;
    }
    if (actions.length === 0) {
      toast.error('Pick at least one action');
      return;
    }
    setSaving(true);
    try {
      const { data } = await automodApi.createRule(guildId, {
        name: name.trim(),
        trigger_type: triggerType,
        trigger_metadata: meta,
        actions,
        exempt_role_ids: exemptRoleIds,
      });
      toast.success(`Created “${data.name}”`);
      onCreated(data);
    } catch (err) {
      toast.error(`Failed to create rule: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Raised bare lifted className="flex flex-col gap-5 p-5">
      <div>
        <FieldLabel>Rule name</FieldLabel>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="No advertising"
          maxLength={100}
          aria-label="Rule name"
        />
      </div>

      <div>
        <FieldLabel>What it looks for</FieldLabel>
        <Tabs
          label="What the rule looks for"
          items={triggerTabs}
          value={String(triggerType)}
          onChange={(next) => changeTrigger(Number(next))}
          size="sm"
          className="w-full overflow-x-auto"
        />
        <p className="mt-2 text-meta leading-relaxed text-text-secondary">
          {TRIGGER_DESCRIPTIONS[triggerType]}
        </p>
      </div>

      <TriggerFields meta={meta} onChange={setMeta} />

      {/* Dry run */}
      <div>
        <FieldLabel>Try it before you enable it</FieldLabel>
        <div className="flex gap-2">
          <Input
            value={sample}
            onChange={(e) => {
              setSample(e.target.value);
              setTestResult(null);
            }}
            placeholder="Paste a message to check…"
            aria-label="Message to check"
          />
          <Button variant="ghost" onClick={() => void runTest()} disabled={testing || !sample}>
            {testing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FlaskConical size={14} />
            )}
            Test
          </Button>
        </div>
        {testResult && (
          <p
            className={`mt-2 text-meta leading-relaxed ${
              testResult.matched ? 'text-accent-warning' : 'text-accent-success'
            }`}
          >
            {testResult.matched
              ? `Would trigger — ${testResult.excerpt}`
              : 'Would not trigger.'}
          </p>
        )}
      </div>

      {/* Actions */}
      <div>
        <FieldLabel>What happens</FieldLabel>
        <Well bare className="divide-y divide-border-subtle px-4">
          <ToggleRow
            label="Block the message"
            description="The sender sees your reason and the message is never posted."
            checked={block}
            onChange={setBlock}
          />
          {block && (
            <div className="py-3">
              <Input
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="Reason shown to the sender (optional)"
                maxLength={200}
                aria-label="Reason shown to the sender"
              />
            </div>
          )}
          <ToggleRow
            label="Time the member out"
            description="Temporarily stops them from sending messages."
            checked={timeoutEnabled}
            onChange={setTimeoutEnabled}
          />
          {timeoutEnabled && (
            <div className="flex items-center gap-2 py-3">
              <Input
                type="number"
                min={1}
                max={40320}
                className="w-28"
                value={timeoutMinutes}
                onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
                aria-label="Timeout length in minutes"
              />
              <span className="text-meta text-text-secondary">minutes</span>
            </div>
          )}
          <div className="py-3">
            <FieldLabel>Alert a channel (optional)</FieldLabel>
            <Select
              value={alertChannelId}
              onChange={(e) => setAlertChannelId(e.target.value)}
              aria-label="Channel to alert"
            >
              <option value="">Don’t post an alert</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name ?? 'channel'}
                </option>
              ))}
            </Select>
          </div>
        </Well>
      </div>

      {/* Exemptions */}
      {roles.length > 0 && (
        <div>
          <FieldLabel>Roles this never applies to</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {roles.map((role) => {
              const on = exemptRoleIds.includes(role.id);
              return (
                <Chip
                  key={role.id}
                  as="button"
                  aria-pressed={on}
                  onClick={() =>
                    setExemptRoleIds((prev) =>
                      on ? prev.filter((id) => id !== role.id) : [...prev, role.id],
                    )
                  }
                  className={on ? 'bg-bg-mod-strong text-text-primary' : undefined}
                >
                  {on && <Check size={12} aria-hidden />}
                  {role.name ?? 'role'}
                </Chip>
              );
            })}
          </div>
        </div>
      )}

      <Divider />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />}
          Create rule
        </Button>
      </div>
    </Raised>
  );
}

function TriggerFields({
  meta,
  onChange,
}: {
  meta: TriggerMetadata;
  onChange: (next: TriggerMetadata) => void;
}) {
  switch (meta.kind) {
    case 'keyword':
      return (
        <div className="flex flex-col gap-3">
          <div>
            <FieldLabel>Keywords</FieldLabel>
            <Textarea
              className="min-h-[84px] resize-y"
              value={meta.keywords.join('\n')}
              onChange={(e) => onChange({ ...meta, keywords: textAreaList(e.target.value) })}
              placeholder={'One per line, or comma separated'}
              aria-label="Keywords"
            />
          </div>
          <Well bare className="px-4">
            <ToggleRow
              label="Whole words only"
              description="“ass” won’t flag “assignment”."
              checked={meta.whole_word ?? false}
              onChange={(v) => onChange({ ...meta, whole_word: v })}
            />
          </Well>
        </div>
      );
    case 'regex':
      return (
        <div>
          <FieldLabel>Patterns</FieldLabel>
          <Textarea
            className="pc-mono min-h-[84px] resize-y text-meta"
            value={meta.patterns.join('\n')}
            onChange={(e) =>
              onChange({ ...meta, patterns: e.target.value.split('\n').map((v) => v.trim()).filter(Boolean) })
            }
            placeholder={'\\bfree\\s+nitro\\b'}
            aria-label="Patterns"
          />
          <p className="mt-1.5 text-meta leading-relaxed text-text-secondary">
            One pattern per line. Case-insensitive. Invalid patterns are rejected when you save.
          </p>
        </div>
      );
    case 'mention_flood':
      return (
        <div>
          <FieldLabel>Maximum mentions per message</FieldLabel>
          <Input
            type="number"
            min={1}
            max={100}
            className="w-32"
            value={meta.max_mentions}
            onChange={(e) => onChange({ ...meta, max_mentions: Number(e.target.value) })}
            aria-label="Maximum mentions per message"
          />
        </div>
      );
    case 'message_spam':
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <FieldLabel>Messages</FieldLabel>
            <Input
              type="number"
              min={1}
              max={100}
              className="w-28"
              value={meta.max_messages}
              onChange={(e) => onChange({ ...meta, max_messages: Number(e.target.value) })}
              aria-label="Messages"
            />
          </div>
          <div>
            <FieldLabel>Within (seconds)</FieldLabel>
            <Input
              type="number"
              min={2}
              max={3600}
              className="w-28"
              value={meta.window_seconds}
              onChange={(e) => onChange({ ...meta, window_seconds: Number(e.target.value) })}
              aria-label="Within (seconds)"
            />
          </div>
        </div>
      );
    case 'link':
      return (
        <div className="flex flex-col gap-3">
          <Well bare className="divide-y divide-border-subtle px-4">
            <ToggleRow
              label="Block invite links"
              description="Invites to other spaces on any Paracord server."
              checked={meta.block_invites ?? false}
              onChange={(v) => onChange({ ...meta, block_invites: v })}
            />
            <ToggleRow
              label="Block all links"
              description="Everything except the domains you allow below."
              checked={meta.block_all ?? false}
              onChange={(v) => onChange({ ...meta, block_all: v })}
            />
          </Well>
          {meta.block_all && (
            <div>
              <FieldLabel>Allowed domains</FieldLabel>
              <Textarea
                className="min-h-[64px] resize-y"
                value={(meta.allowed_domains ?? []).join('\n')}
                onChange={(e) =>
                  onChange({ ...meta, allowed_domains: textAreaList(e.target.value) })
                }
                placeholder={'example.com'}
                aria-label="Allowed domains"
              />
              <p className="mt-1.5 text-meta leading-relaxed text-text-secondary">
                Subdomains are included automatically.
              </p>
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
}
