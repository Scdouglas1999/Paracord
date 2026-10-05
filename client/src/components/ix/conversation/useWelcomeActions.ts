import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { getAccountMessagingRuntime } from '../../../lib/messages/accountMessagingRuntime';
import { useGlassStore } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { openInvite } from '../menus';
import { copyEndlessInvite } from './invite';
import { greetingFor, type WelcomeAction } from './welcomeModel';
import type { ConversationSubject } from './types';
import { markWelcomed } from './joinerWelcome';

/** §5.16: the invite card says "Link copied" for two seconds. */
export const COPIED_MS = 2000;

export interface WelcomeActionsInput {
  subject: ConversationSubject;
  serverName?: string;
  joiner: boolean;
  /** The conversation's root: the message box Say hello fills is inside it. */
  root: RefObject<HTMLElement | null>;
  /** Plan a night: the caller morphs the card into a draft. */
  onPlan: (card: HTMLElement) => void;
  /** Pick roles: the caller brings the onboarding page back. */
  onPickRoles?: () => void;
}

export interface WelcomeActions {
  pick: (action: WelcomeAction, card: HTMLElement) => void;
  /** The action whose card says it worked (the invite: "Link copied"). */
  copied: WelcomeAction | null;
  /** The action that is working. */
  busy: WelcomeAction | null;
}

/**
 * What each action card does (docs/index-spec.md §4.13).
 *
 *   Bring your people  make (or find) an endless invite and copy its link; the card
 *                      says "Link copied" for 2s. A second press opens the invite
 *                      dialog, where the link, its options and Copy are.
 *   Say hello          put a short greeting in the message box, select it, and put
 *                      the cursor there. It never sends (§13.4), and it never
 *                      replaces words already typed.
 *   See who's here     the people sheet.
 *   Pick roles         the onboarding page, again.
 *   Plan a night       the caller's morph (`onPlan`).
 */
export function useWelcomeActions({ subject, serverName, joiner, root, onPlan, onPickRoles }: WelcomeActionsInput): WelcomeActions {
  const scope = useCurrentAccountScope();
  const userId = useCurrentUser()?.id ?? null;
  const [copied, setCopied] = useState<WelcomeAction | null>(null);
  const [busy, setBusy] = useState<WelcomeAction | null>(null);
  const invited = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const guildId = subject.kind === 'channel' ? subject.guildId : null;
  const channelId = subject.channelId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const welcomed = useCallback(() => {
    if (guildId) markWelcomed(guildId);
  }, [guildId]);

  const invite = useCallback(async () => {
    if (!guildId) return;
    if (invited.current) {
      openInvite({ guildName: serverName ?? 'this server', channelId });
      return;
    }
    setBusy('invite');
    try {
      await copyEndlessInvite({ guildId, channelId, userId });
      invited.current = true;
      if (!mounted.current) return;
      setCopied('invite');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), COPIED_MS);
    } catch (failure) {
      // Loud, with the reason: a link that could not be made is never "copied".
      toast.error(`Could not copy an invite link: ${extractApiError(failure)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [guildId, channelId, serverName, userId]);

  const hello = useCallback(() => {
    const controller = scope ? getAccountMessagingRuntime(scope).draftController(channelId) : null;
    const typed = controller?.store.getState().draft.content.trim() ?? '';
    if (controller && !typed) controller.setContent(greetingFor(subject, { serverName, joiner }));
    // The words reach the textarea on the next render; then they are selected, so typing replaces them.
    const focus = () => {
      const input = root.current?.querySelector<HTMLTextAreaElement>('[data-composer-input]');
      if (!input) return;
      input.focus({ preventScroll: true });
      if (!typed) input.select();
    };
    requestAnimationFrame(() => requestAnimationFrame(focus));
  }, [scope, channelId, subject, serverName, joiner, root]);

  const pick = useCallback(
    (action: WelcomeAction, card: HTMLElement) => {
      if (action === 'plan') {
        onPlan(card);
        return;
      }
      if (action !== 'invite') welcomed();
      if (action === 'invite') void invite();
      else if (action === 'hello') hello();
      else if (action === 'people') useGlassStore.getState().openSheet('people');
      else if (action === 'roles') onPickRoles?.();
    },
    [onPlan, welcomed, invite, hello, onPickRoles],
  );

  return { pick, copied, busy };
}
