import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Chip, IconButton, ToggleRow, Well } from '../ui';

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
  { bit: 0, name: 'GUILDS', description: 'Server create/update/delete, channels, threads', privileged: false },
  { bit: 1, name: 'GUILD_MEMBERS', description: 'Member add/update/remove events', privileged: true },
  { bit: 2, name: 'GUILD_MODERATION', description: 'Ban add/remove events', privileged: false },
  { bit: 3, name: 'GUILD_EMOJIS_AND_STICKERS', description: 'Emoji and sticker updates', privileged: false },
  { bit: 4, name: 'GUILD_INTEGRATIONS', description: 'Integration updates', privileged: false },
  { bit: 5, name: 'GUILD_WEBHOOKS', description: 'Webhook updates', privileged: false },
  { bit: 6, name: 'GUILD_INVITES', description: 'Invite create/delete events', privileged: false },
  { bit: 7, name: 'GUILD_VOICE_STATES', description: 'Voice state updates', privileged: false },
  { bit: 8, name: 'GUILD_PRESENCES', description: 'Presence updates for members', privileged: true },
  { bit: 9, name: 'GUILD_MESSAGES', description: 'Message create/update/delete in servers', privileged: false },
  { bit: 10, name: 'GUILD_MESSAGE_REACTIONS', description: 'Reaction add/remove in servers', privileged: false },
  { bit: 11, name: 'GUILD_MESSAGE_TYPING', description: 'Typing start events in servers', privileged: false },
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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-section text-text-faint">Gateway intents</span>
        <span className="text-meta tabular-nums text-text-faint">{enabledCount} enabled</span>
      </div>

      {/* Rows parted by hairlines, never tiled cards (§6.8). */}
      <div className="grid gap-x-8 sm:grid-cols-2">
        {INTENTS.map((intent) => (
          <ToggleRow
            key={intent.bit}
            className="border-b border-border-subtle py-2.5"
            checked={isChecked(intent.bit)}
            onChange={() => toggle(intent.bit)}
            ariaLabel={intent.privileged ? `${intent.name} (privileged intent)` : intent.name}
            label={
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="pc-mono text-meta text-text-primary">{intent.name}</span>
                {intent.privileged && (
                  <Chip size="sm" className="text-accent-warning">
                    Privileged
                  </Chip>
                )}
              </span>
            }
            description={intent.description}
          />
        ))}
      </div>

      {/* Computed intent bitfield readout with copy (spec §2 code face). */}
      <Well className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="shrink-0 text-section text-text-faint">Value</span>
        <code className="pc-mono min-w-0 flex-1 truncate text-meta text-text-primary">{value}</code>
        <IconButton label="Copy intent value" onClick={() => void copyValue()}>
          {copied ? <Check size={15} className="text-accent-success" /> : <Copy size={15} />}
        </IconButton>
      </Well>
    </div>
  );
}
