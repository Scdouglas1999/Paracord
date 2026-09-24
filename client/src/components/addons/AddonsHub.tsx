import { isValidElement, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { confirm } from '../../stores/confirmStore';
import { toast } from '../../stores/toastStore';
import { Button, Chip, Switch, Well } from '../ui';
import { SectionHeader } from '../guild/SettingsPrimitives';
import { ADDONS, findAddon, type AddonDescriptor } from './registry';

function AddonIcon({ icon, size = 22 }: { icon: AddonDescriptor['icon']; size?: number }) {
  if (isValidElement(icon)) return icon;
  if (icon && (typeof icon === 'function' || typeof icon === 'object')) {
    const Icon = icon as ComponentType<{ size?: number }>;
    return <Icon size={size} />;
  }
  return <>{icon as ReactNode}</>;
}

/** An add-on's mark, the same tile on the hub and at the top of its page. */
export function AddonMark({ addon }: { addon: AddonDescriptor }) {
  return (
    <span className="pc-addon-mark" aria-hidden>
      <AddonIcon icon={addon.icon} />
    </span>
  );
}

type StatusState = { state: 'loading' } | { state: 'ready'; enabled: boolean } | { state: 'error'; message: string };

function AddonCard({
  addon,
  guildId,
  onOpen,
}: {
  addon: AddonDescriptor;
  guildId: string;
  onOpen: () => void;
}) {
  const [status, setStatus] = useState<StatusState>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const loader = addon.status;

  useEffect(() => {
    if (!loader) return;
    let canceled = false;
    setStatus({ state: 'loading' });
    loader.load(guildId).then(
      (enabled) => {
        if (!canceled) setStatus({ state: 'ready', enabled });
      },
      (err: unknown) => {
        if (!canceled) setStatus({ state: 'error', message: extractApiError(err) });
      },
    );
    return () => {
      canceled = true;
    };
  }, [guildId, loader]);

  const toggle = async (next: boolean) => {
    if (!loader) return;
    if (!next) {
      const ok = await confirm({
        title: `Turn off ${addon.name}?`,
        description: 'Its settings stay saved, so you can turn it on again later.',
        confirmLabel: 'Turn off',
        cancelLabel: 'Cancel',
        variant: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await loader.set(guildId, next);
      setStatus({ state: 'ready', enabled: next });
      toast.success(next ? `${addon.name} turned on.` : `${addon.name} turned off.`);
    } catch (err) {
      toast.error(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const enabled = status.state === 'ready' && status.enabled;
  const nameId = `addon-${addon.id}-name`;

  return (
    <li className="pc-feed-row">
      <Well bare className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 gap-3">
          <AddonMark addon={addon} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={nameId} className="font-display text-name font-semibold text-text-primary">
                {addon.name}
              </h3>
              {enabled && <Chip size="sm" tone="accent">On</Chip>}
            </div>
            <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{addon.description}</p>
            {status.state === 'error' && (
              <p className="mt-1 text-meta text-accent-danger">{status.message}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 pl-[52px] sm:pl-0">
          {loader && (
            <Switch
              checked={enabled}
              onChange={(next) => void toggle(next)}
              disabled={saving || status.state !== 'ready'}
              label={`${addon.name} on this server`}
            />
          )}
          <Button size="sm" variant="ghost" onClick={onOpen} aria-describedby={nameId}>
            Set up
            <ChevronRight size={14} aria-hidden />
          </Button>
        </div>
      </Well>
    </li>
  );
}

/**
 * Server settings → Add-ons: a card for each add-on (on/off and "Set up"),
 * and the add-on's own page once one is opened.
 */
export function AddonsHub({ guildId, initialAddon }: { guildId: string; initialAddon?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(() => findAddon(initialAddon)?.id ?? null);
  const open = findAddon(openId);

  useEffect(() => {
    const requested = findAddon(initialAddon);
    if (requested) setOpenId(requested.id);
  }, [initialAddon]);

  const back = useCallback(() => setOpenId(null), []);

  if (open) {
    const Section = open.Section;
    return (
      <div key={open.id} className="pc-feed-row flex h-full min-h-0 flex-col gap-4">
        <div>
          <Button size="sm" variant="ghost" onClick={back} className="-ml-2">
            <ChevronLeft size={16} aria-hidden />
            Add-ons
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <Section guildId={guildId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 overflow-y-auto">
      <SectionHeader
        title="Add-ons"
        description="Extras you can add to this server. Everyone in the server can use what you add."
      />
      <ul className="flex flex-col gap-3" aria-label="Add-ons">
        {ADDONS.map((addon) => (
          <AddonCard key={addon.id} addon={addon} guildId={guildId} onOpen={() => setOpenId(addon.id)} />
        ))}
      </ul>
    </div>
  );
}
