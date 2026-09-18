import type {
  AnswerValue,
  Condition,
  FunnelAnswers,
  FunnelConfig,
  FunnelQuestion,
  ValidationRule,
} from './types.js';

/**
 * True when the answer exists and is not an empty string / empty array.
 * Written as a type predicate so callers get narrowing for free.
 */
export function isAnswered(value: AnswerValue | undefined): value is AnswerValue {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Evaluate a single branching condition against the answers collected so far. */
export function evaluateCondition(condition: Condition, answers: FunnelAnswers): boolean {
  const actual = answers[condition.questionId];

  switch (condition.operator) {
    case 'is_answered':
      return isAnswered(actual);
    case 'is_not_answered':
      return !isAnswered(actual);
    case 'equals':
      return !Array.isArray(actual) && actual === condition.value;
    case 'not_equals':
      return Array.isArray(actual) || actual !== condition.value;
    case 'in':
      return typeof actual === 'string' && toArray(condition.value).includes(actual);
    case 'not_in':
      // An unanswered question is "not in" any set - this keeps downstream
      // questions hidden until their parent has actually been answered.
      if (!isAnswered(actual)) return false;
      return typeof actual === 'string' && !toArray(condition.value).includes(actual);
    default: {
      const exhaustive: never = condition.operator;
      throw new Error(`Unsupported condition operator: ${String(exhaustive)}`);
    }
  }
}

/** A question is visible when every condition in its `showIf` array passes. */
export function isQuestionVisible(question: FunnelQuestion, answers: FunnelAnswers): boolean {
  if (!question.showIf || question.showIf.length === 0) return true;
  return question.showIf.every((condition) => evaluateCondition(condition, answers));
}

/**
 * The ordered list of questions this particular user should see, given what
 * they have answered so far. Recomputed on every answer, so changing an earlier
 * answer via the back button correctly re-opens or re-hides later branches.
 */
export function getVisibleQuestions(
  config: FunnelConfig,
  answers: FunnelAnswers,
): FunnelQuestion[] {
  return config.questions.filter((question) => isQuestionVisible(question, answers));
}

/**
 * Answers belonging to questions that are no longer visible.
 *
 * When a user backs up and flips `application_pending` from yes to no, the
 * attorney answers they already gave must not be persisted - they would be
 * factually wrong. We prune them rather than carrying orphaned data forward.
 */
export function pruneOrphanedAnswers(
  config: FunnelConfig,
  answers: FunnelAnswers,
): FunnelAnswers {
  // Iterate in funnel order so that pruning a parent also prunes its children.
  let working: FunnelAnswers = { ...answers };
  let changed = true;

  while (changed) {
    changed = false;
    for (const question of config.questions) {
      if (working[question.id] === undefined) continue;
      if (!isQuestionVisible(question, working)) {
        const next = { ...working };
        delete next[question.id];
        working = next;
        changed = true;
      }
    }
  }

  return working;
}

export interface FunnelPosition {
  /** The question to render, or null when the funnel is complete. */
  current: FunnelQuestion | null;
  /** 1-based index of the current question within the visible path. */
  stepNumber: number;
  /** Total visible steps on the current path (a moving target by design). */
  totalSteps: number;
  /** 0-100. Never reports 100 until the funnel is genuinely finished. */
  percentComplete: number;
  isComplete: boolean;
}

/**
 * Resolve where the user is.
 *
 * `totalSteps` is an estimate: branching means the true length is unknowable
 * until the last branch resolves. We show the current path length, which is
 * honest and monotonic enough in practice, and we never let the bar go
 * backwards visually (the UI clamps it).
 */
export function getFunnelPosition(
  config: FunnelConfig,
  answers: FunnelAnswers,
  currentQuestionId: string | null,
): FunnelPosition {
  const visible = getVisibleQuestions(config, answers);
  const total = visible.length;

  if (currentQuestionId === null) {
    return { current: null, stepNumber: total, totalSteps: total, percentComplete: 100, isComplete: true };
  }

  const index = visible.findIndex((q) => q.id === currentQuestionId);
  if (index === -1) {
    // The current question was branched away under us; fall back to the first
    // unanswered visible question.
    const fallback = getNextUnansweredQuestion(config, answers);
    return getFunnelPosition(config, answers, fallback?.id ?? null);
  }

  return {
    current: visible[index] ?? null,
    stepNumber: index + 1,
    totalSteps: total,
    percentComplete: Math.round((index / Math.max(total, 1)) * 100),
    isComplete: false,
  };
}

/** First visible question without an answer - the canonical "resume point". */
export function getNextUnansweredQuestion(
  config: FunnelConfig,
  answers: FunnelAnswers,
): FunnelQuestion | null {
  const visible = getVisibleQuestions(config, answers);
  return visible.find((question) => !isAnswered(answers[question.id])) ?? null;
}

/** The visible question immediately after `currentQuestionId`, or null at the end. */
export function getNextQuestion(
  config: FunnelConfig,
  answers: FunnelAnswers,
  currentQuestionId: string,
): FunnelQuestion | null {
  const visible = getVisibleQuestions(config, answers);
  const index = visible.findIndex((q) => q.id === currentQuestionId);
  if (index === -1) return getNextUnansweredQuestion(config, answers);
  return visible[index + 1] ?? null;
}

/** The visible question immediately before `currentQuestionId`, or null at the start. */
export function getPreviousQuestion(
  config: FunnelConfig,
  answers: FunnelAnswers,
  currentQuestionId: string,
): FunnelQuestion | null {
  const visible = getVisibleQuestions(config, answers);
  const index = visible.findIndex((q) => q.id === currentQuestionId);
  if (index <= 0) return null;
  return visible[index - 1] ?? null;
}

/** True when every visible question has an answer. */
export function isFunnelComplete(config: FunnelConfig, answers: FunnelAnswers): boolean {
  return getNextUnansweredQuestion(config, answers) === null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Digits only, 10 (US) or 11 starting with a 1. Kept deliberately permissive. */
export function normalisePhone(raw: string): string {
  return raw.replace(/\D+/g, '');
}

export function isValidPhone(raw: string): boolean {
  const digits = normalisePhone(raw);
  if (digits.length === 11) return digits.startsWith('1');
  return digits.length === 10;
}

export function isValidEmail(raw: string): boolean {
  return EMAIL_PATTERN.test(raw.trim());
}

/**
 * Run a question's validation rules. Returns the first error message, or null.
 * Shared by the browser (instant feedback) and the API (source of truth).
 */
export function validateAnswer(
  rules: ValidationRule[] | undefined,
  value: AnswerValue | undefined,
): string | null {
  if (!rules || rules.length === 0) return null;
  const asString = Array.isArray(value) ? value.join(',') : (value ?? '');

  for (const rule of rules) {
    switch (rule.type) {
      case 'required':
        if (!isAnswered(value)) return rule.message ?? 'This answer is required';
        break;
      case 'email':
        if (asString && !isValidEmail(asString)) {
          return rule.message ?? 'Enter a valid email address';
        }
        break;
      case 'phone':
        if (asString && !isValidPhone(asString)) {
          return rule.message ?? 'Enter a valid 10-digit phone number';
        }
        break;
      case 'minLength':
        if (asString.trim().length < rule.value) {
          return rule.message ?? `Must be at least ${rule.value} characters`;
        }
        break;
      case 'maxLength':
        if (asString.trim().length > rule.value) {
          return rule.message ?? `Must be ${rule.value} characters or fewer`;
        }
        break;
      case 'pattern':
        if (asString && !new RegExp(rule.value).test(asString)) {
          return rule.message ?? 'That value does not look right';
        }
        break;
      default: {
        const exhaustive: never = rule;
        throw new Error(`Unsupported validation rule: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return null;
}

/**
 * Server-side guard: reject answers for questions the user should never have
 * been shown, and reject option values that are not in the config. This stops a
 * crafted payload from poisoning the CRM with impossible combinations.
 */
export interface AnswerAuditResult {
  valid: boolean;
  /** Answers that survived the audit. */
  accepted: FunnelAnswers;
  /** Human readable reasons, safe to log (contains ids, never answer values). */
  issues: string[];
}

export function auditAnswers(config: FunnelConfig, answers: FunnelAnswers): AnswerAuditResult {
  const issues: string[] = [];
  const byId = new Map(config.questions.map((q) => [q.id, q]));
  const accepted: FunnelAnswers = {};

  for (const [questionId, value] of Object.entries(answers)) {
    const question = byId.get(questionId);
    if (!question) {
      issues.push(`unknown_question:${questionId}`);
      continue;
    }
    if (!isAnswered(value)) continue;

    if (question.options && question.options.length > 0) {
      const allowed = new Set(question.options.map((o) => o.value));
      const values = Array.isArray(value) ? value : [value];
      const invalid = values.filter((v) => !allowed.has(v));
      if (invalid.length > 0) {
        issues.push(`invalid_option:${questionId}`);
        continue;
      }
    }

    accepted[questionId] = value;
  }

  // Drop anything that the branching rules say should never have been asked.
  const pruned = pruneOrphanedAnswers(config, accepted);
  for (const key of Object.keys(accepted)) {
    if (pruned[key] === undefined) issues.push(`unreachable_question:${key}`);
  }

  return { valid: issues.length === 0, accepted: pruned, issues };
}
