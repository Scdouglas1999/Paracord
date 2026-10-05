import { describe, expect, it } from 'vitest';

import { personLight } from './personLight';

function person(over: Partial<Parameters<typeof personLight>[0]> = {}) {
  return personLight({ userId: '1', name: 'Mara', status: 'online', ...over });
}

describe('personLight', () => {
  it('maps presence onto the three levels', () => {
    expect(person({ status: 'online' })).toMatchObject({ level: 'on', lit: true, dim: false });
    expect(person({ status: 'streaming' })).toMatchObject({ level: 'on', lit: true, live: true });
    expect(person({ status: 'idle' })).toMatchObject({ level: 'dim', dim: true, label: 'Away' });
    expect(person({ status: 'dnd' })).toMatchObject({ level: 'dim', dnd: true });
    expect(person({ status: 'offline' })).toMatchObject({ level: 'off', lit: false, dim: true });
    expect(person({ status: undefined })).toMatchObject({ level: 'off', label: 'Offline' });
  });

  it('breathes only when somebody is actually talking in a room', () => {
    expect(person({ speaking: true, inRoom: true }).avatarClass).toBe('pc-speaking');
    // A stale speaking flag must never paint a rim on somebody who left.
    expect(person({ speaking: true, inRoom: false }).speaking).toBe(false);
    expect(person({ status: 'offline', speaking: true, inRoom: true }).speaking).toBe(false);
  });

  it('names the room in the text equivalent', () => {
    expect(person({ inRoom: true, roomName: 'Shop floor' }).label).toBe('In Shop floor');
    expect(person({ inRoom: true, speaking: true, roomName: 'Shop floor' }).label).toBe(
      'Speaking in Shop floor',
    );
    expect(person({ status: 'online' }).label).toBe('Online');
  });

});
