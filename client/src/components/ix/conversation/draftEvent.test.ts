import { describe, expect, it } from 'vitest';

import { draftMeta, draftPayload, draftTile, firstVoiceChannel, newDraft } from './draftEvent';

const channels = [
  { id: 'cat', name: 'Voice', type: 4, position: 1 },
  { id: 'text', name: 'general', type: 0, position: 0 },
  { id: 'late', name: 'Late night', type: 2, position: 1 },
  { id: 'gen', name: 'General', type: 2, position: 0 },
  { id: 'stage', name: 'Stage', type: 13, position: 0 },
];

describe('the Plan a night draft', () => {
  it('is held in the first voice channel by position, never a stage', () => {
    expect(firstVoiceChannel(channels)).toEqual({ id: 'gen', name: 'General' });
    expect(firstVoiceChannel(channels.filter((channel) => channel.type !== 2))).toBeNull();
  });

  it('follows the sidebar’s order: uncategorized first, then by category', () => {
    const categorized = [
      { id: 'cat2', name: 'Late', type: 4, position: 2 },
      { id: 'cat1', name: 'Early', type: 4, position: 1 },
      { id: 'b', name: 'B', type: 2, position: 0, parent_id: 'cat2' },
      { id: 'a', name: 'A', type: 2, position: 5, parent_id: 'cat1' },
    ];
    expect(firstVoiceChannel(categorized)?.id).toBe('a');
    expect(firstVoiceChannel([...categorized, { id: 'loose', name: 'Loose', type: 2, position: 9 }])?.id).toBe('loose');
  });

  it('says "Game night", the weekday and time, and where', () => {
    const plan = newDraft(new Date('2026-10-01T21:38:00'), channels, null);
    expect(plan.name).toBe('Game night');
    expect(draftMeta(plan)).toMatch(/^Friday at 9:00\sPM · in General$/);
    expect(draftTile(plan)).toEqual({ weekday: 'Fri', day: '9' });
    expect(draftMeta({ start: plan.start, voice: null })).toMatch(/^Friday at 9:00\sPM$/);
  });

  it('creates a voice-channel event with a reminder, or an external one when there is no voice channel', () => {
    const plan = newDraft(new Date('2026-10-01T21:38:00'), channels, null);
    expect(draftPayload(plan)).toEqual({
      name: 'Game night',
      scheduled_start: plan.start.toISOString(),
      entity_type: 1,
      channel_id: 'gen',
      reminder_minutes: 30,
    });
    const bare = newDraft(new Date('2026-10-01T21:38:00'), [], null);
    expect(draftPayload(bare)).toEqual({ name: 'Game night', scheduled_start: bare.start.toISOString(), entity_type: 2, reminder_minutes: 30 });
    expect(plan.eventId).toBeNull();
  });
});
