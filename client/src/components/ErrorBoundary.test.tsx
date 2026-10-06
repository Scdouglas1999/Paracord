import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      'https://github.com/Scoduglas1999/Paracord/issues/new',
    );
  });
});

describe('ErrorBoundary variant="section"', () => {
  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  async function renderSection(label?: string) {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ErrorBoundary } = await import('./ErrorBoundary');
    const view = render(
      <ErrorBoundary variant="section" label={label}>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    return { view, consoleError };
  }

  it('is the empty-state layout: "Something went wrong showing messages" and a cream Reload', async () => {
    const { consoleError } = await renderSection('messages');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Something went wrong showing messages' })).toBeInTheDocument();
    expect(screen.getByText('The rest of the app is still working.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveClass('ix-cream');
    consoleError.mockRestore();
  });

  it('names the section in lower case: "showing channels"', async () => {
    const { consoleError } = await renderSection('Channels');
    expect(screen.getByRole('heading', { name: 'Something went wrong showing channels' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('Reload tries the section again; when it keeps failing the same button reloads the app', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const { consoleError } = await renderSection('messages');
    for (const _ of [1, 2]) {
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).not.toHaveBeenCalled();
    }
    expect(screen.getByText('It keeps failing. Reloading the app should clear it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload app' }));
    expect(reload).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('ErrorBoundary resetKey', () => {
  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  it('tries its children again when the key changes (a route change leaves a broken page)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ErrorBoundary } = await import('./ErrorBoundary');
    function Page({ broken }: { broken: boolean }): ReactNode {
      if (broken) throw new Error('this page broke');
      return <p>a working page</p>;
    }
    const view = render(
      <ErrorBoundary variant="section" label="this page" resetKey="/app/guilds/1/events">
        <Page broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong showing this page' })).toBeInTheDocument();

    // Same key: it stays on the fallback.
    view.rerender(
      <ErrorBoundary variant="section" label="this page" resetKey="/app/guilds/1/events">
        <Page broken={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('a working page')).toBeNull();

    // Another route: it shows the new page, with its retries back.
    view.rerender(
      <ErrorBoundary variant="section" label="this page" resetKey="/app/guilds/1/channels/2">
        <Page broken={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('a working page')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    consoleError.mockRestore();
  });
});
