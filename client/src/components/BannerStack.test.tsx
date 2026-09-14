import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BANNER_INSET_PROPERTY, BannerStack } from './BannerStack';

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(BANNER_INSET_PROPERTY);
});

describe('BannerStack', () => {
  it('publishes its height for the shell to reserve, and gives it back', () => {
    // jsdom lays nothing out, so the measured height is 0 — what matters is
    // that the property is *set* while the stack is mounted and *removed* when
    // it is not, because the shell's padding falls back to 0px without it.
    const { unmount } = render(
      <BannerStack>
        <div>Reconnecting to the server…</div>
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
});
