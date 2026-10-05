import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore } from 'zustand/vanilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClipsForTests, useClipStore, type SavedClip } from '../../../lib/media/clips/clipStore';
import { ClipToast } from './ClipToast';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => undefined),
  upload: vi.fn(async () => ({ id: '555' })),
  attach: { supported: true, allowed: true, reason: null as string | null },
  encrypted: false,
}));

vi.mock('../../../api/files', () => ({ fileApi: { upload: mocks.upload } }));
vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentAccountScope: () => ({ serverId: 's1', userId: 'me' }) }));
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStoreApi: () => ({ getState: () => ({ sendMessage: mocks.sendMessage }) }),
}));
vi.mock('../../../hooks/useConversationActions', () => ({
  useConversationActions: () => ({ actions: { attach: mocks.attach }, encrypted: mocks.encrypted }),
}));
vi.mock('../../../lib/messages/accountMessagingRuntime', () => ({
  getAccountMessagingRuntime: () => ({ store: runtimeStore }),
}));
vi.mock('../../../lib/messages/messagingReadiness', () => ({
  isGroupDm: () => false,
  runtimeAttachDecision: (server: { allowed: boolean; reason: string | null }) => server,
}));
vi.mock('../../../lib/channelView', () => {
  const view = { channelsById: { general: { id: 'general', name: 'General', type: 0 } } };
  return { getAccountChannelView: () => view };
});
vi.mock('../../../stores/instanceStore', () => {
  const state = { getActiveMaxUploadSize: () => 50 * 1024 * 1024, fetchInstanceInfo: async () => undefined };
  return { useInstanceStore: (select: (value: typeof state) => unknown) => select(state) };
});
vi.mock('../../../lib/media/viewFrameSource', () => ({ createViewFrameSource: () => ({ getLatestFrame: async () => null }) }));

const runtimeStore = createStore(() => ({}));
const TARGET = { serverId: 's1', guildId: 'g1', channelId: 'lounge', streamerId: '7', streamerName: 'Vincent' };

function saved(over: Partial<SavedClip> = {}): SavedClip {
  return {
    id: 1,
    file: new File([new Uint8Array(1_000)], "Clip 0m30s from Vincent's screen.webm", { type: 'video/webm' }),
    url: 'blob:clip',
    thumbnailUrl: 'blob:thumb',
    durationMs: 31_200,
    sourceName: "Vincent's screen",
    savedAt: new Date(2026, 8, 30, 21, 14).getTime(),
    ...over,
  };
}

function renderToast(path = '/app/guilds/g1/channels/general') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ClipToast target={TARGET} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetClipsForTests();
  mocks.sendMessage.mockClear();
  mocks.upload.mockClear();
  mocks.attach = { supported: true, allowed: true, reason: null };
  mocks.encrypted = false;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => resetClipsForTests());

describe('ClipToast', () => {
  it('shows nothing until a clip is saved', () => {
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the thumbnail, "Saved the last 30 seconds", source and time, Post to General and dismiss', () => {
    renderToast();
    act(() => useClipStore.setState({ saved: saved() }));
    const toast = screen.getByRole('status', { name: 'Clip saved' });
    expect(toast).toHaveTextContent('Saved the last 30 seconds');
    expect(toast).toHaveTextContent(/From Vincent's screen, 9:14\s?PM/i);
    expect(toast.querySelector('img')).toHaveAttribute('src', 'blob:thumb');
    expect(screen.getByRole('button', { name: 'Post to General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('posts into the conversation beside the stage and says so', async () => {
    renderToast();
    act(() => useClipStore.setState({ saved: saved() }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Post to General' }));
    });
    expect(mocks.upload).toHaveBeenCalledWith('general', expect.any(File), expect.any(Function));
    expect(mocks.sendMessage).toHaveBeenCalledWith('general', '', undefined, ['555']);
    expect(screen.getByRole('status')).toHaveTextContent('Posted to General');
    expect(screen.getByRole('status')).toHaveTextContent('Your clip is in the conversation');
    expect(screen.queryByRole('button', { name: 'Post to General' })).toBeNull();
  });

  it('shows a clip too large for the channel with its size and the limit, and offers to save it instead', async () => {
    renderToast();
    const big = new File([new Uint8Array(10)], 'Clip 0m30s from x.webm', { type: 'video/webm' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    act(() => useClipStore.setState({ saved: saved({ file: big }) }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Post to General' }));
    });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('This clip is 60.0 MB and General takes files up to 50.0 MB, so it was not posted.');
    expect(screen.getByRole('button', { name: 'Save to device' })).toBeInTheDocument();
  });

  it('offers to save to the device when no conversation is beside the stage', () => {
    renderToast('/app');
    act(() => useClipStore.setState({ saved: saved() }));
    expect(screen.queryByRole('button', { name: /^Post to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save to device' })).toBeInTheDocument();
  });

  it('says why when posting files is not allowed there', async () => {
    mocks.attach = { supported: true, allowed: false, reason: 'You cannot attach files in General.' };
    renderToast();
    act(() => useClipStore.setState({ saved: saved() }));
    const post = screen.getByRole('button', { name: 'Post to General' });
    expect(post).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      fireEvent.click(post);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('You cannot attach files in General.');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('dismiss closes it and frees the clip', () => {
    const { container } = renderToast();
    act(() => useClipStore.setState({ saved: saved() }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container).toBeEmptyDOMElement();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip');
  });
});
