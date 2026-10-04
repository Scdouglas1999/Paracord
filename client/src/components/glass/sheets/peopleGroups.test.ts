import { describe, expect, it } from 'vitest';
import type { Role, User } from '../../../types';
import { groupPeople, isHere, pageSections, type PeopleEntry } from './peopleGroups';

/** The people sheet's order (docs/index-spec.md §8.6): here now, then by role, then Offline. */

const entry = (name: string, over: Partial<PeopleEntry> = {}): PeopleEntry => ({
  user: { id: name, username: name.toLowerCase() } as User,
  name,
  status: 'offline',
  detail: 'Offline',
  room: null,
  roleIds: [],
  ...over,
});

const role = (id: string, name: string, position: number, hoist = true): Role =>
  ({ id, name, position, hoist, guild_id: 'g', color: 0, permissions: '0', mentionable: false, created_at: '' }) as Role;

describe('groupPeople', () => {
  it('puts everyone who is here, or in a room, first, sorted by name', () => {
    const sections = groupPeople(
      [
        entry('Zoe', { status: 'online' }),
        entry('Amy', { status: 'idle' }),
        entry('Bo', { status: 'offline', room: 'Lounge' }),
        entry('Cy'),
      ],
      null,
    );
    expect(sections.map((section) => section.id)).toEqual(['here', 'offline']);
    expect(sections[0].entries.map((e) => e.name)).toEqual(['Amy', 'Bo', 'Zoe']);
    expect(sections[1].entries.map((e) => e.name)).toEqual(['Cy']);
  });

  it('files the rest under their highest hoisted role, highest role first, and the leftovers under Offline', () => {
    const roles = [role('all', '@everyone', 0, false), role('mod', 'Moderators', 5), role('reg', 'Regulars', 2), role('col', 'Cosmetic', 9, false)];
    const sections = groupPeople(
      [
        entry('Ann', { roleIds: ['reg'] }),
        entry('Ben', { roleIds: ['reg', 'mod'] }),
        entry('Cat', { roleIds: ['col'] }),
        entry('Dee'),
        entry('Eve', { status: 'online', roleIds: ['mod'] }),
      ],
      roles,
    );
    expect(sections.map((section) => [section.label, section.entries.map((e) => e.name)])).toEqual([
      ['Here now', ['Eve']],
      ['Moderators', ['Ben']],
      ['Regulars', ['Ann']],
      ['Offline', ['Cat', 'Dee']],
    ]);
  });

  it('leaves empty sections out, and treats unknown roles as Offline', () => {
    expect(groupPeople([], [role('mod', 'Moderators', 5)])).toEqual([]);
    const sections = groupPeople([entry('Ann', { roleIds: ['gone'] })], [role('mod', 'Moderators', 5)]);
    expect(sections.map((section) => section.id)).toEqual(['offline']);
  });

  it('knows who is here: present in any way, or in a voice room', () => {
    expect(isHere(entry('A', { status: 'dnd' }))).toBe(true);
    expect(isHere(entry('B', { room: 'Lounge' }))).toBe(true);
    expect(isHere(entry('C'))).toBe(false);
  });
});

describe('pageSections', () => {
  const sections = groupPeople(
    [
      ...['A', 'B', 'C'].map((name) => entry(name, { status: 'online' as const })),
      ...['D', 'E'].map((name) => entry(name)),
    ],
    null,
  );

  it('shows a page across the sections in order, counting what is held back', () => {
    const { shown, hidden } = pageSections(sections, 4);
    expect(shown.map((section) => [section.id, section.entries.length, section.total])).toEqual([
      ['here', 3, 3],
      ['offline', 1, 2],
    ]);
    expect(hidden).toBe(1);
  });

  it('shows everything when the page is long enough, and drops a section it has no room for', () => {
    expect(pageSections(sections, 120)).toMatchObject({ hidden: 0 });
    const small = pageSections(sections, 3);
    expect(small.shown.map((section) => section.id)).toEqual(['here']);
    expect(small.hidden).toBe(2);
  });
});
