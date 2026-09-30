import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BANNER_INSET_PROPERTY, BannerStack } from './BannerStack';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(BANNER_INSET_PROPERTY);
});

describe('BannerStack', () => {
  it('publishes its height for the shell to reserve, and gives it back', () => {
    // jsdom lays nothing out, so the measured height is 0 — what matters is
    // that the property is *set* while the stack is mounted and *removed* when
    // it is not, because the shell's padding falls back to 0px without it.
    const { unmount } = render(
      <BannerStack>
        <div>Reconnecting to the instance…</div>
      </BannerStack>,
    );
    expect(document.documentElement.style.getPropertyValue(BANNER_INSET_PROPERTY)).toBe('0px');

    unmount();
    expect(document.documentElement.style.getPropertyValue(BANNER_INSET_PROPERTY)).toBe('');
  });

  it('stacks its banners in one column rather than letting each one cover the app', () => {
    const { container } = render(
      <BannerStack>
        <div>first</div>
        <div>second</div>
      </BannerStack>,
    );
    const stack = container.querySelector('[data-banner-stack]');
    expect(stack).not.toBeNull();
    expect(stack!.className).toContain('flex-col');
    expect(stack!.children).toHaveLength(2);
  });

  describe('the Glass incoming-call capsule', () => {
    // jsdom applies no stylesheet, so what is pinned here is the contract the
    // browser acts on: the stack's own rules for `.glass-callbanner`, and what the
    // measure reads. The layout itself (panes stay put while a call rings, the
    // capsule rides under the other banners) was run in Chromium against the mocked
    // scene; see docs/design/glass-polish-1-checkpoint.md.
    const classes = (container: HTMLElement) => container.querySelector('[data-banner-stack]')!.className.split(/\s+/);

    it('is taken out of the stack’s flow, under the banners that stay in it', () => {
      const { container } = render(
        <BannerStack>
          <div>Reconnecting to the instance…</div>
          <div className="glass-callbanner">
            <div className="glass-callbanner__pill">Brendan is calling you</div>
          </div>
        </BannerStack>,
      );
      const rules = classes(container);
      // Out of the flow, across the stack's width, starting where the in-flow banners end.
      expect(rules).toEqual(expect.arrayContaining([
        '[&>.glass-callbanner]:absolute',
        '[&>.glass-callbanner]:inset-x-0',
        '[&>.glass-callbanner]:top-full',
      ]));
      // The strip around the capsule reaches the app; the capsule itself takes clicks.
      expect(rules).toEqual(expect.arrayContaining([
        '[&>.glass-callbanner]:pointer-events-none',
        '[&>.glass-callbanner>*]:pointer-events-auto',
      ]));
    });

    it('leaves every other banner in the flow, so it still moves the app down', () => {
      const { container } = render(
        <BannerStack>
          <div>Reconnecting to the instance…</div>
        </BannerStack>,
      );
      const rules = classes(container);
      expect(rules).toEqual(expect.arrayContaining(['flex', 'flex-col']));
      // Nothing is positioned for every child: each rule that moves a child names the capsule.
      expect(rules).not.toContain('absolute');
      const childRules = rules.filter((rule) => rule.startsWith('[&'));
      expect(childRules.length).toBeGreaterThan(0);
      for (const rule of childRules) expect(rule).toMatch(/^\[&>\.glass-callbanner(>\*)?\]:/);
    });

    it('reserves what the stack measures, not what the capsule is tall', () => {
      // The stack measures 32px (one bar in flow) and the capsule 62px. The capsule is
      // out of the flow, so the stack's own box is what the shell must reserve.
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const height = this.hasAttribute('data-banner-stack') ? 32 : 62;
        return { x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: height, width: 1440, height, toJSON: () => ({}) };
      });
      render(
        <BannerStack>
          <div>Reconnecting to the instance…</div>
          <div className="glass-callbanner">Brendan is calling you</div>
        </BannerStack>,
      );
      expect(document.documentElement.style.getPropertyValue(BANNER_INSET_PROPERTY)).toBe('32px');
    });

    it('reserves nothing when the capsule is the only thing ringing', () => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const height = this.hasAttribute('data-banner-stack') ? 0 : 62;
        return { x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: height, width: 1440, height, toJSON: () => ({}) };
      });
      render(
        <BannerStack>
          <div className="glass-callbanner">Brendan is calling you</div>
        </BannerStack>,
      );
      expect(document.documentElement.style.getPropertyValue(BANNER_INSET_PROPERTY)).toBe('0px');
    });
  });
});
