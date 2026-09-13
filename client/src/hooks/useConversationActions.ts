import { useCallback, useEffect, useState } from 'react';
import { useCurrentAccountScope, useCurrentUser } from './useCurrentUser';
import { useAccountStore } from '../stores/accountStore';
import { captureScopedOperation } from '../lib/operationContext';
import { entityScopeKey } from '../lib/serverScope';
import { isTauri } from '../lib/tauriEnv';
import { readConversationCapabilities, resolveConversationActions, type ConversationCapabilities, type EncryptionReadiness } from '../lib/conversationActions';

export function useConversationActions(channelId?: string | null) {
  const scope = useCurrentAccountScope();
  const user = useCurrentUser();
  const unlocked = useAccountStore(s => s.isUnlocked);
  const publicKey = useAccountStore(s => s.publicKey);
  const key = scope && channelId ? entityScopeKey(scope, channelId) : null;
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const [snapshot, setSnapshot] = useState<{ key: string; caps: ConversationCapabilities | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!scope || !channelId || !key) return;
    let live = true;
    let context: ReturnType<typeof captureScopedOperation>;
    try { context = captureScopedOperation(scope); }
    catch { setSnapshot({ key, caps: null, error: 'Sign in to this server to check conversation actions.' }); return; }
    setSnapshot({ key, caps: null, error: null });
    const revoked = () => { if (live) setSnapshot({ key, caps: null, error: 'Sign in to this server to check conversation actions.' }); };
    context.signal.addEventListener('abort', revoked, { once: true });
    void context.request({ method: 'GET', url: `/channels/${encodeURIComponent(channelId)}/capabilities`, timeout: 15_000 })
      .then(response => {
        context.assertCurrent();
        if (context.signal.aborted) return;
        const caps = readConversationCapabilities(response.data, channelId, scope.userId);
        if (live) setSnapshot({ key, caps, error: null });
      }).catch(() => { if (live && !context.signal.aborted) setSnapshot({ key, caps: null, error: 'Conversation actions could not be checked. Retry when the server is available.' }); });
    return () => { live = false; context.signal.removeEventListener('abort', revoked); context.dispose(); };
  }, [scope, channelId, key, revision]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('paracord:roles-changed', refresh);
    window.addEventListener('paracord:conversation-capabilities-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
      window.removeEventListener('paracord:roles-changed', refresh); window.removeEventListener('paracord:conversation-capabilities-changed', refresh);
    };
  }, [refresh]);
  const current = snapshot?.key === key ? snapshot : null;
  const native = isTauri();
  const encryption: EncryptionReadiness = !user?.public_key ? 'setup'
    : publicKey?.toLowerCase() !== user.public_key.toLowerCase() ? 'identity_mismatch' : unlocked ? 'ready' : 'unlock';
  const actions = resolveConversationActions(current?.caps ?? null, {
    secureContext: native || window.isSecureContext,
    files: typeof File !== 'undefined' && typeof FormData !== 'undefined',
    microphone: native || Boolean(navigator.mediaDevices?.getUserMedia),
    screenShare: native || Boolean(navigator.mediaDevices?.getDisplayMedia),
  }, encryption, undefined, !key ? 'Select an authenticated conversation.' : current?.error ?? undefined);
  return { actions, refresh, encryption, encrypted: current?.caps?.encrypted === true, error: current?.error ?? null, loading: Boolean(key && !current?.caps && !current?.error) };
}
