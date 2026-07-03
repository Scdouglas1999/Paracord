import { cn } from '../../lib/utils';
import { Permissions } from '../../types';

interface PermissionCalculatorProps {
  value: string; // stringified bigint
  onChange: (permissions: string) => void;
}

type PermissionKey = keyof typeof Permissions;

// Human-readable metadata keyed by the canonical permission name. The bit
// masks themselves are derived from the `Permissions` map below so this table
// can never drift out of sync with the wire encoding.
const PERMISSION_META: Record<PermissionKey, { name: string; description: string }> = {
  CREATE_INSTANT_INVITE: { name: 'Create Instant Invite', description: 'Create invites to the server' },
  KICK_MEMBERS: { name: 'Kick Members', description: 'Remove members from the server' },
  BAN_MEMBERS: { name: 'Ban Members', description: 'Permanently ban members' },
  ADMINISTRATOR: { name: 'Administrator', description: 'Full access to all permissions' },
  MANAGE_CHANNELS: { name: 'Manage Channels', description: 'Create, edit, and delete channels' },
  MANAGE_GUILD: { name: 'Manage Guild', description: 'Edit server name, icon, and settings' },
  ADD_REACTIONS: { name: 'Add Reactions', description: 'Add new reactions to messages' },
  VIEW_AUDIT_LOG: { name: 'View Audit Log', description: 'View the server audit log' },
  PRIORITY_SPEAKER: { name: 'Priority Speaker', description: 'Priority in voice channels' },
  STREAM: { name: 'Stream', description: 'Share screen in voice channels' },
  VIEW_CHANNEL: { name: 'View Channel', description: 'View text and voice channels' },
  SEND_MESSAGES: { name: 'Send Messages', description: 'Send messages in text channels' },
  SEND_TTS_MESSAGES: { name: 'Send TTS Messages', description: 'Send text-to-speech messages' },
  MANAGE_MESSAGES: { name: 'Manage Messages', description: 'Delete or pin messages by others' },
  EMBED_LINKS: { name: 'Embed Links', description: 'Links auto-embed previews' },
  ATTACH_FILES: { name: 'Attach Files', description: 'Upload files and images' },
  READ_MESSAGE_HISTORY: { name: 'Read Message History', description: 'View past messages in channels' },
  MENTION_EVERYONE: { name: 'Mention Everyone', description: 'Use @everyone and @here' },
  USE_EXTERNAL_EMOJIS: { name: 'Use External Emojis', description: 'Use emojis from other servers' },
  CONNECT: { name: 'Connect', description: 'Connect to voice channels' },
  SPEAK: { name: 'Speak', description: 'Speak in voice channels' },
  MUTE_MEMBERS: { name: 'Mute Members', description: 'Mute others in voice channels' },
  DEAFEN_MEMBERS: { name: 'Deafen Members', description: 'Deafen others in voice channels' },
  MOVE_MEMBERS: { name: 'Move Members', description: 'Move members between voice channels' },
  USE_VAD: { name: 'Use VAD', description: 'Use voice activity detection' },
  CHANGE_NICKNAME: { name: 'Change Nickname', description: 'Change own nickname' },
  MANAGE_NICKNAMES: { name: 'Manage Nicknames', description: "Change other members' nicknames" },
  MANAGE_ROLES: { name: 'Manage Roles', description: 'Create, edit, and delete roles' },
  MANAGE_WEBHOOKS: { name: 'Manage Webhooks', description: 'Create, edit, and delete webhooks' },
  MANAGE_EMOJIS: { name: 'Manage Emojis', description: 'Create, edit, and delete emojis' },
};

const PERMISSION_FLAGS = (Object.keys(Permissions) as PermissionKey[]).map((key) => ({
  key,
  mask: Permissions[key],
  ...PERMISSION_META[key],
}));

const ADMIN = Permissions.ADMINISTRATOR;

export function PermissionCalculator({ value, onChange }: PermissionCalculatorProps) {
  const current = (() => {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  })();

  const isAdmin = (current & ADMIN) !== 0n;

  const toggle = (mask: bigint) => {
    let next = current ^ mask;
    // Administrator subsumes every other permission, so once it is enabled the
    // remaining rows are non-contributing and excluded from the emitted value.
    if ((next & ADMIN) !== 0n) next = ADMIN;
    onChange(next.toString());
  };

  const isChecked = (mask: bigint) => (current & mask) !== 0n;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PERMISSION_FLAGS.map((perm) => {
          const isAdminRow = perm.mask === ADMIN;
          const disabled = isAdmin && !isAdminRow;
          return (
            <label
              key={perm.key}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                isAdminRow
                  ? 'border-accent-danger/40 bg-accent-danger/5 hover:bg-accent-danger/10'
                  : 'border-border-subtle bg-bg-primary/40 hover:bg-bg-mod-subtle',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                checked={isChecked(perm.mask)}
                onChange={() => toggle(perm.mask)}
                disabled={disabled}
                className="mt-0.5 accent-accent-primary disabled:cursor-not-allowed"
              />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-semibold text-text-primary">{perm.name}</span>
                <p className="mt-0.5 text-[11px] text-text-muted">{perm.description}</p>
              </div>
            </label>
          );
        })}
      </div>
      <div className="rounded-lg border border-border-subtle bg-bg-primary/40 px-3 py-2">
        <span className="text-xs text-text-muted">Permission value: </span>
        <code className="text-xs font-semibold text-text-secondary">{current.toString()}</code>
      </div>
    </div>
  );
}
