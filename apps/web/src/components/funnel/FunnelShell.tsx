import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '../ui/Icons.js';
import { ProgressBar } from './ProgressBar.js';

interface FunnelShellProps {
  children: ReactNode;
  showProgress: boolean;
  stepNumber: number;
  totalSteps: number;
  percentComplete: number;
  canGoBack: boolean;
  onBack: () => void;
}

/**
 * Page chrome: header, progress, back affordance, footer.
 *
 * The layout is mobile-first and deliberately sparse - the reference funnel's
 * one-question-per-screen discipline is the reason it converts, so the only
 * things on screen are the question, the answers and the progress.
 */
export function FunnelShell({
  children,
  showProgress,
  stepNumber,
  totalSteps,
  percentComplete,
  canGoBack,
  onBack,
}: FunnelShellProps) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas">
      <a
        href="#funnel-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:font-semibold focus:text-white"
      >
        Skip to questions
      </a>

      <header className="bg-brand-600">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-center px-4">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-extrabold text-brand-600"
            >
              DP
            </span>
            <span className="text-xl font-bold tracking-tight text-white">Disability Path</span>
          </div>
        </div>
      </header>

      {showProgress ? (
        <div className="border-b border-ink/5 bg-white/70 backdrop-blur">
          <div className="mx-auto max-w-2xl px-4 py-3">
            <ProgressBar
              stepNumber={stepNumber}
              totalSteps={totalSteps}
              percentComplete={percentComplete}
            />
          </div>
        </div>
      ) : null}

      <main id="funnel-main" className="flex flex-1 flex-col px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-xl flex-1">
          {canGoBack ? (
            <button
              type="button"
              onClick={onBack}
              className="mb-6 -ml-1 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:text-brand-700"
            >
              <ArrowLeftIcon />
              Back
            </button>
          ) : null}

          {children}
        </div>
      </main>

      <footer className="border-t border-ink/5 px-4 py-6">
        <nav className="mx-auto flex max-w-xl items-center justify-center gap-4 text-sm text-ink-muted">
          <a href="/terms" className="hover:text-ink">
            Terms
          </a>
          <span aria-hidden="true">·</span>
          <a href="/privacy" className="hover:text-ink">
            Privacy policy
          </a>
        </nav>
        <p className="mx-auto mt-3 max-w-xl text-center text-xs leading-relaxed text-ink-muted">
          Disability Path is a private organisation and is not affiliated with, endorsed by, or
          acting on behalf of the Social Security Administration.
        </p>
      </footer>
    </div>
  );
}
