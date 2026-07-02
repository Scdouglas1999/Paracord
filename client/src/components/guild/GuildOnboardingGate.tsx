import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, UserRoundCheck, X } from 'lucide-react';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { LoadingSpinner } from '../ui/Feedback';
import { cn } from '../../lib/utils';

interface GuildOnboardingGateProps {
  guildId: string;
}

type OnboardingPayload = {
  settings: {
    welcome_title?: string | null;
    welcome_body?: string | null;
    rules_text?: string | null;
    role_prompt?: string | null;
    role_options: Array<{
      id: string;
      role_id: string;
      label?: string | null;
      description?: string | null;
    }>;
  };
  member_state: {
    accepted_rules: boolean;
    selected_role_ids: string[];
    completed_at?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOnboardingPayload(raw: unknown): OnboardingPayload {
  const root = isRecord(raw) ? raw : {};
  const rawSettings = isRecord(root.settings) ? root.settings : {};
  const rawMemberState = isRecord(root.member_state) ? root.member_state : {};
  const rawRoleOptions = Array.isArray(rawSettings.role_options) ? rawSettings.role_options : [];

  return {
    settings: {
      welcome_title:
        typeof rawSettings.welcome_title === 'string' ? rawSettings.welcome_title : null,
      welcome_body: typeof rawSettings.welcome_body === 'string' ? rawSettings.welcome_body : null,
      rules_text: typeof rawSettings.rules_text === 'string' ? rawSettings.rules_text : null,
      role_prompt: typeof rawSettings.role_prompt === 'string' ? rawSettings.role_prompt : null,
      role_options: rawRoleOptions
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: String(item.id ?? ''),
          role_id: String(item.role_id ?? ''),
          label: typeof item.label === 'string' ? item.label : null,
          description: typeof item.description === 'string' ? item.description : null,
        }))
        .filter((item) => item.id.length > 0 && item.role_id.length > 0),
    },
    member_state: {
      accepted_rules: Boolean(rawMemberState.accepted_rules),
      selected_role_ids: Array.isArray(rawMemberState.selected_role_ids)
        ? rawMemberState.selected_role_ids.map((id) => String(id))
        : [],
      completed_at:
        typeof rawMemberState.completed_at === 'string' ? rawMemberState.completed_at : null,
    },
  };
}

export function GuildOnboardingGate({ guildId }: GuildOnboardingGateProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [payload, setPayload] = useState<OnboardingPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    guildApi
      .getMyOnboardingState(guildId)
      .then(({ data }) => {
        if (cancelled) return;
        const normalized = normalizeOnboardingPayload(data);
        setPayload(normalized);
        setAcceptedRules(normalized.member_state.accepted_rules);
        setSelectedRoleIds(normalized.member_state.selected_role_ids);
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

  const hasConfig = useMemo(() => {
    if (!payload) return false;
    const { settings } = payload;
    return Boolean(
      settings.welcome_title ||
        settings.welcome_body ||
        settings.rules_text ||
        settings.role_options.length > 0,
    );
  }, [payload]);

  const isComplete = Boolean(payload?.member_state.completed_at);
  const requiresRules = Boolean(payload?.settings.rules_text);
  const canSubmit = !saving && (!requiresRules || acceptedRules);

  const submit = async () => {
    if (!payload || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await guildApi.updateMyOnboardingState(guildId, {
        accepted_rules: acceptedRules,
        selected_role_ids: selectedRoleIds,
        completed: true,
      });
      toast.success('Onboarding complete.');
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              member_state: {
                ...prev.member_state,
                accepted_rules: acceptedRules,
                selected_role_ids: selectedRoleIds,
                completed_at: new Date().toISOString(),
              },
            }
          : prev,
      );
    } catch (err: unknown) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;
  if (!payload || !hasConfig || isComplete || dismissed) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg-tertiary/70 p-4 backdrop-blur-sm">
      <div className="glass-modal w-full max-w-2xl rounded-2xl border border-border-subtle">
        <div className="flex items-center justify-between border-b border-border-subtle/70 px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              {payload.settings.welcome_title || 'Welcome'}
            </h3>
            {payload.settings.welcome_body && (
              <p className="mt-1 text-sm text-text-secondary">{payload.settings.welcome_body}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="icon-btn"
            aria-label="Dismiss onboarding"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {payload.settings.rules_text && (
            <section className="space-y-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <ShieldCheck size={16} />
                Server Rules
              </div>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-text-secondary">
                {payload.settings.rules_text}
              </div>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={acceptedRules}
                  onChange={(event) => setAcceptedRules(event.target.checked)}
                />
                I have read and agree to follow these rules.
              </label>
            </section>
          )}

          {payload.settings.role_options.length > 0 && (
            <section className="space-y-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <UserRoundCheck size={16} />
                {payload.settings.role_prompt || 'Pick your interests'}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {payload.settings.role_options.map((option) => {
                  const checked = selectedRoleIds.includes(option.role_id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors',
                        checked
                          ? 'border-accent-primary/50 bg-accent-primary/10 text-text-primary'
                          : 'border-border-subtle bg-bg-primary/40 text-text-secondary',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedRoleIds((prev) =>
                              event.target.checked
                                ? Array.from(new Set([...prev, option.role_id]))
                                : prev.filter((id) => id !== option.role_id),
                            );
                          }}
                        />
                        <span className="font-medium text-text-primary">
                          {option.label || `Role ${option.role_id}`}
                        </span>
                      </div>
                      {option.description && (
                        <p className="mt-1 text-xs text-text-muted">{option.description}</p>
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {error && (
            <div className="rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle/70 px-6 py-4">
          <button type="button" className="btn-ghost" onClick={() => setDismissed(true)}>
            Later
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
            {saving ? (
              <span className="inline-flex items-center gap-2">
                <LoadingSpinner size="sm" />
                Saving...
              </span>
            ) : (
              'Complete Onboarding'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
