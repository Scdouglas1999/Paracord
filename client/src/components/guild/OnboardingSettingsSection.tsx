import { useEffect, useMemo, useState } from 'react';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import type { Role } from '../../types';
import { LoadingSpinner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { toast } from '../../stores/toastStore';
import { SectionHeader, FieldLabel, GroupLabel } from './SettingsPrimitives';
import { cn } from '../../lib/utils';

interface OnboardingSettingsSectionProps {
  guildId: string;
  roles: Role[];
}

export function OnboardingSettingsSection({ guildId, roles }: OnboardingSettingsSectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcomeTitle, setWelcomeTitle] = useState('');
  const [welcomeBody, setWelcomeBody] = useState('');
  const [rulesText, setRulesText] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [progressiveMinMessages, setProgressiveMinMessages] = useState(0);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    guildApi
      .getOnboarding(guildId)
      .then(({ data }) => {
        if (cancelled) return;
        setWelcomeTitle(data.welcome_title || '');
        setWelcomeBody(data.welcome_body || '');
        setRulesText(data.rules_text || '');
        setRolePrompt(data.role_prompt || '');
        setProgressiveMinMessages(data.progressive_channel_min_messages || 0);
        setSelectedRoleIds(data.role_options.map((option) => option.role_id));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(extractApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId]);

  const selectableRoles = useMemo(
    () => roles.filter((role) => role.id !== guildId).sort((a, b) => b.position - a.position),
    [roles, guildId],
  );

  const roleColorHex = (role: Role) =>
    role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'var(--text-muted)';

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await guildApi.updateOnboarding(guildId, {
        welcome_title: welcomeTitle || null,
        welcome_body: welcomeBody || null,
        rules_text: rulesText || null,
        role_prompt: rolePrompt || null,
        progressive_channel_min_messages: Math.max(0, progressiveMinMessages),
        role_options: selectedRoleIds.map((roleId, index) => {
          const role = selectableRoles.find((candidate) => candidate.id === roleId);
          return {
            role_id: roleId,
            label: role?.name || undefined,
            description: undefined,
            position: index,
          };
        }),
      });
      toast.success('Onboarding settings saved.');
    } catch (err: unknown) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner label="Loading onboarding…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Onboarding"
        description="Shape a member's first minutes — a welcome, a rules gate, self-serve roles, and how quickly channels reveal themselves."
        action={
          <Button type="button" disabled={saving} loading={saving} onClick={() => void onSave()}>
            Save Onboarding Settings
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-accent-danger/35 bg-danger-tint px-4 py-3 text-label text-accent-danger">
          {error}
        </div>
      )}

      {/* Welcome */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Welcome</GroupLabel>
        <div className="mt-4 flex flex-col gap-5">
          <label className="block">
            <FieldLabel>Welcome Title</FieldLabel>
            <Input
              value={welcomeTitle}
              onChange={(event) => setWelcomeTitle(event.target.value)}
              maxLength={120}
              placeholder="Welcome aboard"
            />
          </label>
          <label className="block">
            <FieldLabel>Welcome Message</FieldLabel>
            <Textarea
              className="min-h-24 resize-y"
              value={welcomeBody}
              onChange={(event) => setWelcomeBody(event.target.value)}
              maxLength={2000}
              placeholder="Tell newcomers what this community is about."
            />
          </label>
        </div>
      </section>

      {/* Rules gate */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Rules gate</GroupLabel>
        <div className="mt-4 flex flex-col gap-5">
          <label className="block">
            <FieldLabel>Rules Text (required for rules acceptance gate)</FieldLabel>
            <Textarea
              className="min-h-28 resize-y"
              value={rulesText}
              onChange={(event) => setRulesText(event.target.value)}
              maxLength={8000}
              placeholder="New members must accept these before they can post."
            />
          </label>
        </div>
      </section>

      {/* Self-serve roles */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Self-serve roles</GroupLabel>
        <div className="mt-4 flex flex-col gap-5">
          <label className="block">
            <FieldLabel>Role Prompt</FieldLabel>
            <Input
              value={rolePrompt}
              onChange={(event) => setRolePrompt(event.target.value)}
              maxLength={240}
              placeholder="Choose the roles that fit you"
            />
          </label>
          <div>
            <FieldLabel>Role Options</FieldLabel>
            {selectableRoles.length === 0 ? (
              <p className="text-[13.5px] leading-relaxed text-text-secondary">
                Create roles first — they'll appear here as pickable options for new members.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {selectableRoles.map((role) => {
                  const checked = selectedRoleIds.includes(role.id);
                  return (
                    <label
                      key={role.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2.5 text-label transition-colors',
                        checked
                          ? 'border-accent-primary/50 bg-accent-tint text-text-primary'
                          : 'border-border-subtle text-text-secondary hover:bg-bg-mod-subtle',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded-sm border-border-subtle accent-accent-primary"
                        checked={checked}
                        onChange={(event) => {
                          setSelectedRoleIds((prev) =>
                            event.target.checked
                              ? Array.from(new Set([...prev, role.id]))
                              : prev.filter((id) => id !== role.id),
                          );
                        }}
                      />
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: roleColorHex(role) }}
                        aria-hidden
                      />
                      <span className="truncate">{role.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Progressive disclosure */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Progressive disclosure</GroupLabel>
        <div className="mt-4">
          <div className="max-w-xs">
            <label className="block">
              <FieldLabel>Progressive Channel Minimum Messages</FieldLabel>
              <Input
                type="number"
                min={0}
                className="font-code tabular-nums"
                value={progressiveMinMessages}
                onChange={(event) =>
                  setProgressiveMinMessages(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0)
                }
              />
            </label>
            <p className="mt-2 text-meta text-text-muted">
              Hide gated channels until a member has sent this many messages. Set to 0 to reveal everything at once.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
