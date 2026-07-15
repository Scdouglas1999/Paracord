import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, UserRoundCheck, Check, X } from 'lucide-react';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { useChannelStore } from '../../stores/channelStore';
import { ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';
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
  const requiresRules = Boolean(payload?.settings.rules_text?.trim());
  // Rules acceptance is enforced server-side for channel visibility; soft-dismiss
  // must not bypass a required rules gate until onboarding is completed.
  const mustComplete = requiresRules && !isComplete;
  const canDismiss = !mustComplete;
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
      // Progressive channel unlocks depend on completed_at — refresh the list.
      void useChannelStore.getState().fetchChannels(guildId);
    } catch (err: unknown) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;
  if (!payload || !hasConfig || isComplete || (dismissed && canDismiss)) return null;

  const helperCopy = requiresRules && !acceptedRules
    ? 'Accept the server rules to continue.'
    : payload.settings.role_options.length > 0
      ? `${selectedRoleIds.length} role${selectedRoleIds.length === 1 ? '' : 's'} selected — you can change these later.`
      : "You're all set. Continue when you're ready.";

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg-tertiary/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border-strong bg-bg-accent shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle bg-bg-secondary px-6 py-5">
          <div className="min-w-0">
            <div className="text-section uppercase text-accent-primary">Getting started</div>
            <h3 className="mt-1 font-display text-title text-text-primary">
              {payload.settings.welcome_title || 'Welcome'}
            </h3>
            {payload.settings.welcome_body && (
              <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                {payload.settings.welcome_body}
              </p>
            )}
          </div>
          {canDismiss && (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
              aria-label="Dismiss onboarding"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="space-y-6 px-6 py-5">
          {payload.settings.rules_text && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-section uppercase text-text-muted">
                <ShieldCheck size={15} className="text-text-secondary" />
                Server rules
              </div>
              <div className="scrollbar-thin max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3 text-sm leading-relaxed text-text-secondary">
                {payload.settings.rules_text}
              </div>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-sm px-1 py-1.5 text-sm transition-colors',
                  acceptedRules ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                <input
                  type="checkbox"
                  checked={acceptedRules}
                  onChange={(event) => setAcceptedRules(event.target.checked)}
                  className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary"
                />
                I have read and agree to follow these rules.
              </label>
            </section>
          )}

          {payload.settings.role_options.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-section uppercase text-text-muted">
                <UserRoundCheck size={15} className="text-text-secondary" />
                {payload.settings.role_prompt || 'Pick your interests'}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {payload.settings.role_options.map((option) => {
                  const checked = selectedRoleIds.includes(option.role_id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'group flex cursor-pointer items-start gap-3 rounded-sm border px-3 py-2.5 text-sm transition-colors duration-[140ms] ease-[var(--ease-out)]',
                        checked
                          ? 'border-accent-primary bg-accent-tint'
                          : 'border-border-subtle bg-bg-tertiary hover:border-border-strong hover:bg-bg-mod-subtle',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border transition-colors',
                          checked
                            ? 'border-accent-primary bg-accent-primary text-text-on-accent'
                            : 'border-border-strong bg-transparent',
                        )}
                      >
                        {checked && <Check size={11} strokeWidth={3} />}
                      </span>
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
                        className="sr-only"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-text-primary">
                          {option.label || `Role ${option.role_id}`}
                        </span>
                        {option.description && (
                          <span className="mt-0.5 block text-meta text-text-muted">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {error && <ErrorBanner message={error} />}
        </div>

        <div className="flex flex-col gap-3 border-t border-border-subtle bg-bg-secondary px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-meta text-text-muted">{helperCopy}</p>
          <div className="flex items-center justify-end gap-2">
            {canDismiss && (
              <Button variant="ghost" onClick={() => setDismissed(true)}>
                Later
              </Button>
            )}
            <Button onClick={() => void submit()} disabled={!canSubmit} loading={saving}>
              {saving ? 'Saving…' : 'Complete Onboarding'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
