import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType, type VoiceState } from '../../../types';
import { RoomBackdrop } from './index';

// A browser needs a download ticket before a banner path is loadable; the
// room's choice is what is tested here, so the path is taken as loadable.
vi.mock('../../../lib/userAvatar', () => ({ resolveBannerUrl: (value: string | null) => value ?? null }));

const SCOPE = { serverId: 'srv', userId: 'me' };
const GUILD = 'gn';

const voice = (user: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  user_id: user,
  guild_id: GUILD,
  channel_id: 'lounge',
  session_id: `s-${user}`,
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  self_stream: false,
  self_video: false,
  suppress: false,
  ...extra,
});

const startAmbient = vi.fn();
const stopAmbient = vi.fn();

function seed() {
  useAuthStore.setState({ user: { id: 'me', username: 'me', flags: 0 } as never, token: 't' });
  useServerListStore.setState({
    activeServerId: 'srv',
    servers: [
      { id: 'srv', url: 'https://srv.example', name: 'Test', token: 't', userId: 'me', user: { id: 'me', username: 'me', flags: 0 } as never, connected: true },
    ] as never,
  });
  useGuildStore.setState({
    guilds: [
      { id: GUILD, name: 'Game Night', owner_id: 'x', member_count: 8, scope: SCOPE, key: entityScopeKey(SCOPE, GUILD), icon_hash: null, banner_hash: null },
    ] as never,
  });
  useChannelStore.setState({
    channelsByGuild: {
      [entityScopeKey(SCOPE, GUILD)]: [
        { id: 'general', guild_id: GUILD, name: 'General', type: ChannelType.Text, position: 0 },
        { id: 'lounge', guild_id: GUILD, name: 'Lounge', type: ChannelType.Voice, position: 1 },
      ] as never,
    },
  });
  useVoiceStore.setState({
    channelParticipants: new Map([['lounge', [voice('vincent', { self_stream: true }), voice('brendan')]]]),
    startAmbient,
    stopAmbient,
  });
  useGlassStore.getState().reset();
}

describe('RoomBackdrop', () => {
  beforeEach(() => {
    startAmbient.mockReset();
    stopAmbient.mockReset();
    seed();
  });
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('draws two small canvases behind everything and keeps the native underlay hole clear', () => {
    const { container } = render(<RoomBackdrop guildId={null} />);
    const root = container.querySelector('.glass-room-backdrop') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.hasAttribute('data-native-underlay-clear')).toBe(true);
    const canvases = root.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect(canvas.width).toBe(32);
      expect(canvas.height).toBe(18);
      // No inline style: the crossfade is an attribute and CSS.
      expect(canvas.getAttribute('style')).toBeNull();
    }
    expect(root.dataset.roomSource).toBe('none');
  });

  it("asks for the current server's busiest stream as the ambient view", () => {
    const { container } = render(<RoomBackdrop guildId={GUILD} />);
    expect(startAmbient).toHaveBeenCalledWith({ serverId: 'srv', guildId: GUILD, channelId: 'lounge', streamerId: 'vincent' });
    expect((container.querySelector('.glass-room-backdrop') as HTMLElement).dataset.roomSource).toBe('stream-ambient');
  });

  it('stops the ambient view at Home, when nothing is live, and on unmount', () => {
    const { rerender, unmount } = render(<RoomBackdrop guildId={GUILD} />);
    expect(startAmbient).toHaveBeenCalledTimes(1);
    rerender(<RoomBackdrop guildId={null} />);
    expect(stopAmbient).toHaveBeenCalled();
    stopAmbient.mockReset();

    rerender(<RoomBackdrop guildId={GUILD} />);
    act(() => {
      useVoiceStore.setState({ channelParticipants: new Map([['lounge', [voice('brendan')]]]) });
    });
    expect(stopAmbient).toHaveBeenCalled();

    stopAmbient.mockReset();
    unmount();
    expect(stopAmbient).toHaveBeenCalled();
  });

  it('lights from the watched stream while the stage is open', () => {
    const { container } = render(<RoomBackdrop guildId={GUILD} />);
    act(() => {
      useGlassStore.getState().openStage({ serverId: 'srv', guildId: GUILD, channelId: 'lounge', streamerId: 'vincent' });
    });
    expect((container.querySelector('.glass-room-backdrop') as HTMLElement).dataset.roomSource).toBe('stream-watch');
  });

  it('lights from the banner when nothing is live', () => {
    useGuildStore.setState({
      guilds: [
        { id: GUILD, name: 'Basecamp', owner_id: 'x', member_count: 5, scope: SCOPE, key: entityScopeKey(SCOPE, GUILD), icon_hash: null, banner_hash: '/api/v1/guilds/gn/banner' },
      ] as never,
    });
    useVoiceStore.setState({ channelParticipants: new Map() });
    const { container } = render(<RoomBackdrop guildId={GUILD} />);
    expect(startAmbient).not.toHaveBeenCalled();
    expect(stopAmbient).toHaveBeenCalled();
    expect((container.querySelector('.glass-room-backdrop') as HTMLElement).dataset.roomSource).toBe('banner');
  });
});
