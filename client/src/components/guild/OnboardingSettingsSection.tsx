import { useEffect, useMemo, useState } from 'react';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import type { Role } from '../../types';
import { LoadingSpinner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';

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
      <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/40 p-4">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Onboarding</h3>
        <p className="mt-1 text-sm text-text-muted">
          Configure welcome text, rules gate, role picks, and progressive channel disclosure.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Welcome Title
        </span>
        <input
          className="input-field mt-2"
          value={welcomeTitle}
          onChange={(event) => setWelcomeTitle(event.target.value)}
          maxLength={120}
        />
      </label>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Welcome Message
        </span>
        <textarea
          className="input-field mt-2 min-h-24 resize-y"
          value={welcomeBody}
          onChange={(event) => setWelcomeBody(event.target.value)}
          maxLength={2000}
        />
      </label>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Rules Text (required for rules acceptance gate)
        </span>
        <textarea
          className="input-field mt-2 min-h-28 resize-y"
          value={rulesText}
          onChange={(event) => setRulesText(event.target.value)}
          maxLength={8000}
        />
      </label>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Role Prompt
        </span>
        <input
          className="input-field mt-2"
          value={rolePrompt}
          onChange={(event) => setRolePrompt(event.target.value)}
          maxLength={240}
        />
      </label>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Progressive Channel Minimum Messages
        </span>
        <input
          type="number"
          min={0}
          className="input-field mt-2"
          value={progressiveMinMessages}
          onChange={(event) =>
            setProgressiveMinMessages(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0)
          }
        />
      </label>

      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Role Options
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {selectableRoles.map((role) => {
            const checked = selectedRoleIds.includes(role.id);
            return (
              <label
                key={role.id}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  checked
                    ? 'border-accent-primary/50 bg-accent-primary/10 text-text-primary'
                    : 'border-border-subtle bg-bg-mod-subtle text-text-secondary'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelectedRoleIds((prev) =>
                      event.target.checked
                        ? Array.from(new Set([...prev, role.id]))
                        : prev.filter((id) => id !== role.id),
                    );
                  }}
                />
                <span>{role.name}</span>
              </label>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" disabled={saving} loading={saving} onClick={() => void onSave()}>
          Save Onboarding Settings
        </Button>
      </div>
    </div>
  );
}
