import { Component, type ErrorInfo, type ReactNode } from 'react';
import { safeExternalUrl } from '../lib/security';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  retryCount: number;
}

const MAX_RETRIES = 2;
const DEFAULT_BUG_REPORT_URL = 'https://github.com/paracord/paracord/issues/new';
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

    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-8">
        <div className="w-full max-w-2xl rounded-2xl border border-border-subtle bg-bg-secondary p-6 shadow-lg">
          <h1 className="text-xl font-bold text-accent-danger">Application Error</h1>
          <p className="mt-2 text-sm text-text-secondary">
            A rendering error interrupted this screen. You can retry, return home, or reload the app.
          </p>

          <details className="mt-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/40 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-text-primary">
              Error details
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-primary p-3 text-xs text-text-muted">
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={this.resetBoundary}
              disabled={remainingRetries === 0}
            >
              {remainingRetries > 0 ? `Retry (${remainingRetries} left)` : 'Retry limit reached'}
            </button>
            <a
              href="/app"
              className="btn-ghost inline-flex items-center justify-center"
            >
              Return Home
            </a>
            <button type="button" className="btn-ghost" onClick={() => window.location.reload()}>
              Reload App
            </button>
            <a
              href={BUG_REPORT_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-xs font-semibold text-text-link hover:underline"
            >
              Report bug
            </a>
          </div>
        </div>
      </div>
    );
  }
}
