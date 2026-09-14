import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentAccountScope, useCurrentUser } from './useCurrentUser';
import { useAccountStore } from '../stores/accountStore';
import { captureScopedOperation } from '../lib/operationContext';
import { entityScopeKey } from '../lib/serverScope';
import { isTauri } from '../lib/tauriEnv';
import { readConversationCapabilities, resolveConversationActions, type ConversationCapabilities, type EncryptionReadiness } from '../lib/conversationActions';

/**
 * How long to wait before asking again after a probe that never got an answer.
 *
 * The failure this exists for is a race, not a refusal: a capability GET that
 * left before a token refresh and landed after it answers 401 once and is fine
 * a second later. Nothing here used to retry, so one lost race left the room's
 * composer disabled — under a permanent "Checking conversation actions…"
 * banner — until the window happened to regain focus. The tail keeps a
 * genuinely unreachable instance down to two asks a minute.
 */
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

const PROBE_FAILED = 'Conversation actions could not be checked. Retry when the server is available.';
const NOT_SIGNED_IN = 'Sign in to this instance to check conversation actions.';

/**
 * Why we have no answer.
 *
 * - `unreachable`: nothing came back — a transport error, a 401 inside a token
 *   refresh window, a restarting instance. Transient by nature: ask again, and
 *   do not hold the composer over it.
 * - `contract`: the instance *did* answer and the answer was not about this
 *   conversation, or not a shape we accept. That is not a race and asking again
 *   will not change it; refuse, and leave the way out to the Retry button.
 */
type ProbeFailure = 'unreachable' | 'contract';

interface CapabilitySnapshot {
  key: string;
  caps: ConversationCapabilities | null;
  error: string | null;
  failure: ProbeFailure | null;
}

export function useConversationActions(channelId?: string | null) {
  const scope = useCurrentAccountScope();
  const user = useCurrentUser();
  const unlocked = useAccountStore(s => s.isUnlocked);
  const publicKey = useAccountStore(s => s.publicKey);
  const key = scope && channelId ? entityScopeKey(scope, channelId) : null;
  // A re-check confirms what we were told; an invalidation says the answer
  // itself may have changed. Only the second may keep showing the old one is
  // wrong, so only the second drops it while the new answer is in the air.
  const [request, setRequest] = useState({ revision: 0, invalidate: false });
  const refresh = useCallback(() => setRequest(prev => ({ revision: prev.revision + 1, invalidate: false })), []);
  const invalidate = useCallback(() => setRequest(prev => ({ revision: prev.revision + 1, invalidate: true })), []);
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  // Survives the effect's re-runs, so a re-check of the SAME conversation keeps
  // answering from the last thing the instance actually said. Clearing it on
  // every pass was half the defect: a capabilities event landing in a token
  // refresh wiped a good answer and then failed to replace it.
  const lastGood = useRef<{ key: string; caps: ConversationCapabilities } | null>(null);
  const { revision, invalidate: dropCached } = request;
  useEffect(() => {
    if (!scope || !channelId || !key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let context: ReturnType<typeof captureScopedOperation>;
    try { context = captureScopedOperation(scope); }
    catch { setSnapshot({ key, caps: null, error: NOT_SIGNED_IN, failure: null }); return; }
    if (dropCached) lastGood.current = null;
    const cached = () => (lastGood.current?.key === key ? lastGood.current.caps : null);
    setSnapshot({ key, caps: cached(), error: null, failure: null });
    // A revoked operation context is not always a sign-out: a per-server entry
    // whose token is momentarily absent mid-refresh revokes every operation
    // captured against it. Say what is true now, and ask again — otherwise one
    // refresh leaves the composer reading "sign in" for a session that never
    // went anywhere.
    const revoked = () => {
      if (!live) return;
      setSnapshot({ key, caps: null, error: NOT_SIGNED_IN, failure: null });
      if (timer) clearTimeout(timer);
      const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => { timer = null; if (live) refresh(); }, wait);
    };
    context.signal.addEventListener('abort', revoked, { once: true });
    const probe = () => {
      void context.request({ method: 'GET', url: `/channels/${encodeURIComponent(channelId)}/capabilities`, timeout: 15_000 })
        .then(response => {
          context.assertCurrent();
          if (context.signal.aborted) return;
          let caps: ConversationCapabilities;
          try { caps = readConversationCapabilities(response.data, channelId, scope.userId); }
          catch {
            // The instance answered, about something else. Refuse and stop.
            lastGood.current = null;
            if (live) setSnapshot({ key, caps: null, error: PROBE_FAILED, failure: 'contract' });
            return;
          }
          lastGood.current = { key, caps };
          if (live) setSnapshot({ key, caps, error: null, failure: null });
        }).catch(() => {
          if (!live || context.signal.aborted) return;
          // Keep whatever the instance last said: a check that never arrived is
          // not a withdrawal of a permission it already granted.
          setSnapshot({ key, caps: cached(), error: PROBE_FAILED, failure: 'unreachable' });
          const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
          attempt += 1;
          timer = setTimeout(() => { timer = null; if (live && !context.signal.aborted) probe(); }, wait);
        });
    };
    probe();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', revoked);
      context.dispose();
    };
  }, [scope, channelId, key, revision, dropCached, refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('paracord:roles-changed', invalidate);
    window.addEventListener('paracord:conversation-capabilities-changed', invalidate);
    return () => {
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
      window.removeEventListener('paracord:roles-changed', invalidate); window.removeEventListener('paracord:conversation-capabilities-changed', invalidate);
    };
  }, [refresh, invalidate]);
  const current = snapshot?.key === key ? snapshot : null;
  const native = isTauri();
  const encryption: EncryptionReadiness = !user?.public_key ? 'setup'
    : publicKey?.toLowerCase() !== user.public_key.toLowerCase() ? 'identity_mismatch' : unlocked ? 'ready' : 'unlock';
  // A probe that never got an answer leaves the room usable. "We have not asked
  // yet", "this instance has no session here" and "the instance answered about
  // someone else" all still hold the composer.
  const unresolved = current?.failure === 'unreachable' ? 'permissive' : 'blocked';
  const actions = resolveConversationActions(current?.caps ?? null, {
    secureContext: native || window.isSecureContext,
    files: typeof File !== 'undefined' && typeof FormData !== 'undefined',
    microphone: native || Boolean(navigator.mediaDevices?.getUserMedia),
    screenShare: native || Boolean(navigator.mediaDevices?.getDisplayMedia),
  }, encryption, undefined, !key ? 'Select an authenticated conversation.' : current?.error ?? undefined, unresolved);
  return { actions, refresh, encryption, encrypted: current?.caps?.encrypted === true, error: current?.error ?? null, loading: Boolean(key && !current?.caps && !current?.error) };
}
