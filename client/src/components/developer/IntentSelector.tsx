import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';

interface IntentSelectorProps {
  value: number;
  onChange: (intents: number) => void;
}

interface IntentInfo {
  bit: number;
  name: string;
  description: string;
  privileged: boolean;
}

const INTENTS: IntentInfo[] = [
  { bit: 0, name: 'GUILDS', description: 'Guild create/update/delete, channels, threads', privileged: false },
  { bit: 1, name: 'GUILD_MEMBERS', description: 'Member add/update/remove events', privileged: true },
  { bit: 2, name: 'GUILD_MODERATION', description: 'Ban add/remove events', privileged: false },
  { bit: 3, name: 'GUILD_EMOJIS_AND_STICKERS', description: 'Emoji and sticker updates', privileged: false },
  { bit: 4, name: 'GUILD_INTEGRATIONS', description: 'Integration updates', privileged: false },
  { bit: 5, name: 'GUILD_WEBHOOKS', description: 'Webhook updates', privileged: false },
  { bit: 6, name: 'GUILD_INVITES', description: 'Invite create/delete events', privileged: false },
  { bit: 7, name: 'GUILD_VOICE_STATES', description: 'Voice state updates', privileged: false },
  { bit: 8, name: 'GUILD_PRESENCES', description: 'Presence updates for members', privileged: true },
  { bit: 9, name: 'GUILD_MESSAGES', description: 'Message create/update/delete in guilds', privileged: false },
  { bit: 10, name: 'GUILD_MESSAGE_REACTIONS', description: 'Reaction add/remove in guilds', privileged: false },
  { bit: 11, name: 'GUILD_MESSAGE_TYPING', description: 'Typing start events in guilds', privileged: false },
  { bit: 12, name: 'DIRECT_MESSAGES', description: 'DM message events', privileged: false },
  { bit: 13, name: 'DIRECT_MESSAGE_REACTIONS', description: 'DM reaction events', privileged: false },
  { bit: 14, name: 'DIRECT_MESSAGE_TYPING', description: 'DM typing events', privileged: false },
  { bit: 15, name: 'MESSAGE_CONTENT', description: 'Access to message content', privileged: true },
  { bit: 16, name: 'GUILD_SCHEDULED_EVENTS', description: 'Scheduled event lifecycle', privileged: false },
  { bit: 20, name: 'AUTO_MODERATION_CONFIGURATION', description: 'Auto-mod rule changes', privileged: false },
  { bit: 21, name: 'AUTO_MODERATION_EXECUTION', description: 'Auto-mod action execution', privileged: false },
];

export function IntentSelector({ value, onChange }: IntentSelectorProps) {
  const [copied, setCopied] = useState(false);

  const toggle = (bit: number) => {
    const mask = 1 << bit;
    onChange(value ^ mask);
  };

  const isChecked = (bit: number) => ((value >> bit) & 1) === 1;
  const enabledCount = INTENTS.filter((i) => isChecked(i.bit)).length;

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — no-op
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-section uppercase text-text-muted">Gateway intents</span>
        <span className="text-meta tabular-nums text-text-muted">{enabledCount} enabled</span>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {INTENTS.map((intent) => (
          <label
            key={intent.bit}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2 transition-colors duration-[140ms] ease-[var(--ease-out)]',
              intent.privileged
                ? 'border-accent-warning/35 bg-warning-tint hover:bg-accent-warning/20'
                : 'border-border-subtle bg-bg-mod-subtle hover:bg-bg-mod-strong',
            )}
          >
            <input
              type="checkbox"
              checked={isChecked(intent.bit)}
              onChange={() => toggle(intent.bit)}
              className="mt-0.5 accent-accent-primary"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-label text-text-primary">{intent.name}</span>
                {intent.privileged && (
                  <span className="rounded-xs bg-warning-tint px-1.5 py-0.5 text-meta font-semibold uppercase text-accent-warning">
                    Privileged
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-meta text-text-muted">{intent.description}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Computed intent bitfield readout with copy (design-spec §2 code face). */}
      <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-3.5 py-2.5">
        <span className="text-section shrink-0 uppercase text-text-muted">Value</span>
        <code className="min-w-0 flex-1 truncate font-code text-meta text-text-primary">{value}</code>
        <button
          type="button"
          onClick={() => void copyValue()}
          aria-label="Copy intent value"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
        >
          {copied ? <Check size={15} className="text-accent-success" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  );
}
