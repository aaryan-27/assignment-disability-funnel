import { useState, type FormEvent } from 'react';
import { isValidPhone, type FunnelQuestion } from '@funnel/shared';
import { AlertIcon, ArrowRightIcon, ShieldIcon, SpinnerIcon } from '../ui/Icons.js';

export interface ContactValues {
  first_name: string;
  last_name: string;
  phone: string;
}

interface ContactStepProps {
  question: FunnelQuestion;
  onSubmit: (values: ContactValues) => void;
  submitting: boolean;
  /** Server-side failure that is not tied to one field. */
  submitError: string | null;
  /** Field-level messages returned by server validation. */
  fieldErrors: Record<string, string>;
  onRetry?: () => void;
}

type FieldName = keyof ContactValues;

/** Formats as (555) 123-4567 while typing. Never blocks the keystroke. */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Final contact capture.
 *
 * Every field carries the correct `autoComplete` token so a browser or password
 * manager can fill the whole form in one tap. On a funnel whose audience skews
 * older and mobile, autofill is worth more than any amount of visual polish.
 */
export function ContactStep({
  question,
  onSubmit,
  submitting,
  submitError,
  fieldErrors,
  onRetry,
}: ContactStepProps) {
  const [values, setValues] = useState<ContactValues>({
    first_name: '',
    last_name: '',
    phone: '',
  });
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});

  const validateField = (name: FieldName, value: string): string | undefined => {
    if (name === 'first_name' && value.trim().length < 1) return 'Enter your first name';
    if (name === 'last_name' && value.trim().length < 1) return 'Enter your last name';
    if (name === 'phone') {
      if (!value.trim()) return 'Enter your phone number';
      if (!isValidPhone(value)) return 'Enter a valid 10-digit phone number';
    }
    return undefined;
  };

  const setField = (name: FieldName, value: string) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (touched[name]) {
      setErrors((previous) => ({ ...previous, [name]: validateField(name, value) }));
    }
  };

  const handleBlur = (name: FieldName) => {
    setTouched((previous) => ({ ...previous, [name]: true }));
    setErrors((previous) => ({ ...previous, [name]: validateField(name, values[name]) }));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    const nextErrors: Partial<Record<FieldName, string>> = {};
    (Object.keys(values) as FieldName[]).forEach((name) => {
      const message = validateField(name, values[name]);
      if (message) nextErrors[name] = message;
    });

    setErrors(nextErrors);
    setTouched({ first_name: true, last_name: true, phone: true });

    if (Object.keys(nextErrors).length > 0) {
      // Move focus to the first problem so keyboard and screen reader users are
      // not left guessing what needs fixing.
      const firstInvalid = (Object.keys(nextErrors) as FieldName[])[0];
      if (firstInvalid) document.getElementById(firstInvalid)?.focus();
      return;
    }

    onSubmit(values);
  };

  const resolveError = (name: FieldName): string | undefined =>
    errors[name] ?? fieldErrors[`contact.${name}`] ?? fieldErrors[name];

  const fields: { name: FieldName; label: string; autoComplete: string; type: string }[] = [
    { name: 'first_name', label: 'First name', autoComplete: 'given-name', type: 'text' },
    { name: 'last_name', label: 'Last name', autoComplete: 'family-name', type: 'text' },
    { name: 'phone', label: 'Mobile number', autoComplete: 'tel-national', type: 'tel' },
  ];

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <div className="mb-8 text-center">
        <h1 className="text-balance text-3xl font-extrabold leading-tight text-ink sm:text-4xl">
          {question.question}
        </h1>
        {question.description ? (
          <p className="mx-auto mt-3 max-w-md text-lg text-ink-soft">{question.description}</p>
        ) : null}
      </div>

      <div className="space-y-4">
        {fields.map((field) => {
          const message = resolveError(field.name);
          return (
            <div key={field.name}>
              <label
                htmlFor={field.name}
                className="mb-1.5 block px-1 text-sm font-semibold text-ink-soft"
              >
                {field.label}
              </label>
              <input
                id={field.name}
                name={field.name}
                type={field.type}
                inputMode={field.name === 'phone' ? 'tel' : 'text'}
                autoComplete={field.autoComplete}
                enterKeyHint={field.name === 'phone' ? 'go' : 'next'}
                className="field-input"
                value={
                  field.name === 'phone' ? formatPhone(values.phone) : values[field.name]
                }
                aria-invalid={Boolean(message)}
                aria-describedby={message ? `${field.name}-error` : undefined}
                onChange={(event) => setField(field.name, event.target.value)}
                onBlur={() => handleBlur(field.name)}
              />
              {message ? (
                <p
                  id={`${field.name}-error`}
                  role="alert"
                  className="mt-1.5 px-1 text-sm font-semibold text-red-600"
                >
                  {message}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {submitError ? (
        <div
          role="alert"
          className="mt-5 flex items-start gap-3 rounded-2xl border-2 border-amber-200 bg-amber-50 p-4"
        >
          <span className="mt-0.5 text-amber-600">
            <AlertIcon />
          </span>
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-900">We could not submit that</p>
            <p className="mt-0.5 text-sm text-amber-800">{submitError}</p>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-sm font-bold text-amber-900 underline underline-offset-2"
              >
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <button type="submit" className="primary-cta mt-6" disabled={submitting}>
        {submitting ? (
          <>
            <SpinnerIcon />
            Checking your answers...
          </>
        ) : (
          <>
            {question.ctaLabel ?? 'See what I qualify for'}
            <ArrowRightIcon />
          </>
        )}
      </button>

      {/*
        Consent language. Kept close to the reference funnel's TCPA disclosure,
        because for a lead-gen funnel this text is a legal requirement, not copy.
      */}
      <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-muted">
        By clicking above I provide my ESIGN signature and express written consent for Disability
        Path and one or more partner advocacy firms to contact me by call, SMS and prerecorded or
        artificial voice using automated technology at the number above, even if it is on a Do Not
        Call registry. Consent is not a condition of any purchase or service. Message and data
        rates may apply.
      </p>

      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-ink-muted">
        <ShieldIcon />
        256-bit encrypted. We never sell your medical information.
      </p>
    </form>
  );
}
