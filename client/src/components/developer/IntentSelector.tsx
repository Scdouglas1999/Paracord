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
  const toggle = (bit: number) => {
    const mask = 1 << bit;
    onChange(value ^ mask);
  };

  const isChecked = (bit: number) => ((value >> bit) & 1) === 1;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {INTENTS.map((intent) => (
          <label
            key={intent.bit}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
              intent.privileged
                ? 'border-yellow-500/40 bg-yellow-500/5 hover:bg-yellow-500/10'
                : 'border-border-subtle bg-bg-primary/40 hover:bg-bg-mod-subtle',
            )}
          >
            <input
              type="checkbox"
              checked={isChecked(intent.bit)}
              onChange={() => toggle(intent.bit)}
              className="mt-0.5 accent-accent-primary"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-text-primary">
                  {intent.name}
                </span>
                {intent.privileged && (
                  <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-yellow-400">
                    Privileged
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-text-muted">{intent.description}</p>
            </div>
          </label>
        ))}
      </div>
      <p className="text-xs text-text-muted">
        Intent value: <code className="rounded bg-bg-primary/60 px-1.5 py-0.5 text-text-secondary">{value}</code>
      </p>
    </div>
  );
}
