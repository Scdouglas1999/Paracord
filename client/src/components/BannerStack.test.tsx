import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BANNER_INSET_PROPERTY, BannerStack } from './BannerStack';
import { IX_BANNER_INSET_PROPERTY, useBannerHostStore } from './ix/shell/bannerHost';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(BANNER_INSET_PROPERTY);
  document.documentElement.style.removeProperty(IX_BANNER_INSET_PROPERTY);
  useBannerHostStore.setState({ host: null });
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

  it('in the Index frame, sits in the host over main and moves main alone (index-spec §6.8)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    useBannerHostStore.setState({ host });
    const { unmount } = render(
      <BannerStack>
        <div>Reconnecting to the instance…</div>
      </BannerStack>,
    );
    expect(host.querySelector('[data-banner-stack]')?.textContent).toBe('Reconnecting to the instance…');
    // Main's inset, not the whole shell's.
    expect(document.documentElement.style.getPropertyValue(IX_BANNER_INSET_PROPERTY)).toBe('0px');
    expect(document.documentElement.style.getPropertyValue(BANNER_INSET_PROPERTY)).toBe('');
    unmount();
    expect(document.documentElement.style.getPropertyValue(IX_BANNER_INSET_PROPERTY)).toBe('');
    host.remove();
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
});
