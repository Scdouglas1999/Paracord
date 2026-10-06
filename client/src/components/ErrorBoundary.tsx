import { Component, type ErrorInfo, type ReactNode } from 'react';
import { safeExternalUrl } from '../lib/security';
import { logVoiceDiagnostic } from '../lib/desktopDiagnostics';
import { CreamButton, ToolChip } from './ix/primitives';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * `page` (default) renders the full-viewport recovery screen — correct at the
   * app root and for whole route surfaces. `section` renders the empty-state layout
   * (docs/index-spec.md §6.8: "Something went wrong showing messages" and a cream
   * "Reload") sized to its container, for boundaries around a single region (the
   * message feed, the sidebar, a call tile) where the rest of the app is still
   * usable and must stay on screen.
   */
  variant?: 'page' | 'section';
  /** What failed, as the section fallback names it: "Something went wrong showing {label}" ("messages"). */
  label?: string;
  /**
   * When this changes while the boundary is showing its fallback, it tries its children
   * again (the route's pathname: going somewhere else is a way out of a broken page).
   */
  resetKey?: unknown;
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

  componentDidUpdate(previous: Props) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null, errorInfo: null, retryCount: 0 });
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught:', error, errorInfo);
    }
    // A release build used to swallow this entirely: the only trace of a render
    // throw was whatever the user saw on screen. When the screen is blank there
    // is then nothing at all to go on. Always write it to the diagnostics log.
    void logVoiceDiagnostic('[app] render error caught by boundary', {
      label: this.props.label ?? 'root',
      message: error.message,
      stack: (error.stack ?? '').split('\n').slice(0, 6).join(' | '),
      componentStack: (errorInfo.componentStack ?? '').split('\n').slice(0, 8).join(' | '),
    });
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
      const named = label.charAt(0).toLowerCase() + label.slice(1);
      const exhausted = remainingRetries === 0;
      return (
        <div className="ix-section-error" data-testid="ix-section-error">
          <section className="ix-section-error__body" role="alert">
            <h2 className="ix-section-error__title">Something went wrong showing {named}</h2>
            <p className="ix-section-error__line">
              {exhausted
                ? 'It keeps failing. Reloading the app should clear it.'
                : 'The rest of the app is still working.'}
            </p>
            <CreamButton onClick={exhausted ? () => window.location.reload() : this.resetBoundary}>
              {exhausted ? 'Reload app' : 'Reload'}
            </CreamButton>
          </section>
        </div>
      );
    }

    return (
      <div className="ix-fatal" role="alert" aria-live="assertive">
        <div className="ix-fatal__panel">
          <h1 className="ix-fatal__title">Something broke on our end</h1>
          <p className="ix-fatal__line">
            A rendering error interrupted this screen — your account and messages are safe.
            Retry the view, head back home, or reload the app to recover.
          </p>

          <details className="ix-fatal__details">
            <summary className="ix-fatal__summary">Technical details</summary>
            <pre className="ix-fatal__pre">
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>

          <div className="ix-fatal__acts">
            <CreamButton onClick={this.resetBoundary} disabled={remainingRetries === 0}>
              {remainingRetries > 0 ? `Retry (${remainingRetries} left)` : 'Retry limit reached'}
            </CreamButton>
            <ToolChip onClick={() => (window.location.href = '/app')}>Return home</ToolChip>
            <ToolChip onClick={() => window.location.reload()}>Reload app</ToolChip>
            <a href={BUG_REPORT_URL} target="_blank" rel="noreferrer" className="ix-fatal__link">
              Report bug
            </a>
          </div>
        </div>
      </div>
    );
  }
}
