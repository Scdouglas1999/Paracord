import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, UserRoundCheck, Check, X } from 'lucide-react';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { useChannelStore } from '../../stores/channelStore';
import { ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { IconButton } from '../ui/IconButton';
import {
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/Modal';
import { GroupLabel } from './SettingsPrimitives';
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

/**
 * The tick box on a choice row. A checked row is a **raised** surface carrying
 * a real tick; an unchecked one is the well it sits in. Color is never the
 * only cue (§9) — the tick is.
 */
function TickBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-window)]',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        checked
          ? 'bg-accent-primary text-text-on-accent'
          : 'bg-bg-mod-strong text-transparent shadow-[var(--shadow-well)]',
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </span>
  );
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
  const scope = useCurrentAccountScope();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [payload, setPayload] = useState<OnboardingPayload | null>(null);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    guildApi
      .getMyOnboardingState(guildId)
      .then(({ data }) => {
        if (canceled) return;
        const normalized = normalizeOnboardingPayload(data);
        setPayload(normalized);
        setAcceptedRules(normalized.member_state.accepted_rules);
        setSelectedRoleIds(normalized.member_state.selected_role_ids);
      })
      .catch((err: unknown) => {
        if (canceled) return;
        setError(extractApiError(err));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
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
      if (scope) void useChannelStore.getState().fetchChannels(guildId, scope);
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
    <Modal
      open
      // A required rules gate cannot be closed: Escape falls through to the same
      // guard the Later button uses, and the backdrop was never a close affordance.
      onClose={() => { if (canDismiss) setDismissed(true); }}
      closeOnBackdrop={false}
      labeledBy="guild-onboarding-title"
      describedBy={payload.settings.welcome_body ? 'guild-onboarding-description' : undefined}
      panelClassName="w-[min(94vw,42rem)]"
    >
      <div className="flex max-h-[min(86dvh,44rem)] flex-col">
        <ModalHeader className="pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <GroupLabel>Getting started</GroupLabel>
              <ModalTitle id="guild-onboarding-title" className="mt-1">
                {payload.settings.welcome_title || 'Welcome'}
              </ModalTitle>
              {payload.settings.welcome_body && (
                <ModalDescription id="guild-onboarding-description">
                  {payload.settings.welcome_body}
                </ModalDescription>
              )}
            </div>
            {canDismiss && (
              <IconButton
                label="Dismiss onboarding"
                onClick={() => setDismissed(true)}
                className="-mr-1 -mt-1"
              >
                <X size={16} />
              </IconButton>
            )}
          </div>
        </ModalHeader>
        <Divider />

        <ModalBody className="min-h-0 flex-1 space-y-6 overflow-auto py-5">
          {payload.settings.rules_text && (
            <section className="space-y-3">
              <GroupLabel className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-text-secondary" aria-hidden />
                Server rules
              </GroupLabel>
              <div className="scrollbar-thin pc-well max-h-40 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-body leading-relaxed text-text-secondary">
                {payload.settings.rules_text}
              </div>
              <label
                className={cn(
                  'flex min-h-[var(--h-control)] cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 text-label',
                  'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  'focus-within:shadow-[var(--focus-ring)]',
                  acceptedRules ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                <TickBox checked={acceptedRules} />
                <input
                  type="checkbox"
                  checked={acceptedRules}
                  onChange={(event) => setAcceptedRules(event.target.checked)}
                  className="sr-only"
                />
                I have read and agree to follow these rules.
              </label>
            </section>
          )}

          {payload.settings.role_options.length > 0 && (
            <section className="space-y-3">
              <GroupLabel className="flex items-center gap-2">
                <UserRoundCheck size={15} className="text-text-secondary" aria-hidden />
                {payload.settings.role_prompt || 'Pick your interests'}
              </GroupLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                {payload.settings.role_options.map((option) => {
                  const checked = selectedRoleIds.includes(option.role_id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'group flex cursor-pointer items-start gap-3 px-3 py-2.5 text-label',
                        'rounded-[var(--radius-control)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                        'focus-within:shadow-[var(--focus-ring)]',
                        checked
                          ? 'bg-bg-raised shadow-[var(--shadow-raised)]'
                          : 'bg-bg-well shadow-[var(--shadow-well)] hover:bg-bg-mod-subtle',
                      )}
                    >
                      <TickBox checked={checked} />
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
                          <span className="mt-0.5 block text-meta leading-relaxed text-text-muted">
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

          {error && <ErrorBanner message={error} multiline />}
        </ModalBody>

        <Divider />
        <ModalFooter className="flex-col items-stretch gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-meta leading-relaxed text-text-muted">{helperCopy}</p>
          <div className="flex items-center justify-end gap-2">
            {canDismiss && (
              <Button variant="ghost" onClick={() => setDismissed(true)}>
                Later
              </Button>
            )}
            <Button onClick={() => void submit()} disabled={!canSubmit} loading={saving}>
              {saving ? 'Saving…' : 'Complete onboarding'}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}
