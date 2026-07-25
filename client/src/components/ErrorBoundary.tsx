import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Bug, Home, RefreshCw, RotateCcw } from 'lucide-react';
import { safeExternalUrl } from '../lib/security';
import { Button } from './ui/Button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * `page` (default) renders the full-viewport recovery screen — correct at the
   * app root and for whole route surfaces. `section` renders a compact inline
   * panel sized to its container, for boundaries around a single region (the
   * message feed, the sidebar, a call tile) where the rest of the app is still
   * usable and must stay on screen.
   */
  variant?: 'page' | 'section';
  /** Region name used in the section fallback, e.g. "message feed". */
  label?: string;
}
interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  retryCount: number;
}

const MAX_RETRIES = 2;
const DEFAULT_BUG_REPORT_URL = 'https://github.com/Scoduglas1999/Paracord/issues/new';
const BUG_REPORT_URL =
  safeExternalUrl(import.meta.env.VITE_BUG_REPORT_URL || DEFAULT_BUG_REPORT_URL) ??
  DEFAULT_BUG_REPORT_URL;

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught:', error, errorInfo);
    }
  }

  private resetBoundary = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prev.retryCount + 1,
    }));
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    const remainingRetries = Math.max(0, MAX_RETRIES - this.state.retryCount);

    if (this.props.variant === 'section') {
      const label = this.props.label ?? 'this section';
      return (
        <div
          className="flex h-full w-full min-w-0 flex-col items-start justify-center gap-3 p-6"
          role="alert"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-danger-tint text-accent-danger">
            <Bug size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-label font-semibold text-text-primary">
              Couldn&apos;t display {label}
            </p>
            <p className="mt-1 max-w-prose text-meta text-text-secondary">
              The rest of the app is still working. Retry this panel, or reload if it
              keeps failing.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={this.resetBoundary} disabled={remainingRetries === 0}>
              <RotateCcw size={14} className="mr-1.5" />
              {remainingRetries > 0 ? 'Retry' : 'Retry limit reached'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              <RefreshCw size={14} className="mr-1.5" />
              Reload app
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10"
        role="alert"
        aria-live="assertive"
      >
        <div className="w-full max-w-2xl rounded-md border border-border-subtle bg-bg-secondary p-8 shadow-md">
          <div className="flex h-11 w-11 items-center justify-center rounded-sm bg-danger-tint text-accent-danger">
            <Bug size={22} />
          </div>
          <h1 className="mt-5 font-display text-title text-text-primary">
            Something broke on our end
          </h1>
          <p className="mt-2 max-w-prose text-body text-text-secondary">
            A rendering error interrupted this screen — your account and messages are safe.
            Retry the view, head back home, or reload the app to recover.
          </p>

          <details className="mt-6 overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-label text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-primary">
              Technical details
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle px-3.5 py-3 font-code text-meta text-text-muted">
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Button onClick={this.resetBoundary} disabled={remainingRetries === 0}>
              <RotateCcw size={16} className="mr-1.5" />
              {remainingRetries > 0 ? `Retry (${remainingRetries} left)` : 'Retry limit reached'}
            </Button>
            <Button variant="secondary" onClick={() => (window.location.href = '/app')}>
              <Home size={16} className="mr-1.5" />
              Return home
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              <RefreshCw size={16} className="mr-1.5" />
              Reload app
            </Button>
            <a
              href={BUG_REPORT_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-sm px-1 text-meta font-semibold text-text-link outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:underline focus-visible:shadow-[var(--focus-ring)]"
            >
              Report bug
            </a>
          </div>
        </div>
      </div>
    );
  }
}
