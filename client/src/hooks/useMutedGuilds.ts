import { useCallback, useEffect, useMemo } from 'react';
import { useAvailableAccountScopes } from './useAvailableAccountScopes';
import { useNotificationPreferenceStore } from '../stores/notificationPreferenceStore';
import { accountScopeKey, entityScopeKey } from '../lib/serverScope';
import type { GuildReference } from '../lib/guildScope';
import { toast } from '../stores/toastStore';
import { extractApiError } from '../api/client';

/** Every mute key retains the account that owns the server-side preference. */
export function useMutedGuilds() {
  const scopes = useAvailableAccountScopes();
  const scopeKey = JSON.stringify(scopes);
  const byAccount = useNotificationPreferenceStore(state => state.byAccount);
  const saving = useNotificationPreferenceStore(state => state.saving);
  useEffect(() => {
    const accounts = JSON.parse(scopeKey) as typeof scopes;
    const refresh = () => { for (const scope of accounts) void useNotificationPreferenceStore.getState().refresh(scope).catch(() => { /* The account error is retained for retry. */ }); };
    refresh();
    window.addEventListener('focus', refresh);
    const storage = (event: StorageEvent) => { if (event.key === 'paracord:notification-preferences-by-account') refresh(); };
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); };
  }, [scopeKey]);
  useEffect(() => {
    const accounts = JSON.parse(scopeKey) as typeof scopes;
    const deadlines = accounts.flatMap(scope => Object.values(byAccount[accountScopeKey(scope)] ?? {}))
      .filter(setting => setting.muted_now && setting.muted_until)
      .map(setting => Date.parse(setting.muted_until!)).filter(Number.isFinite);
    if (!deadlines.length) return;
    // Recheck server truth at expiry. A clock ahead of the server retries at most
    // twice a minute; long mutes avoid the browser's 32-bit timer overflow.
    const remaining = Math.min(...deadlines) - Date.now();
    const delay = Math.min(86_400_000, remaining > 0 ? remaining : 30_000);
    const timer = setTimeout(() => { for (const scope of accounts) void useNotificationPreferenceStore.getState().refresh(scope).catch(() => {}); }, delay);
    return () => clearTimeout(timer);
  }, [scopeKey, byAccount]);
  const mutedGuildKeys = useMemo(() => {
    const keys: string[] = [];
    for (const scope of scopes) for (const setting of Object.values(byAccount[accountScopeKey(scope)] ?? {})) {
      if (setting.muted_now) keys.push(entityScopeKey(scope, setting.space_id));
    }
    return keys;
  }, [scopes, byAccount]);
  const isMuted = useCallback((guild: GuildReference) => mutedGuildKeys.includes(entityScopeKey(guild.scope, guild.id)), [mutedGuildKeys]);
  const toggleMute = useCallback(async (guild: GuildReference) => {
    try { await useNotificationPreferenceStore.getState().setMuted(guild, !isMuted(guild)); }
    catch (err) { toast.error(`Failed to update building notifications: ${extractApiError(err)}`); }
  }, [isMuted]);
  return { mutedGuildKeys, isMuted, toggleMute, saving };
}
