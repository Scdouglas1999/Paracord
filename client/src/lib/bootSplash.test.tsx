import { render } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrandSplash } from '../components/brand/BrandSplash';
import { resetBootSplashForTests, useBootSplashHandoff } from './bootSplash';

/** The loading screen from index.html, with animations we can finish on demand. */
function mountBootScreen() {
  const node = document.createElement('div');
  node.id = 'pc-boot';
  document.body.appendChild(node);
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const slowLine = document.createElement('p');
  slowLine.className = 'pc-boot__slow';
  node.getAnimations = () =>
    [
      { finished, effect: { target: node } },
      // The "taking longer than usual" line, 12 s in, must not be waited for.
      { finished: new Promise(() => {}), effect: { target: slowLine } },
    ] as unknown as Animation[];
  return { node, finish };
}

function Root({ children }: { children: ReactNode }) {
  useBootSplashHandoff();
  return <>{children}</>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetBootSplashForTests();
  vi.useRealTimers();
});

afterEach(() => {
  document.getElementById('pc-boot')?.remove();
});

describe('loading screen hand-off', () => {
  it('leaves at once when the first commit is the app itself', async () => {
    const { node } = mountBootScreen();
    render(
      <StrictMode>
        <Root>
          <p>Sign in</p>
        </Root>
      </StrictMode>,
    );
    await flush();
    expect(node).toHaveClass('is-leaving');
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(document.getElementById('pc-boot')).toBeNull();
  });

  it('plays to the end over a splash that draws its final frame, then leaves', async () => {
    const { node, finish } = mountBootScreen();
    render(
      <StrictMode>
        <Root>
          <BrandSplash label="Restoring session..." />
        </Root>
      </StrictMode>,
    );
    await flush();
    expect(node).not.toHaveClass('is-leaving');
    finish();
    await flush();
    expect(node).toHaveClass('is-leaving');
  });

  it('leaves the moment the last splash goes, even mid-sequence', async () => {
    const { node } = mountBootScreen();
    const { rerender } = render(
      <Root>
        <BrandSplash label="Restoring session..." />
      </Root>,
    );
    await flush();
    expect(node).not.toHaveClass('is-leaving');
    rerender(
      <Root>
        <p>The app</p>
      </Root>,
    );
    await flush();
    expect(node).toHaveClass('is-leaving');
  });

  it('keeps the static splash still: the final frame and a status line', () => {
    const { container, getByRole } = render(<BrandSplash label="Connecting..." />);
    expect(container.querySelector('.pc-boot')).toHaveClass('is-static');
    expect(getByRole('status')).toHaveTextContent('Connecting...');
    expect(getByRole('img', { name: 'Paracord' })).toBeInTheDocument();
  });
});
