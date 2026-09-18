import { useEffect, useRef } from 'react';
import type { AnswerValue, FunnelQuestion } from '@funnel/shared';
import { OptionButton } from './OptionButton.js';

interface QuestionCardProps {
  question: FunnelQuestion;
  value: AnswerValue | undefined;
  onAnswer: (value: string) => void;
  direction: 'forward' | 'back';
  stepNumber: number;
}

/**
 * The generic question renderer.
 *
 * This is the payoff of the config-driven design: one component renders all
 * fifteen select questions, so adding question sixteen is a config edit and
 * nothing here changes.
 *
 * Accessibility notes:
 *  - the options are a `radiogroup` labelled by the question heading, so a
 *    screen reader announces "question, 1 of 4 selected" rather than reading
 *    four unrelated buttons;
 *  - focus moves to the heading on each new question, so keyboard and screen
 *    reader users are not silently left at the top of the document;
 *  - arrow keys move between options, matching native radio behaviour.
 */
export function QuestionCard({
  question,
  value,
  onAnswer,
  direction,
  stepNumber,
}: QuestionCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `preventScroll` keeps the viewport still: the card is already in view and
    // a scroll jump on every question feels broken.
    headingRef.current?.focus({ preventScroll: true });
  }, [question.id]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
    if (!keys.includes(event.key)) return;

    const buttons = Array.from(
      groupRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? [],
    );
    if (buttons.length === 0) return;

    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    // Wraps at both ends, like a native radio group.
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + (forward ? 1 : -1) + buttons.length) % buttons.length;

    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  const animation = direction === 'forward' ? 'animate-slide-in' : 'animate-slide-in-back';
  const isBinary = question.layout === 'binary';

  return (
    <div key={question.id} className={`w-full ${animation}`}>
      <div className="mb-8 text-center">
        <h1
          ref={headingRef}
          id={`question-${question.id}`}
          tabIndex={-1}
          className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-ink outline-none sm:text-4xl"
        >
          {question.question}
        </h1>
        {question.description ? (
          <p className="mx-auto mt-3 max-w-md text-base text-ink-soft sm:text-lg">
            {question.description}
          </p>
        ) : null}
      </div>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={`question-${question.id}`}
        onKeyDown={handleKeyDown}
        className={
          isBinary
            ? 'mx-auto grid max-w-md grid-cols-2 gap-4'
            : 'flex flex-col gap-3'
        }
      >
        {question.options?.map((option, index) => (
          <OptionButton
            key={option.value}
            option={option}
            index={index}
            selected={value === option.value}
            onSelect={onAnswer}
            variant={isBinary ? 'binary' : 'list'}
          />
        ))}
      </div>

      {/* Announces the step change to screen readers without a visual change. */}
      <p className="sr-only" aria-live="polite">
        Question {stepNumber}: {question.question}
      </p>
    </div>
  );
}
