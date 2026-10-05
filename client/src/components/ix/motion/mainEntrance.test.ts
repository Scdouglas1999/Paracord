import { afterEach, describe, expect, it, vi } from 'vitest';

import { IX_SPRING } from './curves';
import {
  MAIN_FEED_IN_MS,
  MAIN_TITLE_IN_MS,
  entranceKeyframes,
  entranceParts,
  playEntrance,
  rowDirection,
} from './mainEntrance';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('main’s entrance (index-spec §5.1, §5.2)', () => {
  it('the title from translateY(dir×14+4), the feed from translateY(dir×22), both from opacity 0', () => {
    expect(entranceKeyframes('title', 1)[0]).toEqual({ transform: 'translateY(18px)', opacity: 0 });
    expect(entranceKeyframes('title', -1)[0]).toEqual({ transform: 'translateY(-10px)', opacity: 0 });
    expect(entranceKeyframes('title', 0)[0]).toEqual({ transform: 'translateY(4px)', opacity: 0 });
    expect(entranceKeyframes('feed', 1)[0]).toEqual({ transform: 'translateY(22px)', opacity: 0 });
    expect(entranceKeyframes('feed', 0)[0]).toEqual({ transform: 'translateY(0px)', opacity: 0 });
    expect(entranceKeyframes('feed', 1)[1]).toEqual({ transform: 'none', opacity: 1 });
    // Reduced motion: a fade in place.
    expect(entranceKeyframes('title', 1, true)).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('plays 420ms (title) and 480ms (feed) on the spring, nothing filling after', () => {
    const el = document.createElement('div');
    const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => ({ id: '' }) as unknown as Animation);
    (el as unknown as { animate: typeof animate }).animate = animate;
    const title = playEntrance(el, 'title', 1, { reduced: false });
    playEntrance(el, 'feed', 1, { reduced: false });
    playEntrance(el, 'feed', 1, { reduced: true });
    expect(title?.id).toBe('ix-main:title');
    expect(animate.mock.calls[0][1]).toEqual({ duration: MAIN_TITLE_IN_MS, easing: IX_SPRING, fill: 'backwards' });
    expect(animate.mock.calls[1][1]).toEqual({ duration: MAIN_FEED_IN_MS, easing: IX_SPRING, fill: 'backwards' });
    expect(animate.mock.calls[2][1]).toMatchObject({ duration: 150 });
    expect([MAIN_TITLE_IN_MS, MAIN_FEED_IN_MS]).toEqual([420, 480]);
  });

  it('finds the title and the feed of a conversation and of a page', () => {
    document.body.innerHTML = `
      <div id="conv"><div class="ix-timeline__scroller">
        <div class="ix-timeline__header"><header class="ix-large-title"></header></div>
        <div class="glass-timeline__content"></div>
      </div></div>
      <div id="page"><div class="ix-column"><header class="ix-large-title"></header></div><div class="ix-page__body"></div></div>`;
    const conv = entranceParts(document.getElementById('conv')!);
    expect(conv.map((part) => [part.part, part.element.className])).toEqual([
      ['title', 'ix-large-title'],
      ['feed', 'glass-timeline__content'],
    ]);
    const page = entranceParts(document.getElementById('page')!);
    expect(page.map((part) => part.part)).toEqual(['title', 'feed']);
  });

  it('the direction is the sign of the row index change in the pane that is not leaving; 0 for a jump', () => {
    document.body.innerHTML = `
      <nav>
        <div class="ix-pane" data-leaving=""><a data-place-row href="/b"></a><a data-place-row href="/a"></a></div>
        <div class="ix-pane"><a data-place-row href="/a"></a><a data-place-row href="/b"></a><a data-place-row href="/c"></a></div>
      </nav>`;
    const nav = document.querySelector('nav');
    expect(rowDirection(nav, '/a', '/c')).toBe(1);
    expect(rowDirection(nav, '/c', '/b')).toBe(-1);
    expect(rowDirection(nav, '/a', '/elsewhere')).toBe(0);
    expect(rowDirection(nav, '/a', '/a')).toBe(0);
    expect(rowDirection(null, '/a', '/b')).toBe(0);
  });
});
