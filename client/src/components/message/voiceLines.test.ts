import { afterEach, describe, expect, it } from 'vitest';

import { useVoiceStore } from '../../stores/voiceStore';
import { resetVoiceLinesForTests, startVoiceLines, useVoiceLineStore, voiceLineText } from './voiceLines';

/** "You joined General" (docs/index-spec.md §4.11, §5.7): your own joins and leaves only. */

const initial = useVoiceStore.getState();

function seat(patch: Partial<ReturnType<typeof useVoiceStore.getState>>) {
  useVoiceStore.setState(patch);
}

afterEach(() => {
  resetVoiceLinesForTests();
  useVoiceStore.setState(initial, true);
});

describe('voice lines', () => {
  it('records your join and your leave of a server’s voice channel, once each', () => {
    startVoiceLines();
    startVoiceLines();
    seat({ connected: true, channelId: 'v1', guildId: 'g1', callMode: 'joined' });
    seat({ selfMute: true });
    seat({ connected: false, channelId: null, guildId: null, callMode: null });
    const lines = useVoiceLineStore.getState().lines;
    expect(lines.map((line) => [line.kind, line.channelId, line.guildId])).toEqual([
      ['joined', 'v1', 'g1'],
      ['left', 'v1', 'g1'],
    ]);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
  });

  it('records a move as a leave and a join, and a listen-in or a DM call as nothing', () => {
    startVoiceLines();
    seat({ connected: true, channelId: 'v1', guildId: 'g1', callMode: 'listen' });
    seat({ connected: true, channelId: 'dm1', guildId: 'dm', callMode: 'joined' });
    expect(useVoiceLineStore.getState().lines).toHaveLength(0);
    seat({ connected: true, channelId: 'v1', guildId: 'g1', callMode: 'joined' });
    seat({ connected: true, channelId: 'v2', guildId: 'g1', callMode: 'joined' });
    expect(useVoiceLineStore.getState().lines.map((line) => `${line.kind} ${line.channelId}`)).toEqual([
      'joined v1',
      'left v1',
      'joined v2',
    ]);
  });

  it('says it the way the prototype does', () => {
    expect(voiceLineText({ kind: 'joined' }, 'General')).toBe('You joined General');
    expect(voiceLineText({ kind: 'left' }, 'General')).toBe('You left General');
  });
});
