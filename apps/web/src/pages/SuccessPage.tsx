import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getLeadStatus, type LeadStatusResponse } from '../lib/api.js';
import { CheckIcon, ShieldIcon, SpinnerIcon } from '../components/ui/Icons.js';

interface SuccessState {
  leadId?: string;
  outcome?: string;
  firstName?: string;
}

/**
 * The success screen.
 *
 * It tells the truth, which is the whole point.
 *
 * At the moment a user lands here, their lead is durably stored but the CRM
 * write is still an outbox job in flight. So the page shows "received" with
 * confidence, and reports the delivery state separately once it is known. If
 * the automation has dead-lettered, the user is told a specialist will follow
 * up manually and given a phone number - never a green tick over a failure.
 */
export function SuccessPage() {
  const location = useLocation();
  const state = (location.state ?? {}) as SuccessState;

  const [status, setStatus] = useState<LeadStatusResponse | null>(null);
  const [checking, setChecking] = useState(Boolean(state.leadId));

  useEffect(() => {
    if (!state.leadId) return;

    let cancelled = false;
    let attempts = 0;

    // Poll a few times with a widening gap: the outbox usually completes within
    // a couple of seconds, and we stop rather than polling forever.
    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const result = await getLeadStatus(state.leadId!);
        if (cancelled) return;
        setStatus(result);

        const settled =
          result.synced_to_crm ||
          result.automation.every(
            (job) => job.status === 'succeeded' || job.status === 'dead_letter',
          );

        if (!settled && attempts < 5) {
          setTimeout(() => void poll(), attempts * 1500);
          return;
        }
      } catch {
        // Status is a nicety. Failing to read it changes nothing for the user -
        // their lead is already saved.
      }
      if (!cancelled) setChecking(false);
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.leadId]);

  const deadLettered = status?.automation.some((job) => job.status === 'dead_letter') ?? false;
  const synced = status?.synced_to_crm ?? false;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas">
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

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg animate-fade-up text-center">
          <span className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <CheckIcon className="h-10 w-10" />
          </span>

          <h1 className="text-balance text-3xl font-extrabold leading-tight text-ink sm:text-4xl">
            {state.firstName ? `Thank you, ${state.firstName}.` : 'Thank you.'}
            <br />
            Your answers are in.
          </h1>

          <p className="mx-auto mt-4 max-w-md text-lg leading-relaxed text-ink-soft">
            A benefits specialist is reviewing your responses now. Expect a call from a{' '}
            <strong className="font-semibold text-ink">866</strong> number within one business day.
          </p>

          <div className="mt-8 rounded-2xl border border-ink/10 bg-white p-5 text-left shadow-card">
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink-muted">
              What happens next
            </h2>
            <ol className="mt-3 space-y-3">
              {[
                'We review your answers against SSA eligibility criteria.',
                'A specialist calls to confirm the details and answer questions.',
                'If you qualify, we connect you with an advocate who files at no upfront cost.',
              ].map((text, index) => (
                <li key={text} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                    {index + 1}
                  </span>
                  <span className="text-sm leading-relaxed text-ink-soft">{text}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Delivery status - honest about what has and has not happened. */}
          <div className="mt-6 text-sm" aria-live="polite">
            {checking ? (
              <p className="inline-flex items-center gap-2 text-ink-muted">
                <SpinnerIcon className="h-4 w-4" />
                Confirming your submission...
              </p>
            ) : deadLettered ? (
              <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-4 text-left">
                <p className="font-bold text-amber-900">Your answers are saved.</p>
                <p className="mt-1 text-amber-800">
                  One of our internal systems is running behind, so our team has been alerted and
                  will process your file manually. Nothing is lost. If you would rather not wait,
                  call{' '}
                  <a href="tel:18664555219" className="font-bold underline">
                    866-455-5219
                  </a>
                  .
                </p>
              </div>
            ) : synced ? (
              <p className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                <CheckIcon className="h-4 w-4" />
                Submission confirmed
              </p>
            ) : (
              <p className="text-ink-muted">
                Your answers are saved. Final processing is still completing.
              </p>
            )}
          </div>

          {state.leadId ? (
            <p className="mt-6 text-xs text-ink-muted">
              Reference:{' '}
              <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono">{state.leadId}</code>
            </p>
          ) : null}

          <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
            <ShieldIcon />
            Your medical information is never sold or shared with advertisers.
          </p>

          <Link
            to="/"
            className="mt-6 inline-block text-sm font-semibold text-brand-700 underline underline-offset-2"
          >
            Back to start
          </Link>
        </div>
      </main>
    </div>
  );
}
