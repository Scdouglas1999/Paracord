import { describe, expect, it } from 'vitest';

import { DEFAULT_HOME_WIDGETS, HOME_WIDGET_IDS, enabledWidgets, listedWidgets, moveWidget, readHomeWidgets } from './widgetConfig';

describe('readHomeWidgets', () => {
  it('gives a server that never chose every widget, in the default order', () => {
    expect(readHomeWidgets(null)).toEqual(DEFAULT_HOME_WIDGETS);
    expect(readHomeWidgets({})).toEqual(DEFAULT_HOME_WIDGETS);
    expect(readHomeWidgets({ widgets: 'nope' })).toEqual(DEFAULT_HOME_WIDGETS);
  });

  it('keeps the saved order and switches, and appends what the list does not name', () => {
    const read = readHomeWidgets({
      widgets: [
        { id: 'media', enabled: false },
        { id: 'coming_up', enabled: true },
      ],
    });
    expect(read.map((widget) => widget.id)).toEqual([
      'media',
      'coming_up',
      'most_active',
      'game',
      'pinned',
      'new_here',
      'daily_word',
    ]);
    expect(read[0]).toEqual({ id: 'media', enabled: false });
    expect(read.slice(2).every((widget) => widget.enabled)).toBe(true);
  });

  it('drops unknown ids and repeats', () => {
    const read = readHomeWidgets({
      widgets: [{ id: 'weather', enabled: true }, { id: 'pinned', enabled: false }, { id: 'pinned', enabled: true }, 7],
    });
    expect(read.filter((widget) => widget.id === 'pinned')).toEqual([{ id: 'pinned', enabled: false }]);
    expect(read).toHaveLength(HOME_WIDGET_IDS.length);
  });
});

describe('enabledWidgets', () => {
  it('is the switched-on ones, in order', () => {
    expect(
      enabledWidgets({
        widgets: [
          { id: 'new_here', enabled: true },
          { id: 'coming_up', enabled: false },
          { id: 'media', enabled: false },
          { id: 'most_active', enabled: false },
          { id: 'game', enabled: false },
          { id: 'pinned', enabled: true },
        ],
      }),
      // Daily word came after this list was saved, so it is appended, switched on.
    ).toEqual(['new_here', 'pinned', 'daily_word']);
  });
});

describe('moveWidget', () => {
  it('moves one entry and leaves the rest in order', () => {
    const moved = moveWidget(DEFAULT_HOME_WIDGETS, 4, 0).map((widget) => widget.id);
    expect(moved).toEqual(['pinned', 'coming_up', 'media', 'most_active', 'game', 'new_here', 'daily_word']);
  });

  it('ignores a move off either end', () => {
    expect(moveWidget(DEFAULT_HOME_WIDGETS, 0, -1)).toEqual(DEFAULT_HOME_WIDGETS);
    expect(moveWidget(DEFAULT_HOME_WIDGETS, 6, 7)).toEqual(DEFAULT_HOME_WIDGETS);
  });
});

describe('listedWidgets', () => {
  const all = readHomeWidgets(null);

  it('leaves Daily word out while the add-on is off and the saved list never named it', () => {
    const saved = { widgets: HOME_WIDGET_IDS.filter((id) => id !== 'daily_word').map((id) => ({ id, enabled: true })) };
    expect(listedWidgets(all, saved, false).map((widget) => widget.id)).not.toContain('daily_word');
    expect(listedWidgets(all, null, false)).toHaveLength(HOME_WIDGET_IDS.length - 1);
  });

  it('lists it when the add-on is on, or when the saved list already has it', () => {
    expect(listedWidgets(all, null, true).map((widget) => widget.id)).toContain('daily_word');
    const saved = { widgets: [{ id: 'daily_word', enabled: false }] };
    expect(listedWidgets(readHomeWidgets(saved), saved, false)[0]).toEqual({ id: 'daily_word', enabled: false });
  });
});
