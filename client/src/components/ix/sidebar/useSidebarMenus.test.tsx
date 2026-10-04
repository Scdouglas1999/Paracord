import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useConfirmStore } from '../../../stores/confirmStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useUIStore } from '../../../stores/uiStore';
import type { SidebarRoom } from '../../glass/places/rows';
import { useSidebarMenus } from './useSidebarMenus';

const SCOPE = { serverId: LOCAL_SERVER_ID, userId: 'me' };
const mocks = vi.hoisted(() => ({
  manage: true,
  blocked: {} as Record<string, string>,
  joinCall: vi.fn(),
  toggleListen: vi.fn(),
  copyChannelLink: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: mocks.manage }),
}));
vi.mock('../../../hooks/useRoomMenu', () => ({
  useRoomMenu: () => (room: { channelId: string; name: string }) => [
    { label: 'Every message', selected: true, action: () => {} },
    { label: 'Mark channel as read', action: () => {} },
    { label: 'Copy link to channel', action: () => {} },
    { label: `for ${room.name}`, action: () => {} },
  ],
  copyChannelLink: mocks.copyChannelLink,
}));
vi.mock('../../glass/pill/pillActions', () => ({
  joinCall: mocks.joinCall,
  toggleListen: mocks.toggleListen,
  listenBlockKey: (target: { serverId: string; channelId: string }) => `${target.serverId}:${target.channelId}`,
  listenBlockReason: (blocked: Record<string, string>, target: { serverId: string; channelId: string }) => blocked[`${target.serverId}:${target.channelId}`] ?? null,
  useListenBlockStore: (selector: (state: { blocked: Record<string, string> }) => unknown) => selector({ blocked: mocks.blocked }),
}));
vi.mock('../../../stores/toastStore', () => ({ toast: mocks.toast }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

function render() {
  return renderHook(
    () => {
      const menus = useSidebarMenus({ guildId: 'g1', scope: SCOPE });
      return { menus, where: useLocation().pathname };
    },
    { wrapper },
  );
}

const room = (over: Partial<SidebarRoom> = {}): SidebarRoom => ({
  id: 'room:lounge',
  channelId: 'lounge',
  name: 'Lounge',
  stage: false,
  busy: false,
  count: 0,
  tail: 'Empty',
  faces: [],
  people: [],
  streaming: false,
  ...over,
});

const labels = (items: Array<{ label: string; divider?: boolean }>) => items.filter((item) => !item.divider).map((item) => item.label);

beforeEach(() => {
  mocks.manage = true;
  mocks.blocked = {};
  for (const mock of [mocks.joinCall, mocks.toggleListen, mocks.copyChannelLink, mocks.toast.info, mocks.toast.error, mocks.toast.success]) mock.mockReset();
  useServerListStore.setState({ activeServerId: null } as never);
  useConfirmStore.setState({ isOpen: false, options: null, resolve: null });
});

describe('a channel’s menu', () => {
  it('holds the notification levels, mark read and copy link; and, with Manage Channels, Edit and Delete', () => {
    const { result } = render();
    const items = result.current.menus.channelMenu('clips', 'clips');
    expect(labels(items)).toEqual(['Every message', 'Mark channel as read', 'Copy link to channel', 'for clips', 'Edit channel', 'Delete channel']);
    expect(items.at(-1)).toMatchObject({ danger: true });
  });

  it('offers nobody else’s Edit or Delete', () => {
    mocks.manage = false;
    const { result } = render();
    expect(labels(result.current.menus.channelMenu('clips', 'clips'))).toEqual(['Every message', 'Mark channel as read', 'Copy link to channel', 'for clips']);
    expect(result.current.menus.canManage).toBe(false);
  });

  it('edits in the server settings, at that channel', () => {
    const open = vi.spyOn(useUIStore.getState(), 'openGuildSettings').mockImplementation(() => {});
    useUIStore.setState({ openGuildSettings: open } as never);
    const { result } = render();
    result.current.menus.channelMenu('clips', 'clips').find((item) => item.label === 'Edit channel')?.action();
    expect(open).toHaveBeenCalledWith('g1', 'channels', 'clips');
  });

  it('asks before it deletes, and does not when you decline', async () => {
    const deleteChannel = vi.fn().mockResolvedValue(undefined);
    useChannelStore.setState({ deleteChannel } as never);
    const { result } = render();
    const remove = result.current.menus.channelMenu('clips', 'clips').find((item) => item.label === 'Delete channel');
    remove?.action();
    await act(async () => {});
    const { options } = useConfirmStore.getState();
    expect(options).toMatchObject({ title: 'Delete clips?', confirmLabel: 'Delete channel', variant: 'danger' });
    act(() => useConfirmStore.getState().close(false));
    await act(async () => {});
    expect(deleteChannel).not.toHaveBeenCalled();
    remove?.action();
    await act(async () => {});
    act(() => useConfirmStore.getState().close(true));
    await act(async () => {});
    expect(deleteChannel).toHaveBeenCalledWith('clips', SCOPE);
    expect(mocks.toast.info).toHaveBeenCalledWith('Channel deleted.');
  });

  it('says so, with the reason, when the delete fails', async () => {
    useChannelStore.setState({ deleteChannel: vi.fn().mockRejectedValue(new Error('no permission')) } as never);
    const { result } = render();
    result.current.menus.channelMenu('clips', 'clips').find((item) => item.label === 'Delete channel')?.action();
    await act(async () => {});
    act(() => useConfirmStore.getState().close(true));
    await act(async () => {});
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to delete clips'));
  });
});

describe('a room', () => {
  it('joins on a click, as the server on screen, with its name for the sentence that names a failure', () => {
    const { result } = render();
    result.current.menus.joinRoom(room());
    expect(mocks.joinCall).toHaveBeenCalledWith({ serverId: LOCAL_SERVER_ID, guildId: 'g1', channelId: 'lounge', title: 'Lounge' });
  });

  it('joins through the active instance when there is one', () => {
    useServerListStore.setState({ activeServerId: 'srv-2' } as never);
    const { result } = render();
    result.current.menus.joinRoom(room());
    expect(mocks.joinCall).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv-2' }));
  });

  it('has Listen in, Open chat, copy link, and Edit and Delete for someone who can manage', () => {
    const { result } = render();
    const items = result.current.menus.roomRowMenu(room());
    expect(labels(items)).toEqual(['Listen in', 'Open chat', 'Copy link to channel', 'Edit channel', 'Delete channel']);
    items[0].action();
    expect(mocks.toggleListen).toHaveBeenCalledWith({ serverId: LOCAL_SERVER_ID, guildId: 'g1', channelId: 'lounge', title: 'Lounge' }, false);
  });

  it('opens the room’s text chat in main', () => {
    const { result } = render();
    act(() => result.current.menus.roomRowMenu(room()).find((item) => item.label === 'Open chat')?.action());
    expect(result.current.where).toBe('/app/guilds/g1/channels/lounge');
  });

  it('copies the room’s link', () => {
    const { result } = render();
    result.current.menus.roomRowMenu(room()).find((item) => item.label === 'Copy link to channel')?.action();
    expect(mocks.copyChannelLink).toHaveBeenCalledWith({ guildId: 'g1', channelId: 'lounge' });
  });

  it('has no Listen in for a stage (its Join is the audience), and no management for someone who cannot', () => {
    mocks.manage = false;
    const { result } = render();
    expect(labels(result.current.menus.roomRowMenu(room({ stage: true, name: 'Town hall' })))).toEqual(['Open chat', 'Copy link to channel']);
  });

  it('disables Listen in with the server’s own sentence while it has refused', () => {
    mocks.blocked = { [`${LOCAL_SERVER_ID}:lounge`]: 'Listening in is off in this channel.' };
    const { result } = render();
    const [listen] = result.current.menus.roomRowMenu(room());
    expect(listen).toMatchObject({ label: 'Listen in', disabled: true, description: 'Listening in is off in this channel.' });
  });
});
