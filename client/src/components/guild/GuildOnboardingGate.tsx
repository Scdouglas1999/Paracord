import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { useChannelStore } from '../../stores/channelStore';
import { useGuild } from '../../hooks/useGuilds';
import { cn } from '../../lib/utils';
import { IxGlyph } from '../ix/glyphs';
import { LargeTitle } from '../ix/page';
import { CreamButton, ToolChip } from '../ix/primitives';
import { serverPlace, usePlaceHue } from '../ix/shell';

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


/**
 * A choice on the page: a tick box and its words. A checked one is lit (a lit edge and a
 * stronger fill) and carries a real tick; color is never the only cue (§10). The input
 * is the control, so the whole card is one click and one Tab stop.
 */
function Choice({
  checked,
  onChange,
  title,
  description,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description?: string | null;
  className?: string;
}) {
  return (
    <label className={cn('ix-choice', className)} data-checked={checked || undefined}>
      <input type="checkbox" className="ix-choice__input" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="ix-choice__box" aria-hidden>
        {checked && <IxGlyph name="check" size={13} />}
      </span>
      <span className="ix-choice__text">
        <span className="ix-choice__title">{title}</span>
        {description && <span className="ix-choice__desc">{description}</span>}
      </span>
    </label>
  );
}

/**
 * The page the server shows before it opens (docs/index-spec.md §8.3: "kept as a page in
 * main"): its welcome, its rules, and the roles to pick. It covers main under the toolbar
 * (it is rendered into the routed page's area, so the conversation behind it is inert) and
 * leaves when it is done. A required rules gate cannot be dismissed (the server enforces it
 * on channel visibility too); the rest has "Later".
 *
 * Mounted from the conversation's notices (`GuildPage`), so it works wherever the server's
 * conversation is, in the frame or, in a test, bare.
 */
export function GuildOnboardingGate({ guildId }: GuildOnboardingGateProps) {
  const scope = useCurrentAccountScope();
  const guild = useGuild(guildId);
  const hue = usePlaceHue(serverPlace(guildId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [payload, setPayload] = useState<OnboardingPayload | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const page = useRef<HTMLDivElement>(null);

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
  const shown = !loading && Boolean(payload) && hasConfig && !isComplete && !(dismissed && canDismiss);

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

  // The routed page's area is where the conversation will be; the page goes over it.
  useLayoutEffect(() => {
    if (!shown) return;
    setHost(document.querySelector<HTMLElement>('.ix-main__content'));
  }, [shown]);

  // Whatever the page covers stays out of the Tab order and the reading order while it is up.
  useEffect(() => {
    const root = page.current;
    const parent = root?.parentElement;
    if (!root || !parent || parent !== host) return;
    const covered = [...parent.children].filter((child): child is HTMLElement => child !== root && child instanceof HTMLElement);
    const was = covered.map((child) => Boolean(child.inert));
    for (const child of covered) child.inert = true;
    return () => {
      covered.forEach((child, index) => {
        child.inert = was[index];
      });
    };
  }, [host, shown]);

  // The page took over: focus goes to it, once, so a keyboard or screen reader user starts
  // at its top and not on the conversation it covers.
  const focused = useRef(false);
  useEffect(() => {
    if (!shown || focused.current || !page.current) return;
    focused.current = true;
    page.current.focus({ preventScroll: true });
  }, [shown, host]);

  // Esc is "Later", where there is a Later.
  useEffect(() => {
    if (!shown || !canDismiss) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      setDismissed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, canDismiss]);

  if (!shown || !payload) return null;
  // Inside the frame the page goes over main; the first paint waits for its host.
  const inFrame = typeof document !== 'undefined' && document.querySelector('.ix-main__content') !== null;
  if (inFrame && !host) return null;

  const helperCopy = requiresRules && !acceptedRules
    ? 'Accept the server rules to continue.'
    : payload.settings.role_options.length > 0
      ? `${selectedRoleIds.length} role${selectedRoleIds.length === 1 ? '' : 's'} selected — you can change these later.`
      : "You're all set. Continue when you're ready.";

  const content = (
    <div
      ref={page}
      className="ix-gate ix-hue-main"
      style={{ '--ix-hue': hue } as CSSProperties}
      role="region"
      aria-label="Getting started"
      tabIndex={-1}
      data-testid="ix-gate"
      data-covering={host ? true : undefined}
    >
      <div className="ix-gate__scroll">
        <div className="ix-column">
          <LargeTitle
            title={payload.settings.welcome_title || (guild?.name ? `Welcome to ${guild.name}` : 'Welcome')}
            subtitle={payload.settings.welcome_body || undefined}
          />

          <div className="ix-gate__body">
            {payload.settings.rules_text && (
              <section className="ix-gate__sec" aria-labelledby="gate-rules">
                <h2 id="gate-rules" className="ix-gate__label">Server rules</h2>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll the rules with Page Up/Down and Home/End. */}
                <div className="ix-gate__rules" tabIndex={0} aria-label="Server rules text">
                  {payload.settings.rules_text}
                </div>
                <Choice
                  checked={acceptedRules}
                  onChange={setAcceptedRules}
                  title="I have read and agree to follow these rules."
                />
              </section>
            )}

            {payload.settings.role_options.length > 0 && (
              <section className="ix-gate__sec" aria-labelledby="gate-roles">
                <h2 id="gate-roles" className="ix-gate__label">{payload.settings.role_prompt || 'Pick your interests'}</h2>
                <div className="ix-gate__choices">
                  {payload.settings.role_options.map((option) => (
                    <Choice
                      key={option.id}
                      className="ix-choice--card"
                      checked={selectedRoleIds.includes(option.role_id)}
                      onChange={(next) =>
                        setSelectedRoleIds((prev) =>
                          next ? Array.from(new Set([...prev, option.role_id])) : prev.filter((id) => id !== option.role_id),
                        )
                      }
                      title={option.label || `Role ${option.role_id}`}
                      description={option.description}
                    />
                  ))}
                </div>
              </section>
            )}

            {error && (
              <p role="alert" className="ix-note" data-tone="danger">
                {error}
              </p>
            )}
          </div>

          <div className="ix-gate__foot">
            <p className="ix-gate__help" role="status">{helperCopy}</p>
            <div className="ix-gate__acts">
              {canDismiss && (
                <ToolChip onClick={() => setDismissed(true)} aria-label="Later">
                  Later
                </ToolChip>
              )}
              <CreamButton onClick={() => void submit()} disabled={!canSubmit || saving}>
                {saving ? 'Saving…' : 'Complete onboarding'}
              </CreamButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return host ? createPortal(content, host) : content;
}
