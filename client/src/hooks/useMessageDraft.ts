import { useCallback, type SetStateAction } from 'react';
import { useStore } from 'zustand';
import type { AccountScope } from '../lib/serverScope';
import { getAccountMessagingRuntime } from '../lib/messages/accountMessagingRuntime';

/** The account runtime retains pending writes across composer navigation. */
export function useMessageDraft(scope: AccountScope, channelId: string) {
  const runtime = getAccountMessagingRuntime(scope);
  useStore(runtime.store, state => state.draftGeneration);
  const controller = runtime.draftController(channelId);
  const state = useStore(controller.store);
  return {
    content: state.draft.content, error: state.error, status: state.status, runtime,
    setContent: useCallback((value: SetStateAction<string>) => controller.setContent(typeof value === 'function' ? value(controller.store.getState().draft.content) : value), [controller]),
    retrySave: useCallback(() => controller.retrySave(), [controller]),
    capture: useCallback(() => controller.capture(), [controller]),
    clearSubmitted: useCallback((draft: Awaited<ReturnType<typeof controller.capture>>) => controller.clearSubmitted(draft), [controller]),
  };
}
