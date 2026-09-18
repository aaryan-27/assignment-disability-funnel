import { describe, expect, it } from 'vitest';
import {
  auditAnswers,
  evaluateCondition,
  funnelConfig,
  getFunnelPosition,
  getNextQuestion,
  getNextUnansweredQuestion,
  getPreviousQuestion,
  getVisibleQuestions,
  isFunnelComplete,
  isQuestionVisible,
  normalisePhone,
  pruneOrphanedAnswers,
  validateAnswer,
  type FunnelAnswers,
  type FunnelQuestion,
} from '../index.js';

/** Answers that reach the email step without triggering any branch. */
const baseAnswers: FunnelAnswers = {
  age_range: '55_63',
  receiving_benefits: 'none',
  work_hours: 'not_working',
  years_employed: 'over_6',
  asset_value: 'under_2000',
  out_of_work_year: 'yes',
  under_medical_care: 'yes',
  application_pending: 'no',
  gender: 'female',
  marital_status: 'married',
};

const findQuestion = (id: string): FunnelQuestion => {
  const question = funnelConfig.questions.find((item) => item.id === id);
  if (!question) throw new Error(`Test fixture missing question ${id}`);
  return question;
};

describe('evaluateCondition', () => {
  it('matches equals and not_equals', () => {
    const answers: FunnelAnswers = { application_pending: 'yes' };
    expect(
      evaluateCondition({ questionId: 'application_pending', operator: 'equals', value: 'yes' }, answers),
    ).toBe(true);
    expect(
      evaluateCondition({ questionId: 'application_pending', operator: 'equals', value: 'no' }, answers),
    ).toBe(false);
    expect(
      evaluateCondition({ questionId: 'application_pending', operator: 'not_equals', value: 'no' }, answers),
    ).toBe(true);
  });

  it('matches in and not_in', () => {
    const answers: FunnelAnswers = { receiving_benefits: 'ssi' };
    expect(
      evaluateCondition({ questionId: 'receiving_benefits', operator: 'in', value: ['ssi', 'both'] }, answers),
    ).toBe(true);
    expect(
      evaluateCondition({ questionId: 'receiving_benefits', operator: 'not_in', value: ['ssi', 'both'] }, answers),
    ).toBe(false);
  });

  it('treats an unanswered question as not_in nothing, so children stay hidden', () => {
    // Regression guard: if `not_in` returned true for an unanswered parent,
    // every dependent question would flash into view before its parent is asked.
    expect(
      evaluateCondition({ questionId: 'receiving_benefits', operator: 'not_in', value: ['ssi'] }, {}),
    ).toBe(false);
  });

  it('handles is_answered / is_not_answered', () => {
    expect(evaluateCondition({ questionId: 'gender', operator: 'is_answered' }, { gender: 'male' })).toBe(true);
    expect(evaluateCondition({ questionId: 'gender', operator: 'is_answered' }, { gender: '' })).toBe(false);
    expect(evaluateCondition({ questionId: 'gender', operator: 'is_not_answered' }, {})).toBe(true);
  });
});

describe('branching: attorney chain', () => {
  it('hides the whole attorney chain when no application is pending', () => {
    const answers: FunnelAnswers = { ...baseAnswers, application_pending: 'no' };
    const visibleIds = getVisibleQuestions(funnelConfig, answers).map((q) => q.id);

    expect(visibleIds).not.toContain('attorney_represented');
    expect(visibleIds).not.toContain('attorney_firm');
    expect(visibleIds).not.toContain('application_denied');
    expect(visibleIds).not.toContain('appeal_stage');
    expect(visibleIds).not.toContain('waiting_duration');
  });

  it('reveals attorney questions when an application is pending', () => {
    const answers: FunnelAnswers = { ...baseAnswers, application_pending: 'yes' };
    const visibleIds = getVisibleQuestions(funnelConfig, answers).map((q) => q.id);

    expect(visibleIds).toContain('attorney_represented');
    expect(visibleIds).toContain('application_denied');
    expect(visibleIds).toContain('waiting_duration');
    // The nested branch stays hidden until its own parent is answered.
    expect(visibleIds).not.toContain('attorney_firm');
  });

  it('reveals the firm question only when represented', () => {
    const answers: FunnelAnswers = {
      ...baseAnswers,
      application_pending: 'yes',
      attorney_represented: 'yes',
    };
    expect(isQuestionVisible(findQuestion('attorney_firm'), answers)).toBe(true);

    expect(
      isQuestionVisible(findQuestion('attorney_firm'), {
        ...answers,
        attorney_represented: 'no',
      }),
    ).toBe(false);
  });

  it('reveals the appeal stage only after a denial', () => {
    const answers: FunnelAnswers = {
      ...baseAnswers,
      application_pending: 'yes',
      application_denied: 'yes',
    };
    expect(isQuestionVisible(findQuestion('appeal_stage'), answers)).toBe(true);
    expect(
      isQuestionVisible(findQuestion('appeal_stage'), { ...answers, application_denied: 'no' }),
    ).toBe(false);
  });
});

