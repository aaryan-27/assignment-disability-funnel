import type { Option } from '@funnel/shared';
import { CheckIcon, CrossIcon } from '../ui/Icons.js';

interface OptionButtonProps {
  option: Option;
  selected: boolean;
  onSelect: (value: string) => void;
  /** Rendered as a large tile rather than a full-width row. */
  variant?: 'list' | 'binary';
  index: number;
}

/**
 * A single answer.
 *
 * It is a real `<button>`, not a styled div, so it is focusable, activates on
 * both Enter and Space, and is announced correctly. `aria-pressed` communicates
 * the selected state, which is otherwise conveyed by colour alone.
 *
 * The staggered entrance is capped at six items so a long list never leaves the
 * last option waiting.
 */
export function OptionButton({
  option,
  selected,
  onSelect,
  variant = 'list',
  index,
}: OptionButtonProps) {
  const delay = `${Math.min(index, 6) * 45}ms`;

  if (variant === 'binary') {
    const isYes = option.icon === 'check';
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(option.value)}
        style={{ animationDelay: delay }}
        className={`group flex animate-fade-up flex-col items-center justify-center gap-4
                    rounded-2xl border-2 bg-white px-6 py-8 shadow-option transition-all duration-150
                    hover:-translate-y-0.5 hover:shadow-option-hover active:translate-y-0 active:scale-[0.99]
                    ${
                      selected
                        ? 'border-brand-600 bg-brand-50'
                        : 'border-transparent hover:border-brand-300'
                    }`}
      >
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-full transition-colors
                      ${isYes ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}
        >
          {isYes ? <CheckIcon className="h-8 w-8" /> : <CrossIcon className="h-8 w-8" />}
        </span>
        <span className="text-xl font-bold uppercase tracking-wide text-ink">{option.label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(option.value)}
      style={{ animationDelay: delay }}
      className="option-button animate-fade-up"
    >
      <span className="flex-1">
        <span className="block leading-snug">{option.label}</span>
        {option.description ? (
          <span className="mt-1 block text-sm font-medium text-ink-muted">
            {option.description}
          </span>
        ) : null}
      </span>

      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors
                    ${
                      selected
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-ink/15 text-transparent group-hover:border-brand-400'
                    }`}
      >
        <CheckIcon className="h-4 w-4" />
      </span>
    </button>
  );
}
