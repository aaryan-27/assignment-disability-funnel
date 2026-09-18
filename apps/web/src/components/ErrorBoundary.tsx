import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Last line of defence.
 *
 * A render crash on a paid-traffic funnel is money on fire. Rather than the
 * white screen React gives by default, we show a recovery path and a phone
 * number, so a broken deploy degrades into a slightly worse conversion rate
 * instead of a zero one.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // In production this is where Sentry (or equivalent) would be called.
    // eslint-disable-next-line no-console
    console.error('[funnel] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-white p-8 text-center shadow-card">
          <h1 className="text-2xl font-extrabold text-ink">Something went wrong</h1>
          <p className="mt-3 text-ink-soft">
            Sorry about that. Your answers are saved on this device - reloading should pick up
            where you left off.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="primary-cta mt-6"
          >
            Reload and continue
          </button>
          <p className="mt-4 text-sm text-ink-muted">
            Or call{' '}
            <a href="tel:18664555219" className="font-bold text-brand-700 underline">
              866-455-5219
            </a>
          </p>
        </div>
      </div>
    );
  }
}
