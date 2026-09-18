import { useEffect, useRef } from 'react';

interface ProgressBarProps {
  stepNumber: number;
  totalSteps: number;
  percentComplete: number;
}

/**
 * Progress indicator.
 *
 * Two deliberate choices:
 *
 * 1. The bar never moves backwards. Branching means the total step count can
 *    shrink or grow mid-funnel; a progress bar that jumps back reads as "you
 *    have made things worse" and measurably increases abandonment. We clamp to
 *    the high-water mark.
 *
 * 2. It is a real `progressbar` for assistive tech, with a text label, so a
 *    screen reader user gets the same "how much longer?" signal a sighted user
 *    gets from the fill.
 */
export function ProgressBar({ stepNumber, totalSteps, percentComplete }: ProgressBarProps) {
  const highWaterMark = useRef(percentComplete);
  highWaterMark.current = Math.max(highWaterMark.current, percentComplete);

  // Reset when the funnel restarts.
  useEffect(() => {
    if (percentComplete === 0) highWaterMark.current = 0;
  }, [percentComplete]);

  const value = Math.min(100, Math.max(highWaterMark.current, percentComplete));

  return (
    <div className="w-full">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-sm font-semibold tracking-wide text-ink-muted">
          Step {stepNumber} of {totalSteps}
        </span>
        <span className="text-sm font-bold text-brand-700" aria-hidden="true">
          {value}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`Step ${stepNumber} of ${totalSteps}, ${value} percent complete`}
        className="h-2 w-full overflow-hidden rounded-full bg-ink/10"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-600 transition-[width] duration-500 ease-out"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
