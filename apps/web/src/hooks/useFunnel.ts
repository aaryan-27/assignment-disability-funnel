import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  funnelConfig,
  getFunnelPosition,
  getNextQuestion,
  getNextUnansweredQuestion,
  getPreviousQuestion,
  isFunnelComplete,
  pruneOrphanedAnswers,
  validateAnswer,
  type AnswerValue,
  type FunnelAnswers,
  type FunnelQuestion,
} from '@funnel/shared';
import { readStored, STORAGE_KEYS, writeStored, clearStored } from '../lib/storage.js';
import { trackEvent } from '../tracking/index.js';

export type Direction = 'forward' | 'back';

interface PersistedProgress {
  answers: FunnelAnswers;
  currentQuestionId: string | null;
}

export interface UseFunnelResult {
  question: FunnelQuestion | null;
  answers: FunnelAnswers;
  stepNumber: number;
  totalSteps: number;
  percentComplete: number;
  direction: Direction;
  isComplete: boolean;
  error: string | null;
  canGoBack: boolean;
  /** True on the first render after restoring a saved session. */
  resumed: boolean;
  answer: (value: AnswerValue) => void;
  goBack: () => void;
  reset: () => void;
  setError: (message: string | null) => void;
}

/**
 * The funnel state machine.
 *
 * Responsibilities, in order of importance:
 *   1. Never lose a user's progress (autosave + resume after refresh).
 *   2. Keep the visible path consistent with the branching rules, including
 *      when the user goes back and changes an answer.
 *   3. Emit funnel telemetry without components having to think about it.
 *
 * It holds no network logic - submission lives in the page component - so the
 * machine stays testable and the concerns stay separate.
 */
export function useFunnel(): UseFunnelResult {
  const restored = useRef<PersistedProgress | null>(
    readStored<PersistedProgress>(STORAGE_KEYS.progress),
  );

  const [answers, setAnswers] = useState<FunnelAnswers>(() => restored.current?.answers ?? {});
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(() => {
    const saved = restored.current;
    if (saved?.currentQuestionId) return saved.currentQuestionId;
    return funnelConfig.questions[0]?.id ?? null;
  });
  const [direction, setDirection] = useState<Direction>('forward');
  const [error, setError] = useState<string | null>(null);
  // "Resumed" means restored *mid-funnel*. A freshly reset funnel autosaves an
  // empty state moments later, and that must not read as a resumed session.
  const [resumed] = useState(() => {
    const saved = restored.current;
    return Boolean(saved?.currentQuestionId) && Object.keys(saved?.answers ?? {}).length > 0;
  });

  // Guards so the once-per-session events stay once-per-session across renders.
  const startedRef = useRef(false);
  const qualificationStartedRef = useRef(false);
  const qualificationCompleteRef = useRef(false);

  const position = useMemo(
    () => getFunnelPosition(funnelConfig, answers, currentQuestionId),
    [answers, currentQuestionId],
  );

  // Autosave every change. Cheap, synchronous, and the difference between a
  // user who accidentally refreshes finishing or leaving.
  useEffect(() => {
    writeStored<PersistedProgress>(STORAGE_KEYS.progress, { answers, currentQuestionId });
  }, [answers, currentQuestionId]);

  // A resumed session is still a started funnel.
  useEffect(() => {
    if (resumed && !startedRef.current) startedRef.current = true;
  }, [resumed]);

  // Fires once, when the first question actually reaches the screen. The gap
  // between this and FunnelStarted is the "saw it, did not engage" cohort.
  useEffect(() => {
    if (qualificationStartedRef.current) return;
    if (!position.current) return;
    qualificationStartedRef.current = true;
    void trackEvent({ eventName: 'QualificationStarted', stepNumber: 1 });
  }, [position.current]);

  const answer = useCallback(
    (value: AnswerValue) => {
      const question = position.current;
      if (!question) return;

      const validationError = validateAnswer(question.validation, value);
      if (validationError) {
        setError(validationError);
        return;
      }

      setError(null);

      // Record the answer, then prune anything the new answer makes
      // unreachable. Changing `application_pending` from yes to no must not
      // leave a stale attorney answer behind.
      const nextAnswers = pruneOrphanedAnswers(funnelConfig, {
        ...answers,
        [question.id]: value,
      });

      const stepNumber = position.stepNumber;

      if (!startedRef.current) {
        startedRef.current = true;
        void trackEvent({ eventName: 'FunnelStarted', stepNumber });
      }

      // Internal-only event: the id and step are sent, the answer never is.
      void trackEvent({
        eventName: 'QuestionCompleted',
        questionId: question.id,
        stepNumber,
      });

      const next = getNextQuestion(funnelConfig, nextAnswers, question.id);

      // Fire QualificationCompleted when the last non-contact question is done.
      if (!qualificationCompleteRef.current && (!next || next.id === 'email')) {
        qualificationCompleteRef.current = true;
        void trackEvent({ eventName: 'QualificationCompleted', stepNumber });
      }

      setDirection('forward');
      setAnswers(nextAnswers);
      setCurrentQuestionId(next?.id ?? null);
    },
    [answers, position],
  );

  const goBack = useCallback(() => {
    if (!currentQuestionId) {
      // Stepping back out of the completed state returns to the last question.
      const visibleLast = getNextUnansweredQuestion(funnelConfig, answers);
      if (visibleLast) {
        setDirection('back');
        setCurrentQuestionId(visibleLast.id);
      }
      return;
    }

    const previous = getPreviousQuestion(funnelConfig, answers, currentQuestionId);
    if (!previous) return;

    setError(null);
    setDirection('back');
    setCurrentQuestionId(previous.id);
  }, [answers, currentQuestionId]);

  const reset = useCallback(() => {
    clearStored(STORAGE_KEYS.progress);
    startedRef.current = false;
    qualificationCompleteRef.current = false;
    setAnswers({});
    setError(null);
    setDirection('forward');
    setCurrentQuestionId(funnelConfig.questions[0]?.id ?? null);
  }, []);

  return {
    question: position.current,
    answers,
    stepNumber: position.stepNumber,
    totalSteps: position.totalSteps,
    percentComplete: position.percentComplete,
    direction,
    isComplete: isFunnelComplete(funnelConfig, answers),
    error,
    canGoBack:
      currentQuestionId !== null &&
      getPreviousQuestion(funnelConfig, answers, currentQuestionId) !== null,
    resumed,
    answer,
    goBack,
    reset,
    setError,
  };
}
