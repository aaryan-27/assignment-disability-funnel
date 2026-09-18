import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { funnelConfig, type LeadSubmission } from '@funnel/shared';
import { ContactStep, type ContactValues } from '../components/funnel/ContactStep.js';
import { EmailStep } from '../components/funnel/EmailStep.js';
import { FunnelShell } from '../components/funnel/FunnelShell.js';
import { QuestionCard } from '../components/funnel/QuestionCard.js';
import { useFunnel } from '../hooks/useFunnel.js';
import { getAttribution, getSessionId } from '../lib/attribution.js';
import { ApiError, captureEmail, submitLead } from '../lib/api.js';
import { compactAnswers } from '../lib/answers.js';
import { clearStored, STORAGE_KEYS } from '../lib/storage.js';
import { createConversionEventId, trackEvent } from '../tracking/index.js';

/**
 * The funnel page.
 *
 * Holds exactly one thing the state machine does not: network submission,
 * including the shared-event_id conversion handshake with Meta.
 */
export function FunnelPage() {
  const navigate = useNavigate();
  const funnel = useFunnel();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [email, setEmail] = useState<string>('');

  /**
   * The shared dedup key, minted once and reused forever.
   *
   * Every retry of a failed submission sends this same id, so the server's
   * idempotency check recognises the replay, and Meta receives one conversion
   * no matter how many times the network hiccupped.
   */
  const conversionEventIdRef = useRef<string | null>(null);
  const pendingContactRef = useRef<ContactValues | null>(null);

  // One PageView + ViewContent per session.
  const viewTrackedRef = useRef(false);
  useEffect(() => {
    if (viewTrackedRef.current) return;
    viewTrackedRef.current = true;
    void trackEvent({ eventName: 'PageView' });
    void trackEvent({ eventName: 'ViewContent' });
  }, []);

  const handleEmail = useCallback(
    async (value: string) => {
      setEmail(value);
      setSubmitting(true);

      // Mint the conversion id here: the partial capture and the final Lead are
      // distinct conversions, so the email capture gets its own id.
      const emailEventId = createConversionEventId();

      try {
        // Fire the Pixel copy first and learn whether it actually went out, so
        // the server knows whether its copy is a duplicate or the only copy.
        const tracked = await trackEvent({
          eventName: 'EmailCaptured',
          eventId: emailEventId,
        });

        await captureEmail({
          email: value,
          answers: compactAnswers(funnel.answers),
          attribution: getAttribution(),
          client: {
            session_id: getSessionId(),
            event_id: emailEventId,
            pixel_fired: tracked.pixelFired,
          },
        });
      } catch {
        // A failed partial capture must never block the user. We already have
        // the email in component state and it is re-sent with the full lead.
      } finally {
        setSubmitting(false);
        funnel.answer(value);
      }
    },
    [funnel],
  );

  const performSubmit = useCallback(
    async (contact: ContactValues) => {
      setSubmitting(true);
      setSubmitError(null);
      setFieldErrors({});

      if (!conversionEventIdRef.current) {
        conversionEventIdRef.current = createConversionEventId();
      }
      const eventId = conversionEventIdRef.current;

      try {
        // Browser copy of the Lead conversion, carrying the shared event_id.
        const tracked = await trackEvent({ eventName: 'Lead', eventId });

        const submission: LeadSubmission = {
          contact: {
            first_name: contact.first_name,
            last_name: contact.last_name,
            email,
            phone: contact.phone,
          },
          answers: compactAnswers(funnel.answers),
          attribution: getAttribution(),
          client: {
            session_id: getSessionId(),
            event_id: eventId,
            pixel_fired: tracked.pixelFired,
            user_agent: navigator.userAgent,
          },
          idempotency_key: eventId,
        };

        const response = await submitLead(submission, eventId);

        // Progress is only cleared once the lead is durably persisted. If this
        // line is never reached, a refresh resumes where the user left off.
        clearStored(STORAGE_KEYS.progress);

        navigate('/success', {
          replace: true,
          state: {
            leadId: response.lead_id,
            outcome: response.qualification_outcome,
            firstName: contact.first_name,
          },
        });
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.fields) setFieldErrors(error.fields);
          setSubmitError(
            error.retryable
              ? 'We had trouble reaching our servers. Your answers are saved - please try again.'
              : error.message,
          );
        } else {
          setSubmitError('Something went wrong. Your answers are saved - please try again.');
        }
        pendingContactRef.current = contact;
      } finally {
        setSubmitting(false);
      }
    },
    [email, funnel.answers, navigate],
  );

  const handleRetry = useCallback(() => {
    const contact = pendingContactRef.current;
    if (contact) void performSubmit(contact);
  }, [performSubmit]);

  const question = funnel.question;

  // Defensive: the machine always yields a question until submission completes.
  if (!question) {
    return (
      <FunnelShell
        showProgress={false}
        stepNumber={funnel.stepNumber}
        totalSteps={funnel.totalSteps}
        percentComplete={100}
        canGoBack={false}
        onBack={funnel.goBack}
      >
        <p className="text-center text-lg text-ink-soft">Preparing your results...</p>
      </FunnelShell>
    );
  }

  const isFirstQuestion = question.id === funnelConfig.questions[0]?.id;
  const isEmailStep = question.type === 'email';
  const isContactStep = question.type === 'contact';

  return (
    <FunnelShell
      showProgress={!isEmailStep}
      stepNumber={funnel.stepNumber}
      totalSteps={funnel.totalSteps}
      percentComplete={funnel.percentComplete}
      canGoBack={funnel.canGoBack && !submitting}
      onBack={funnel.goBack}
    >
      {funnel.resumed && isFirstQuestion === false ? (
        <p className="mb-5 rounded-xl bg-brand-50 px-4 py-3 text-center text-sm font-semibold text-brand-800">
          Welcome back - we saved your place.
        </p>
      ) : null}

      {isFirstQuestion ? (
        <div className="mb-8 text-center">
          <h2 className="text-balance text-2xl font-extrabold leading-tight text-ink sm:text-3xl">
            {funnelConfig.intro.headline}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-lg leading-relaxed text-ink-soft">
            {funnelConfig.intro.subheadline.split('{amount}')[0]}
            <strong className="font-bold text-brand-700">
              {funnelConfig.intro.benefitAmount}
            </strong>
            {funnelConfig.intro.subheadline.split('{amount}')[1]}
          </p>
          <p className="mt-2 text-sm font-semibold text-ink-muted">
            Takes about 2 minutes · Free · No obligation
          </p>
        </div>
      ) : null}

      {isEmailStep ? (
        <EmailStep
          question={question}
          initialValue={email}
          onSubmit={(value) => void handleEmail(value)}
          submitting={submitting}
          benefitAmount={funnelConfig.intro.benefitAmount}
        />
      ) : isContactStep ? (
        <ContactStep
          question={question}
          onSubmit={(values) => void performSubmit(values)}
          submitting={submitting}
          submitError={submitError}
          fieldErrors={fieldErrors}
          onRetry={pendingContactRef.current ? handleRetry : undefined}
        />
      ) : (
        <QuestionCard
          question={question}
          value={funnel.answers[question.id]}
          onAnswer={funnel.answer}
          direction={funnel.direction}
          stepNumber={funnel.stepNumber}
        />
      )}

      {funnel.error ? (
        <p role="alert" className="mt-4 text-center text-sm font-semibold text-red-600">
          {funnel.error}
        </p>
      ) : null}
    </FunnelShell>
  );
}
