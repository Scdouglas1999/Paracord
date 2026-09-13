import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageDraft } from './useMessageDraft';

const fixture = vi.hoisted(() => ({ runtimes: new Map<string, unknown>(), fail: false }));
vi.mock('../lib/messages/accountMessagingRuntime', async () => {
  const { createStore } = await import('zustand/vanilla');
  const { EncryptedDraftController } = await import('../lib/messages/encryptedDraftController');
  return { getAccountMessagingRuntime(scope: { serverId: string; userId: string }) {
    const key = JSON.stringify(scope); let runtime = fixture.runtimes.get(key);
    if (!runtime) {
      const saved = new Map<string, { revision: string; content: string }>();
      const controllers = new Map<string, InstanceType<typeof EncryptedDraftController>>();
      runtime = { store: createStore(() => ({ draftGeneration: 0 })), draftController(channel: string) {
        let controller = controllers.get(channel);
        if (!controller) {
          controller = new EncryptedDraftController({ read: async () => saved.get(channel) ?? null,
            write: async (draft, expectedRevision) => {
              if (fixture.fail) throw new Error('Quota exceeded');
              if ((saved.get(channel)?.revision ?? null) !== expectedRevision) throw new Error('Draft changed');
              saved.set(channel, draft);
            }, clear: async revision => { if (saved.get(channel)?.revision === revision) saved.delete(channel); } });
          controllers.set(channel, controller);
        }
        return controller;
      } }; fixture.runtimes.set(key, runtime);
    }
    return runtime;
  } };
});

const a = { serverId: 'a', userId: 'same' };
const b = { serverId: 'b', userId: 'same' };
beforeEach(() => { localStorage.clear(); fixture.runtimes.clear(); fixture.fail = false; });
afterEach(() => vi.restoreAllMocks());

it('preserves the latest keystroke on immediate unmount and reload', async () => {
  const first = renderHook(() => useMessageDraft(a, 'channel'));
  act(() => first.result.current.setContent('  latest text\n'));
  first.unmount();
  const next = renderHook(() => useMessageDraft(a, 'channel'));
  expect(next.result.current.content).toBe('  latest text\n');
});

it('isolates colliding channel IDs across both servers and accounts', async () => {
  const first = renderHook(() => useMessageDraft(a, 'channel'));
  act(() => first.result.current.setContent('private to A'));
  const second = renderHook(() => useMessageDraft(b, 'channel'));
  const third = renderHook(() => useMessageDraft({ ...a, userId: 'next' }, 'channel'));
  expect(second.result.current.content).toBe('');
  expect(third.result.current.content).toBe('');
});

it('retains unowned legacy drafts without displaying or assigning them', async () => {
  localStorage.setItem('paracord:v2:draft:channel', 'unknown owner');
  localStorage.setItem('paracord:draft:channel', 'older unknown owner');
  const view = renderHook(() => useMessageDraft(a, 'channel'));
  expect(view.result.current.content).toBe('');
  act(() => view.result.current.setContent('owned draft'));
  expect(localStorage.getItem('paracord:v2:draft:channel')).toBe('unknown owner');
  expect(localStorage.getItem('paracord:draft:channel')).toBe('older unknown owner');
});

it('retains a newer draft when an earlier send succeeds', async () => {
  const view = renderHook(() => useMessageDraft(a, 'channel'));
  act(() => view.result.current.setContent('first'));
  const submitted = await act(() => view.result.current.capture());
  act(() => view.result.current.setContent('second'));
  await act(() => view.result.current.clearSubmitted(submitted));
  expect(view.result.current.content).toBe('second');
  expect(renderHook(() => useMessageDraft(a, 'channel')).result.current.content).toBe('second');
});

it('does not erase a replacement composer draft when an unmounted send resolves', async () => {
  const first = renderHook(() => useMessageDraft(a, 'channel'));
  act(() => first.result.current.setContent('submitted'));
  const submitted = await act(() => first.result.current.capture());
  const complete = first.result.current.clearSubmitted;
  first.unmount();
  const replacement = renderHook(() => useMessageDraft(a, 'channel'));
  act(() => replacement.result.current.setContent('new draft'));
  await act(() => complete(submitted));
  expect(replacement.result.current.content).toBe('new draft');
  expect(renderHook(() => useMessageDraft(a, 'channel')).result.current.content).toBe('new draft');
});

it('clears only an acknowledged unchanged draft from the owning account', async () => {
  const first = renderHook(() => useMessageDraft(a, 'channel'));
  const second = renderHook(() => useMessageDraft(b, 'channel'));
  act(() => first.result.current.setContent('A'));
  act(() => second.result.current.setContent('B'));
  await act(async () => first.result.current.clearSubmitted(await first.result.current.capture()));
  expect(first.result.current.content).toBe('');
  expect(renderHook(() => useMessageDraft(a, 'channel')).result.current.content).toBe('');
  expect(renderHook(() => useMessageDraft(b, 'channel')).result.current.content).toBe('B');
});

it('reports a quota failure, retains editable text, and retries the latest revision', async () => {
  const view = renderHook(() => useMessageDraft(a, 'channel'));
  fixture.fail = true;
  act(() => view.result.current.setContent('must survive'));
  expect(view.result.current.content).toBe('must survive');
  await act(async () => { await expect(view.result.current.capture()).rejects.toThrow('Quota exceeded'); });
  expect(view.result.current.error).toContain('Draft not saved');
  fixture.fail = false;
  await act(() => view.result.current.retrySave());
  expect(view.result.current.error).toBeNull();
  expect(renderHook(() => useMessageDraft(a, 'channel')).result.current.content).toBe('must survive');
});