describe('branching: asset test', () => {
  it('skips the asset question for people already receiving SSI', () => {
    for (const value of ['ssi', 'both']) {
      const answers: FunnelAnswers = { ...baseAnswers, receiving_benefits: value };
      expect(isQuestionVisible(findQuestion('asset_value'), answers)).toBe(false);
    }
  });

  it('asks the asset question for everyone else', () => {
    for (const value of ['ssd', 'none']) {
      const answers: FunnelAnswers = { ...baseAnswers, receiving_benefits: value };
      expect(isQuestionVisible(findQuestion('asset_value'), answers)).toBe(true);
    }
  });
});

describe('pruneOrphanedAnswers', () => {
  it('removes answers that a changed parent makes unreachable', () => {
    const answers: FunnelAnswers = {
      ...baseAnswers,
      application_pending: 'yes',
      attorney_represented: 'yes',
      attorney_firm: 'allsup',
      application_denied: 'yes',
      appeal_stage: 'hearing',
      waiting_duration: '3_to_6m',
    };

    // The user goes back and says there is no pending application.
    const pruned = pruneOrphanedAnswers(funnelConfig, {
      ...answers,
      application_pending: 'no',
    });

    expect(pruned.attorney_represented).toBeUndefined();
    expect(pruned.attorney_firm).toBeUndefined();
    expect(pruned.application_denied).toBeUndefined();
    expect(pruned.appeal_stage).toBeUndefined();
    expect(pruned.waiting_duration).toBeUndefined();
    // Untouched answers survive.
    expect(pruned.age_range).toBe('55_63');
  });

  it('cascades through multiple levels in one pass', () => {
    // attorney_firm depends on attorney_represented, which depends on
    // application_pending. Removing the grandparent must remove both.
    const pruned = pruneOrphanedAnswers(funnelConfig, {
      ...baseAnswers,
      application_pending: 'no',
      attorney_represented: 'yes',
      attorney_firm: 'allsup',
    });

    expect(pruned.attorney_represented).toBeUndefined();
    expect(pruned.attorney_firm).toBeUndefined();
  });

  it('leaves a fully valid answer set untouched', () => {
    expect(pruneOrphanedAnswers(funnelConfig, baseAnswers)).toEqual(baseAnswers);
  });
});

describe('question progression', () => {
  it('walks the short path and reaches the contact step', () => {
    let answers: FunnelAnswers = {};
    let current = funnelConfig.questions[0]!;
    const visited: string[] = [];
    let guard = 0;

    while (guard < 50) {
      guard += 1;
      visited.push(current.id);

      // Choose the value the fixture prescribes, else the first option.
      const value = baseAnswers[current.id] ?? current.options?.[0]?.value ?? 'x';
      answers = pruneOrphanedAnswers(funnelConfig, { ...answers, [current.id]: value });

      const next = getNextQuestion(funnelConfig, answers, current.id);
      if (!next) break;
      current = next;
    }

    expect(visited[0]).toBe('age_range');
    expect(visited).toContain('email');
    expect(visited).toContain('contact');
    // application_pending answered 'no' means the attorney chain never appears.
    expect(visited).not.toContain('attorney_firm');
  });

  it('getPreviousQuestion walks back along the visible path only', () => {
    const answers: FunnelAnswers = { ...baseAnswers, application_pending: 'no' };
    const previous = getPreviousQuestion(funnelConfig, answers, 'gender');

    // With no pending application, the step before gender is application_pending,
    // not one of the skipped attorney questions.
    expect(previous?.id).toBe('application_pending');
  });

  it('returns null when going back from the first question', () => {
    expect(getPreviousQuestion(funnelConfig, {}, 'age_range')).toBeNull();
  });

  it('finds the first unanswered question as the resume point', () => {
    const answers: FunnelAnswers = { age_range: '50_54', receiving_benefits: 'none' };
    expect(getNextUnansweredQuestion(funnelConfig, answers)?.id).toBe('work_hours');
  });
});

