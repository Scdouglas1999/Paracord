import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeakingEdges } from './speakingEdges';
import { channelSpeakers } from './speakingSource';
import { speakingReportInput, type SpeakingReportSource } from '../../hooks/useVoiceSpeakingReporter';
import { useRemoteSpeakingStore } from '../../stores/remoteSpeakingStore';
import type { VoiceState } from '../../types';

describe('SpeakingEdges — what goes on the wire', () => {
  let sent: Array<[number, boolean]>;
  let edges: SpeakingEdges;
  const t0 = Date.UTC(2026, 8, 24, 12);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    sent = [];
    edges = new SpeakingEdges((speaking) => sent.push([Date.now() - t0, speaking]));
  });

  afterEach(() => {
    edges.dispose();
    vi.useRealTimers();
  });

  it('starts only after 300 ms of continuous speech', () => {
    edges.update(true);
    vi.advanceTimersByTime(250);
    edges.update(false); // a syllable, not talking
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);

    edges.update(true);
    vi.advanceTimersByTime(299);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([[2550, true]]);
  });

  it('stops only after 800 ms of silence, and a short pause is not a stop', () => {
    edges.update(true);
    vi.advanceTimersByTime(300);
    edges.update(false);
    vi.advanceTimersByTime(600);
    edges.update(true); // breath between words
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([[300, true]]);

    edges.update(false);
    vi.advanceTimersByTime(799);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([[300, true], [2700, false]]);
  });

  it('never puts two edges on the wire within 500 ms, and drops one undone meanwhile', () => {
    edges.update(true);
    vi.advanceTimersByTime(300); // started @300
    edges.stopNow(); // muted @300: due at once, but the gap holds it to @800
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([[300, true]]);
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([[300, true], [800, false]]);

    // Unmuted and talking at once: 300 ms debounce lands @1100, gap allows @1300.
    edges.update(true);
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(2);
    // ...and it stops again before the gap opens: nothing goes out at all.
    edges.stopNow();
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([[300, true], [800, false]]);
  });

  it('re-sends "started" every 10 s while still talking, and not after', () => {
    edges.update(true);
    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(25_000);
    expect(sent).toEqual([[300, true], [10_300, true], [20_300, true]]);
    edges.update(false);
    vi.advanceTimersByTime(30_000);
    expect(sent.at(-1)).toEqual([26_100, false]);
    expect(sent).toHaveLength(4);
  });

  it('sends nothing once disposed', () => {
    edges.update(true);
    edges.dispose();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });
});

function voiceState(over: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: 's',
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    guild_id: 'g1',
    channel_id: 'v1',
    ...over,
  };
}

describe('speakingReportInput — when this client may report', () => {
  const base: SpeakingReportSource = {
    connected: true,
    callScope: { serverId: 'srv', userId: 'me' },
    guildId: 'g1',
    channelId: 'v1',
    selfMute: false,
    selfDeaf: false,
    participants: new Map([['me', voiceState({ user_id: 'me' })]]),
    speakingUsers: new Set(['me']),
  };

  it('reports its own flag in a connected server voice channel', () => {
    expect(speakingReportInput(base)).toEqual({
      target: { serverId: 'srv', guildId: 'g1', channelId: 'v1' },
      speaking: true,
      muted: false,
    });
    // Somebody else talking is not this client's to report.
    expect(speakingReportInput({ ...base, speakingUsers: new Set(['them']) }).speaking).toBe(false);
  });

  it('never reports while muted in any way', () => {
    for (const over of [
      { selfMute: true },
      { selfDeaf: true },
      { participants: new Map([['me', voiceState({ user_id: 'me', mute: true })]]) },
      { participants: new Map([['me', voiceState({ user_id: 'me', suppress: true })]]) },
    ]) {
      const input = speakingReportInput({ ...base, ...over });
      expect(input.speaking).toBe(false);
      expect(input.muted).toBe(true);
    }
  });

  it('has no target outside a connected server call', () => {
    expect(speakingReportInput({ ...base, connected: false }).target).toBeNull();
    expect(speakingReportInput({ ...base, guildId: 'dm' }).target).toBeNull();
    expect(speakingReportInput({ ...base, channelId: null }).target).toBeNull();
    expect(speakingReportInput({ ...base, connected: false }).speaking).toBe(false);
  });
});

