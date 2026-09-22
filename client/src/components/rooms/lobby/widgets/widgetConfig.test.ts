import { describe, expect, it } from 'vitest';

import { DEFAULT_HOME_WIDGETS, HOME_WIDGET_IDS, enabledWidgets, moveWidget, readHomeWidgets } from './widgetConfig';

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
    ).toEqual(['new_here', 'pinned']);
  });
});

describe('moveWidget', () => {
  it('moves one entry and leaves the rest in order', () => {
    const moved = moveWidget(DEFAULT_HOME_WIDGETS, 4, 0).map((widget) => widget.id);
    expect(moved).toEqual(['pinned', 'coming_up', 'media', 'most_active', 'game', 'new_here']);
  });

  it('ignores a move off either end', () => {
    expect(moveWidget(DEFAULT_HOME_WIDGETS, 0, -1)).toEqual(DEFAULT_HOME_WIDGETS);
    expect(moveWidget(DEFAULT_HOME_WIDGETS, 5, 6)).toEqual(DEFAULT_HOME_WIDGETS);
  });
});
