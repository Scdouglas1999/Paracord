import { cn } from '../../lib/utils';

interface PermissionCalculatorProps {
  value: string; // stringified bigint
  onChange: (permissions: string) => void;
}

interface PermFlag {
  bit: number;
  name: string;
  description: string;
}

const PERMISSION_FLAGS: PermFlag[] = [
  { bit: 0, name: 'Create Instant Invite', description: 'Create invites to the server' },
  { bit: 1, name: 'Kick Members', description: 'Remove members from the server' },
  { bit: 2, name: 'Ban Members', description: 'Permanently ban members' },
  { bit: 3, name: 'Administrator', description: 'Full access to all permissions' },
  { bit: 4, name: 'Manage Channels', description: 'Create, edit, and delete channels' },
  { bit: 5, name: 'Manage Guild', description: 'Edit server name, icon, and settings' },
  { bit: 6, name: 'Add Reactions', description: 'Add new reactions to messages' },
  { bit: 7, name: 'View Audit Log', description: 'View the server audit log' },
  { bit: 8, name: 'Priority Speaker', description: 'Priority in voice channels' },
  { bit: 9, name: 'Stream', description: 'Share screen in voice channels' },
  { bit: 10, name: 'View Channel', description: 'View text and voice channels' },
  { bit: 11, name: 'Send Messages', description: 'Send messages in text channels' },
  { bit: 12, name: 'Send TTS Messages', description: 'Send text-to-speech messages' },
  { bit: 13, name: 'Manage Messages', description: 'Delete or pin messages by others' },
  { bit: 14, name: 'Embed Links', description: 'Links auto-embed previews' },
  { bit: 15, name: 'Attach Files', description: 'Upload files and images' },
  { bit: 16, name: 'Read Message History', description: 'View past messages in channels' },
  { bit: 17, name: 'Mention Everyone', description: 'Use @everyone and @here' },
  { bit: 18, name: 'Use External Emojis', description: 'Use emojis from other servers' },
  { bit: 20, name: 'Connect', description: 'Connect to voice channels' },
  { bit: 21, name: 'Speak', description: 'Speak in voice channels' },
  { bit: 22, name: 'Mute Members', description: 'Mute others in voice channels' },
  { bit: 23, name: 'Deafen Members', description: 'Deafen others in voice channels' },
  { bit: 24, name: 'Move Members', description: 'Move members between voice channels' },
  { bit: 25, name: 'Use VAD', description: 'Use voice activity detection' },
  { bit: 26, name: 'Change Nickname', description: 'Change own nickname' },
  { bit: 27, name: 'Manage Nicknames', description: 'Change other members\' nicknames' },
  { bit: 28, name: 'Manage Roles', description: 'Create, edit, and delete roles' },
  { bit: 29, name: 'Manage Webhooks', description: 'Create, edit, and delete webhooks' },
  { bit: 30, name: 'Manage Emojis', description: 'Create, edit, and delete emojis' },
];

export function PermissionCalculator({ value, onChange }: PermissionCalculatorProps) {
  const current = (() => {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  })();

  const toggle = (bit: number) => {
    const mask = 1n << BigInt(bit);
    const next = current ^ mask;
    onChange(next.toString());
  };

  const isChecked = (bit: number) => (current & (1n << BigInt(bit))) !== 0n;

  const isAdmin = isChecked(3);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PERMISSION_FLAGS.map((perm) => (
          <label
            key={perm.bit}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
              perm.bit === 3
                ? 'border-accent-danger/40 bg-accent-danger/5 hover:bg-accent-danger/10'
                : 'border-border-subtle bg-bg-primary/40 hover:bg-bg-mod-subtle',
              isAdmin && perm.bit !== 3 && 'opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={isChecked(perm.bit)}
              onChange={() => toggle(perm.bit)}
              className="mt-0.5 accent-accent-primary"
            />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-semibold text-text-primary">{perm.name}</span>
              <p className="mt-0.5 text-[11px] text-text-muted">{perm.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="rounded-lg border border-border-subtle bg-bg-primary/40 px-3 py-2">
        <span className="text-xs text-text-muted">Permission value: </span>
        <code className="text-xs font-semibold text-text-secondary">{current.toString()}</code>
      </div>
    </div>
  );
}
