import { X } from 'lucide-react';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { useMatch } from 'react-router';

import { useConversationActions } from '../../../hooks/useConversationActions';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useCurrentMessageStoreApi } from '../../../hooks/useMessageStore';
import { getAccountChannelView } from '../../../lib/channelView';
import { displayName } from '../../../lib/displayName';
import { getAccountMessagingRuntime } from '../../../lib/messages/accountMessagingRuntime';
import { isGroupDm, runtimeAttachDecision } from '../../../lib/messages/messagingReadiness';
import type { AccountScope } from '../../../lib/serverScope';
import {
  dismissClip,
  downloadSavedClip,
  postSavedClip,
  savedSubtitle,
  savedTitle,
  useClipStore,
  type ClipDestination,
} from '../../../lib/media/clips/clipStore';
import { useClip, type ClipTarget } from '../../../lib/media/clips/useClip';
import { useChannelStore } from '../../../stores/channelStore';
import { useInstanceStore } from '../../../stores/instanceStore';
import '../../../lib/media/clips/clips.css';

/**
 * The clip toast (docs/glass-spec.md §6.4, `screens/04`): centered at the top
 * of the stream, 488px, a still of the stream, "Saved the last 30 seconds",
 * "From Vincent's screen, 9:14 PM", **Post to General** (text) and dismiss.
 *
 * It is chrome over the video inside the stream box (the stage mounts it
 * there), solid so it reads over a native video surface without blur. "Post
 * to …" posts into the conversation beside the stage: the route's channel.
 * With no conversation beside the stage, or when posting is refused (too large
 * for the channel, not allowed to attach files there), the clip can still be
 * saved to this device. It is never shortened to fit.
 */
export interface ClipToastProps {
  target: ClipTarget;
}

export function ClipToast({ target }: ClipToastProps) {
  // The toast is always on the stage: it keeps the ring armed for the watch and
  // the target registered for the C key even where the controls row is not
  // drawn (the phone stage).
  useClip(target);

  const saved = useClipStore((state) => state.saved);
  if (!saved) return null;
  return <SavedClipToast />;
}

function SavedClipToast() {
  const saved = useClipStore((state) => state.saved)!;
  const postPhase = useClipStore((state) => state.postPhase);
  const postProgress = useClipStore((state) => state.postProgress);
  const postError = useClipStore((state) => state.postError);
  const tooLarge = useClipStore((state) => state.tooLarge);
  const postedTo = useClipStore((state) => state.postedTo);

  const guildRoute = useMatch('/app/guilds/:guildId/channels/:channelId');
  const dmRoute = useMatch('/app/dms/:channelId');
  const channelId = guildRoute?.params.channelId ?? dmRoute?.params.channelId ?? null;
  const scope = useCurrentAccountScope();

  const posted = postPhase === 'posted';
  const posting = postPhase === 'posting';
  const title = posted ? `Posted to ${postedTo ?? 'the conversation'}` : savedTitle(saved.durationMs);
  const subtitle = posted
    ? 'Your clip is in the conversation'
    : posting
      ? postProgress !== null && postProgress < 100
        ? `Posting… ${postProgress}%`
        : 'Posting…'
      : savedSubtitle(saved);

  return (
    <div className="glass-clip-toast" role="status" aria-live="polite" aria-label="Clip saved">
      <span className="glass-clip-toast__thumb" aria-hidden="true">
        {saved.thumbnailUrl && <img src={saved.thumbnailUrl} alt="" />}
      </span>
      <span className="glass-clip-toast__text">
        <span className="glass-clip-toast__title">{title}</span>
        {postError ? (
          <span className="glass-clip-toast__error" role="alert">
            {postError}
          </span>
        ) : (
          <span className="glass-clip-toast__sub">{subtitle}</span>
        )}
      </span>
      {!posted && scope && channelId && !tooLarge && (
        <PostButton scope={scope} channelId={channelId} busy={posting} />
      )}
      {!posted && (tooLarge || !channelId) && (
        <button type="button" className="glass-clip-toast__action glass-focusable" onClick={downloadSavedClip}>
          Save to device
        </button>
      )}
      <button
        type="button"
        className="glass-clip-toast__dismiss glass-focusable"
        aria-label="Dismiss"
        disabled={posting}
        onClick={dismissClip}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** "Post to General": where the clip goes, whether it may, and the upload limit there. */
function PostButton({ scope, channelId, busy }: { scope: AccountScope; channelId: string; busy: boolean }) {
  const messageStore = useCurrentMessageStoreApi();
  const { actions, encrypted } = useConversationActions(channelId);
  const runtimeState = useStore(getAccountMessagingRuntime(scope).store);
  const channel = useChannelStore((state) => getAccountChannelView(scope, state).channelsById[channelId]);
  const maxUploadSize = useInstanceStore((state) => state.getActiveMaxUploadSize());
  const fetchInstanceInfo = useInstanceStore((state) => state.fetchInstanceInfo);
  useEffect(() => {
    void fetchInstanceInfo();
  }, [fetchInstanceInfo]);

  const channelType = channel?.channel_type ?? channel?.type;
  const group = isGroupDm(channelType) ? channel?.recipients : undefined;
  const attach = runtimeAttachDecision(actions.attach, runtimeState, encrypted, channelId, channelType, group);
  const label = channel?.name?.trim() || (channel?.recipients?.[0] ? displayName(channel.recipients[0]) : 'this conversation');

  const post = () => {
    const destination: ClipDestination = {
      channelId,
      label,
      encrypted,
      maxBytes: maxUploadSize ?? null,
      allowed: attach.allowed,
      reason: attach.reason,
      sendMessage: messageStore.getState().sendMessage,
    };
    void postSavedClip(destination);
  };

  return (
    <button
      type="button"
      className="glass-clip-toast__action glass-focusable"
      onClick={post}
      disabled={busy}
      aria-disabled={!attach.allowed || undefined}
      title={attach.allowed ? undefined : attach.reason ?? undefined}
    >
      Post to {label}
    </button>
  );
}