describe('getFunnelPosition', () => {
  it('reports a 1-based step and a percentage', () => {
    const position = getFunnelPosition(funnelConfig, baseAnswers, 'age_range');
    expect(position.stepNumber).toBe(1);
    expect(position.percentComplete).toBe(0);
    expect(position.isComplete).toBe(false);
    expect(position.totalSteps).toBeGreaterThan(5);
  });

  it('marks completion when there is no current question', () => {
    const position = getFunnelPosition(funnelConfig, baseAnswers, null);
    expect(position.isComplete).toBe(true);
    expect(position.percentComplete).toBe(100);
  });

  it('recovers when the current question has been branched away', () => {
    // attorney_firm is not visible for this answer set; the position resolver
    // must fall back rather than return a broken step.
    const position = getFunnelPosition(funnelConfig, baseAnswers, 'attorney_firm');
    expect(position.current).not.toBeNull();
    expect(position.current?.id).not.toBe('attorney_firm');
  });

  it('shows a shorter total when a branch is skipped', () => {
    const withBranch = getFunnelPosition(
      funnelConfig,
      { ...baseAnswers, application_pending: 'yes' },
      'gender',
    );
    const withoutBranch = getFunnelPosition(
      funnelConfig,
      { ...baseAnswers, application_pending: 'no' },
      'gender',
    );
    expect(withBranch.totalSteps).toBeGreaterThan(withoutBranch.totalSteps);
  });
});

describe('isFunnelComplete', () => {
  it('is false until every visible question is answered', () => {
    expect(isFunnelComplete(funnelConfig, baseAnswers)).toBe(false);
  });

  it('is true once the visible path is fully answered', () => {
    const complete: FunnelAnswers = {
      ...baseAnswers,
      email: 'test@example.com',
      contact: 'provided',
    };
    expect(isFunnelComplete(funnelConfig, complete)).toBe(true);
  });
});

describe('validateAnswer', () => {
  it('enforces required', () => {
    expect(validateAnswer([{ type: 'required' }], undefined)).toBeTruthy();
    expect(validateAnswer([{ type: 'required' }], '')).toBeTruthy();
    expect(validateAnswer([{ type: 'required' }], 'yes')).toBeNull();
  });

  it('validates email shape', () => {
    expect(validateAnswer([{ type: 'email' }], 'not-an-email')).toBeTruthy();
    expect(validateAnswer([{ type: 'email' }], 'a@b')).toBeTruthy();
    expect(validateAnswer([{ type: 'email' }], 'user@example.com')).toBeNull();
  });

  it('validates US phone numbers', () => {
    expect(validateAnswer([{ type: 'phone' }], '555')).toBeTruthy();
    expect(validateAnswer([{ type: 'phone' }], '(415) 555-0132')).toBeNull();
    expect(validateAnswer([{ type: 'phone' }], '14155550132')).toBeNull();
    // 11 digits not starting with 1 is not a US number.
    expect(validateAnswer([{ type: 'phone' }], '24155550132')).toBeTruthy();
  });

  it('returns a custom message when supplied', () => {
    expect(validateAnswer([{ type: 'required', message: 'Pick one' }], '')).toBe('Pick one');
  });

  it('normalises phone numbers to digits', () => {
    expect(normalisePhone('(415) 555-0132')).toBe('4155550132');
  });
});

describe('auditAnswers', () => {
  it('accepts a legitimate answer set', () => {
    const result = auditAnswers(funnelConfig, baseAnswers);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.accepted.age_range).toBe('55_63');
  });

  it('rejects an option value that is not in the config', () => {
    const result = auditAnswers(funnelConfig, { ...baseAnswers, age_range: 'immortal' });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('invalid_option:age_range');
    expect(result.accepted.age_range).toBeUndefined();
  });

  it('rejects unknown question ids', () => {
    const result = auditAnswers(funnelConfig, { ...baseAnswers, injected_field: 'evil' });
    expect(result.issues).toContain('unknown_question:injected_field');
    expect(result.accepted.injected_field).toBeUndefined();
  });

  it('strips answers the user could never have been shown', () => {
    // A crafted payload claiming attorney details while denying a pending
    // application. The server must not persist the impossible combination.
    const result = auditAnswers(funnelConfig, {
      ...baseAnswers,
      application_pending: 'no',
      attorney_represented: 'yes',
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('unreachable_question:attorney_represented');
    expect(result.accepted.attorney_represented).toBeUndefined();
  });

  it('never reports answer values in its issue codes', () => {
    // Issues get logged, so they must contain ids only - never user data.
    const result = auditAnswers(funnelConfig, { ...baseAnswers, age_range: 'super-secret-value' });
    for (const issue of result.issues) {
      expect(issue).not.toContain('super-secret-value');
    }
  });
});
