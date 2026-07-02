import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

function ThrowingChild(): ReactNode {
  throw new Error('test render failure');
}

async function renderErrorBoundary() {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { ErrorBoundary } = await import('./ErrorBoundary');
  render(
    <ErrorBoundary>
      <ThrowingChild />
    </ErrorBoundary>,
  );
  consoleError.mockRestore();
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses a safe configured bug report URL', async () => {
    vi.stubEnv('VITE_BUG_REPORT_URL', 'https://example.com/paracord/issues/new');

    await renderErrorBoundary();

    expect(screen.getByRole('link', { name: 'Report bug' })).toHaveAttribute(
      'href',
      'https://example.com/paracord/issues/new',
    );
  });

  it('falls back when the configured bug report URL is unsafe', async () => {
    vi.stubEnv('VITE_BUG_REPORT_URL', 'javascript:alert(1)');

    await renderErrorBoundary();

    expect(screen.getByRole('link', { name: 'Report bug' })).toHaveAttribute(
      'href',
      'https://github.com/paracord/paracord/issues/new',
    );
  });
});