describe('remote speaking — local versus relayed', () => {
  beforeEach(() => useRemoteSpeakingStore.getState().reset());

  it('follows VOICE_SPEAKING edges per guild and channel', () => {
    const store = useRemoteSpeakingStore.getState();
    store.applyUpdate({ guild_id: 'g1', channel_id: 'v1', user_id: 'a', speaking: true });
    store.applyUpdate({ guild_id: 'g2', channel_id: 'v1', user_id: 'b', speaking: true });
    const byChannel = useRemoteSpeakingStore.getState().byChannel;
    expect([...channelSpeakers('srv', 'g1', 'v1', null, byChannel)]).toEqual(['a']);
    expect([...channelSpeakers('srv', 'g2', 'v1', null, byChannel)]).toEqual(['b']);

    store.applyUpdate({ guild_id: 'g1', channel_id: 'v1', user_id: 'a', speaking: false });
    expect(channelSpeakers('srv', 'g1', 'v1', null, useRemoteSpeakingStore.getState().byChannel).size).toBe(0);
  });

  it('prefers the local engine inside your own call only', () => {
    const remote = new Map([['g1:v1', new Set(['a'])], ['g1:v2', new Set(['c'])]]);
    const localCall = { serverId: 'srv', guildId: 'g1', channelId: 'v1', speakingUsers: new Set(['me']) };
    expect([...channelSpeakers('srv', 'g1', 'v1', localCall, remote)]).toEqual(['me']);
    expect([...channelSpeakers('srv', 'g1', 'v2', localCall, remote)]).toEqual(['c']);
    // The same ids on another server are not your call.
    expect([...channelSpeakers('other', 'g1', 'v1', localCall, remote)]).toEqual(['a']);
  });

  it('takes the READY snapshot as the whole truth for that guild', () => {
    const store = useRemoteSpeakingStore.getState();
    store.applyUpdate({ guild_id: 'g1', channel_id: 'v9', user_id: 'gone', speaking: true });
    store.applyUpdate({ guild_id: 'g2', channel_id: 'v1', user_id: 'kept', speaking: true });
    store.loadGuild('g1', [
      voiceState({ user_id: 'a', speaking: true }),
      voiceState({ user_id: 'b', speaking: false }),
      voiceState({ user_id: 'c' }),
    ]);
    const byChannel = useRemoteSpeakingStore.getState().byChannel;
    expect([...byChannel.keys()].sort()).toEqual(['g1:v1', 'g2:v1']);
    expect([...byChannel.get('g1:v1')!]).toEqual(['a']);
  });

  it('a leave, a move or a mute ends a relayed speaker', () => {
    const store = useRemoteSpeakingStore.getState();
    const speak = (user: string) =>
      store.applyUpdate({ guild_id: 'g1', channel_id: 'v1', user_id: user, speaking: true });
    speak('a');
    speak('b');
    speak('c');
    speak('d');
    store.applyVoiceState(voiceState({ user_id: 'a', channel_id: undefined }));
    store.applyVoiceState(voiceState({ user_id: 'b', channel_id: 'v2' }));
    store.applyVoiceState(voiceState({ user_id: 'c', self_mute: true }));
    // Still there, unmuted (say, a screen share started): still talking.
    store.applyVoiceState(voiceState({ user_id: 'd', self_stream: true }));
    expect([...useRemoteSpeakingStore.getState().byChannel.get('g1:v1')!]).toEqual(['d']);
  });
});
