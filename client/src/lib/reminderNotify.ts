import { extractApiError } from '../api/client';
import type { ReminderItem } from '../api/reminders';
import { sendNotification } from './features/notifications';
import { appNavigate } from './appNavigate';
import { getAccountMessagingRuntime } from './messages/accountMessagingRuntime';
import { decodeEncryptedBody } from './messages/attachments/attachmentEnvelope';
import { entityScopeKey, type AccountScope } from './serverScope';
import { displayName } from './displayName';
import { messagePreviewText } from './markdown';
import { fetchGuildRoles } from './permissionDataCache';
import { useMemberStore } from '../stores/memberStore';
import { toast } from '../stores/toastStore';
import { useReminderStore } from '../stores/reminderStore';

const PREVIEW_CHARS = 200;

function isReminder(value: unknown): value is ReminderItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as ReminderItem;
  return typeof item.id === 'string'
    && typeof item.channel?.id === 'string'
    && typeof item.message?.id === 'string'
    && typeof item.remind_at === 'string';
}

function firstLine(text: string): string {
  return text.split('\n').map((row) => row.trim()).find(Boolean)?.slice(0, PREVIEW_CHARS) ?? '';
}

/** Where a reminder's message lives in the app. */
export function reminderPath(item: ReminderItem): string {
  const query = `?message=${encodeURIComponent(item.message.id)}`;
  return item.channel.guild_id
    ? `/app/guilds/${item.channel.guild_id}/channels/${item.channel.id}${query}`
    : `/app/dms/${item.channel.id}${query}`;
}

export function reminderAuthor(item: ReminderItem): string {
  return item.message.author?.display_name?.trim() || item.message.author?.username || 'Someone';
}

/**
 * The first line of a reminder's message. The server sends it for server
 * channels; a direct message is end-to-end encrypted, so its text is read on
 * this device through the same reader the conversation uses (which answers
 * from its local copy for a message already opened here).
 */
export async function reminderPreviewLine(scope: AccountScope | null, item: ReminderItem): Promise<string> {
  if (item.preview != null) return plainWords(scope, item, item.preview);
  const payload = item.message.e2ee;
  if (!payload) return '';
  if (!scope) throw new Error('This account is not ready to read encrypted messages.');
  const plaintext = await getAccountMessagingRuntime(scope).decrypt(
    item.channel.id,
    payload,
    item.message.id,
    item.message.author.id,
  );
  return plainWords(scope, item, firstLine(decodeEncryptedBody(plaintext).text));
}

/** Markup becomes words: a mention is a name, a role is its name, never an id. */
async function plainWords(scope: AccountScope | null, item: ReminderItem, line: string): Promise<string> {
  const guildId = item.channel.guild_id;
  const names = new Map<string, string>();
  if (scope) {
    names.set(scope.userId, 'you');
    if (guildId) {
      for (const member of useMemberStore.getState().members.get(entityScopeKey(scope, guildId)) ?? []) {
        if (member.user.id !== scope.userId) names.set(member.user.id, displayName(member.user, member.nick));
      }
    }
  }
  const roleNames = guildId && /<@&\d+>/.test(line)
    ? new Map((await fetchGuildRoles(guildId)).map((role) => [role.id, role.name]))
    : undefined;
  return messagePreviewText(line, names, roleNames);
}

/** REMINDER_FIRED: update the list, then say so in the app and on the desktop. */
export async function presentReminderFired(scope: AccountScope | null, payload: unknown): Promise<void> {
  if (!isReminder(payload)) {
    toast.error('A reminder arrived that this app could not read.');
    return;
  }
  useReminderStore.getState().applyFired(payload);
  const author = reminderAuthor(payload);
  let body: string;
  try {
    body = (await reminderPreviewLine(scope, payload)) || 'Open the message to see it.';
  } catch (err) {
    body = `The message could not be read here: ${extractApiError(err)}`;
  }
  toast.info(`Reminder · ${author}: ${body}`, 10_000, {
    label: 'Jump',
    onClick: () => {
      try {
        appNavigate(reminderPath(payload));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not open that message.');
      }
    },
  });
  await sendNotification(`Reminder from ${author}`, body);
}
