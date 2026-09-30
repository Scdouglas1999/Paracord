import { describe, expect, it } from 'vitest';

import type { VoiceState } from '../../../types';
import {
  buildStageModel,
  controlsFit,
  liveFor,
  stageGeometry,
  watchingLabel,
  watchNotice,
  type StageInput,
} from './stageModel';
import { averageColumns, glowColors } from './useStageGlow';

const NOW = Date.parse('2026-10-01T02:12:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function voiceState(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: 'lounge',
    guild_id: 'g1',
    session_id: `s-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    username: userId,
    display_name: userId[0].toUpperCase() + userId.slice(1),
    avatar_hash: null,
    ...over,
  };
}

const TARGET = { serverId: '__local__', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function input(over: Partial<StageInput> = {}): StageInput {
  return {
    target: TARGET,
    states: [
      voiceState('vincent', { self_stream: true, self_stream_started_at: minutesAgo(42) }),
      voiceState('brendan', { self_video: true }),
      voiceState('nick', { self_mute: true }),
    ],
    speaking: new Set(['brendan']),
    selfUserId: 'me',
    channelName: 'Lounge',
    guildName: 'Game Night',
    relation: 'idle',
    joiningMode: null,
    nowMs: NOW,
    ...over,
  };
}

describe('buildStageModel', () => {
  it('names the stream and the place, with how long it has been live (screens/04)', () => {
    const model = buildStageModel(input());
    expect(model.label).toBe("Vincent's screen");
    expect(model.place).toBe('Game Night Lounge');
    expect(model.subtitle).toBe('Game Night Lounge, live for 42 min');
    expect(model.liveMinutes).toBe(42);
    expect(model.streamerSharing).toBe(true);
  });

  it('says only the place when the server did not say when the stream started', () => {
    const model = buildStageModel(
      input({ states: [voiceState('vincent', { self_stream: true })] }),
    );
    expect(model.subtitle).toBe('Game Night Lounge');
    expect(model.liveMinutes).toBeNull();
  });

  it('gives a camera tile to everyone with a camera and a chip to everyone else, you last', () => {
    const me = voiceState('me');
    const model = buildStageModel(input({ relation: 'joined', states: [me, ...input().states] }));
    expect(model.cameras.map((p) => p.userId)).toEqual(['brendan']);
    expect(model.chips.map((p) => p.userId)).toEqual(['vincent', 'nick', 'me']);
    expect(model.chips.at(-1)?.name).toBe('You');
    expect(model.cameras[0].talking).toBe(true);
    expect(model.chips.find((p) => p.userId === 'nick')?.muted).toBe(true);
  });

  it('never gives a listener a camera tile, and keeps listeners after the people who joined', () => {
    const model = buildStageModel(
      input({ states: [voiceState('luke', { mode: 'listen', self_video: true }), ...input().states] }),
    );
    expect(model.cameras.map((p) => p.userId)).toEqual(['brendan']);
    expect(model.chips.map((p) => p.userId)).toEqual(['vincent', 'nick', 'luke']);
  });

  it('offers the other sharers, never you and never the one on stage', () => {
    const model = buildStageModel(
      input({
        states: [
          ...input().states,
          voiceState('luke', { self_stream: true }),
          voiceState('me', { self_stream: true }),
        ],
      }),
    );
    expect(model.otherSharers.map((p) => p.userId)).toEqual(['luke']);
  });

  it('picks the control set from how this client stands to the channel', () => {
    expect(buildStageModel(input({ relation: 'idle' })).controls).toBe('not-joined');
    expect(buildStageModel(input({ relation: 'listening' })).controls).toBe('not-joined');
    expect(buildStageModel(input({ relation: 'listening' })).listening).toBe(true);
    const joining = buildStageModel(input({ relation: 'joining', joiningMode: 'joined' }));
    expect(joining.controls).toBe('not-joined');
    expect(joining.busy).toBe(true);
    expect(buildStageModel(input({ relation: 'joined' })).controls).toBe('joined');
  });

  it('keeps the streamer after they leave, so the stage can say whose stream it was', () => {
    const model = buildStageModel(
      input({ states: [voiceState('brendan')], people: new Map([['vincent', { name: 'Vincent', avatar: null }]]) }),
    );
    expect(model.streamer).toBeNull();
    expect(model.label).toBe("Vincent's screen");
    expect(model.streamerSharing).toBe(false);
  });
});

describe('liveFor and watchingLabel', () => {
  it('reads like a person would say it', () => {
    expect(liveFor(0)).toBe('just went live');
    expect(liveFor(42)).toBe('live for 42 min');
    expect(liveFor(60)).toBe('live for 1 hr');
    expect(liveFor(65)).toBe('live for 1 hr 5 min');
    expect(watchingLabel(0)).toBeNull();
    expect(watchingLabel(2)).toBe('2 watching');
  });
});

describe('watchNotice', () => {
  const base = { error: null, endReason: null, streamerName: 'Vincent', streamerSharing: true, hasPicture: false } as const;

  it('treats a connecting watch as "not yet", never as a failure', () => {
    for (const phase of [null, 'starting', 'connecting'] as const) {
      const notice = watchNotice({ ...base, phase });
      expect(notice).toEqual({ text: "Connecting to Vincent's screen…", retry: false, pending: true });
    }
  });

  it('shows the picture once a live watch has one', () => {
    expect(watchNotice({ ...base, phase: 'live', hasPicture: true }).text).toBeNull();
    expect(watchNotice({ ...base, phase: 'live' }).pending).toBe(true);
  });

  it('keeps an ended or failed watch down with its reason, and offers Watch again', () => {
    expect(watchNotice({ ...base, phase: 'failed', error: 'The relay refused the view.' })).toEqual({
      text: 'The relay refused the view.',
      retry: true,
      pending: false,
    });
    expect(watchNotice({ ...base, phase: 'ended', endReason: 'superseded' }).text).toBe(
      'You started watching on another device.',
    );
    expect(watchNotice({ ...base, phase: 'ended', endReason: 'ended' }).retry).toBe(true);
    expect(watchNotice({ ...base, phase: 'ended', endReason: 'revoked' }).retry).toBe(false);
  });

  it('says so when the person stopped sharing', () => {
    expect(watchNotice({ ...base, phase: 'ended', streamerSharing: false }).text).toBe('Vincent stopped sharing.');
  });
});

describe('stageGeometry', () => {
  it('reproduces the reference: 972x868 gives a 948x533 stream and a 223px row', () => {
    expect(stageGeometry({ width: 972, height: 868, cameras: 2, chips: 2 })).toEqual({ streamW: 948, streamH: 533, rowH: 223 });
  });

  it('browsing (1076 wide) grows the stream and shortens the row, like screens/06', () => {
    expect(stageGeometry({ width: 1076, height: 868, cameras: 2, chips: 1 })).toEqual({ streamW: 1052, streamH: 592, rowH: 164 });
  });

  it('shrinks the stream, never the row below its minimum, on a short window', () => {
    const g = stageGeometry({ width: 972, height: 600, cameras: 1, chips: 1 });
    expect(g.rowH).toBe(120);
    expect(g.streamH).toBe(600 - 24 - 64 - 24 - 120);
    expect(g.streamW).toBe(Math.round((g.streamH * 16) / 9));
  });

  it('gives the stream the row when nobody is in it', () => {
    const g = stageGeometry({ width: 972, height: 600, cameras: 0, chips: 0 });
    expect(g.rowH).toBe(0);
    expect(g.streamH).toBe(600 - 24 - 64 - 12);
  });
});

describe('controlsFit', () => {
  it('gives up the Clip label, then the reactions, as the pane narrows', () => {
    expect(controlsFit(948, 'joined')).toBe(0);
    expect(controlsFit(620, 'joined')).toBe(1);
    expect(controlsFit(400, 'joined')).toBe(2);
    expect(controlsFit(948, 'not-joined')).toBe(0);
  });
});

describe('the glow sample', () => {
  it('averages the columns at each edge and lights them the way the room would', () => {
    // 4x1: teal, teal, amber, amber.
    const data = [40, 200, 180, 255, 40, 200, 180, 255, 240, 150, 60, 255, 240, 150, 60, 255];
    expect(averageColumns(data, 4, 1, 0, 2)).toEqual([40, 200, 180]);
    const { left, right } = glowColors(data, 4, 1);
    // Teal stays teal-leaning (green/blue over red), amber stays amber (red over blue).
    expect(left[1]).toBeGreaterThan(left[0]);
    expect(right[0]).toBeGreaterThan(right[2]);
  });
});
