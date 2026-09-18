import { useState, type FormEvent } from 'react';
import { isValidEmail, type FunnelQuestion } from '@funnel/shared';
import { ArrowRightIcon, ShieldIcon, SpinnerIcon } from '../ui/Icons.js';

interface EmailStepProps {
  question: FunnelQuestion;
  initialValue: string;
  onSubmit: (email: string) => void;
  submitting: boolean;
  benefitAmount: string;
}

/**
 * Email capture.
 *
 * `type="email"` plus `inputMode="email"` gives mobile users the right keyboard
 * (with the @ key), and `autoComplete="email"` lets the browser fill it -
 * together these remove most of the friction at the single highest-drop-off
 * step in the funnel.
 *
 * Validation is on blur and on submit, never on every keystroke: telling
 * someone their email is invalid while they are still typing the domain is
 * hostile.
 */
export function EmailStep({
  question,
  initialValue,
  onSubmit,
  submitting,
  benefitAmount,
}: EmailStepProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const validate = (candidate: string): string | null => {
    if (!candidate.trim()) return 'Enter your email address so we can send your results';
    if (!isValidEmail(candidate)) return 'That email does not look right - please check it';
    return null;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validationError = validate(value);
    setTouched(true);
    setError(validationError);
    if (validationError) return;
    onSubmit(value.trim().toLowerCase());
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <div className="mb-8 text-center">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-1.5 text-sm font-bold text-emerald-700">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald-500" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Based on your answers
        </p>
        <h1 className="text-balance text-3xl font-extrabold leading-tight text-ink sm:text-4xl">
          You may pre-qualify for up to{' '}
          <span className="text-brand-700">{benefitAmount}/month</span>
        </h1>
        <p className="mx-auto mt-3 max-w-md text-lg text-ink-soft">{question.question}</p>
      </div>

      <label htmlFor="email" className="sr-only">
        Email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className="field-input"
        placeholder="you@example.com"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'email-error' : 'email-hint'}
        onChange={(event) => {
          setValue(event.target.value);
          // Clear an existing error as soon as the input becomes valid, so the
          // message disappears the moment it stops being true.
          if (touched && error && !validate(event.target.value)) setError(null);
        }}
        onBlur={() => {
          setTouched(true);
          setError(validate(value));
        }}
      />

      {error ? (
        <p id="email-error" role="alert" className="mt-2 px-1 text-sm font-semibold text-red-600">
          {error}
        </p>
      ) : (
        <p id="email-hint" className="mt-2 px-1 text-sm text-ink-muted">
          We email your results so you always have a copy.
        </p>
      )}

      <button type="submit" className="primary-cta mt-6" disabled={submitting}>
        {submitting ? (
          <>
            <SpinnerIcon />
            Saving...
          </>
        ) : (
          <>
            {question.ctaLabel ?? 'Continue'}
            <ArrowRightIcon />
          </>
        )}
      </button>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-ink-muted">
        <ShieldIcon />
        Your information is encrypted and never sold.
      </p>
    </form>
  );
}
