/**
 * Config-driven funnel primitives.
 *
 * The entire questionnaire is data, not code: adding a question means adding an
 * object to `funnelConfig`, not writing a new React page. The renderer, the
 * branching engine, the progress indicator and the server-side validator all
 * derive their behaviour from these types.
 */

export type QuestionType =
  | 'single_select'
  | 'multi_select'
  | 'email'
  | 'text'
  | 'phone'
  | 'contact';

/** A selectable answer. `value` is what we persist; `label` is what we render. */
export interface Option {
  value: string;
  label: string;
  /** Optional helper text rendered under the label. */
  description?: string;
  /** Optional decorative icon key resolved by the UI layer. */
  icon?: 'check' | 'cross';
}

/**
 * Operators supported by the branching engine. Deliberately small: a funnel
 * that needs arbitrary expressions is a funnel that has outgrown config.
 */
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'is_answered'
  | 'is_not_answered';

export interface Condition {
  /** id of a previously asked question. */
  questionId: string;
  operator: ConditionOperator;
  /** Ignored by `is_answered` / `is_not_answered`. */
  value?: string | string[];
}

/** Conditions in a `showIf` array are ANDed together. */
export type ShowIf = Condition[];

export type ValidationRule =
  | { type: 'required'; message?: string }
  | { type: 'email'; message?: string }
  | { type: 'phone'; message?: string }
  | { type: 'minLength'; value: number; message?: string }
  | { type: 'maxLength'; value: number; message?: string }
  | { type: 'pattern'; value: string; message?: string };

/**
 * Sensitivity classification drives what may leave our controlled data layer.
 *
 * - `sensitive`  : health / disability / financial detail. Never sent to Meta,
 *                  never written to logs.
 * - `standard`   : demographic or process detail. Stays server-side by default.
 * - `identity`   : PII used for Meta Advanced Matching (hashed before it leaves).
 */
export type Sensitivity = 'sensitive' | 'standard' | 'identity';

export interface FunnelQuestion {
  id: string;
  type: QuestionType;
  question: string;
  description?: string;
  options?: Option[];
  validation?: ValidationRule[];
  /** All conditions must pass for the step to be shown. */
  showIf?: ShowIf;
  /** Defaults to `sensitive` — safe by default. */
  sensitivity?: Sensitivity;
  /** Renders YES/NO tiles instead of a stacked list. */
  layout?: 'list' | 'binary';
  /** Steps excluded from the progress denominator (e.g. contact capture). */
  hideFromProgress?: boolean;
  /** Copy for the primary CTA on free-text style steps. */
  ctaLabel?: string;
}

export interface FunnelConfig {
  version: string;
  /** Headline shown above the first question only. */
  intro: {
    headline: string;
    subheadline: string;
    benefitAmount: string;
  };
  questions: FunnelQuestion[];
}

/** Answers are normalised to strings (or string[] for multi-select). */
export type AnswerValue = string | string[];
export type FunnelAnswers = Record<string, AnswerValue | undefined>;
