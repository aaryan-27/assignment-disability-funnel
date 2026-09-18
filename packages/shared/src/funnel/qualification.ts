import type { FunnelAnswers } from './types.js';

export type QualificationOutcome = 'qualified' | 'review' | 'disqualified';

export interface QualificationResult {
  outcome: QualificationOutcome;
  /** 0-100. Used for routing and for prioritising the call queue. */
  score: number;
  /**
   * Machine-readable reason codes. These are safe to store in the CRM and to
   * show internally, but they are NEVER sent to an ad platform - they encode
   * health information.
   */
  reasons: string[];
}

/**
 * Deterministic, explainable qualification.
 *
 * Why not send everyone to Meta as a `Lead`? Because Meta optimises toward
 * whatever you tell it is a conversion. Reporting unqualified leads as `Lead`
 * teaches the algorithm to find more unqualified people. Only `qualified` and
 * `review` outcomes are reported as a conversion; `disqualified` leads are
 * still captured and stored, they just do not train the ad auction.
 */
export function evaluateQualification(answers: FunnelAnswers): QualificationResult {
  const reasons: string[] = [];
  let score = 50;

  const get = (id: string): string | undefined => {
    const value = answers[id];
    return Array.isArray(value) ? value[0] : value;
  };

  // --- Hard disqualifiers -------------------------------------------------
  // Substantial Gainful Activity: consistent full-time work defeats a claim.
  if (get('work_hours') === 'over_20') {
    reasons.push('working_above_sga_threshold');
    return { outcome: 'disqualified', score: 0, reasons };
  }

  // The statutory duration requirement is 12 months.
  if (get('out_of_work_year') === 'no') {
    reasons.push('does_not_meet_duration_requirement');
    return { outcome: 'disqualified', score: 0, reasons };
  }

  // Already receiving both programmes: nothing left for us to help with.
  if (get('receiving_benefits') === 'both') {
    reasons.push('already_receiving_full_benefits');
    return { outcome: 'disqualified', score: 0, reasons };
  }

  // --- Positive signals ---------------------------------------------------
  const age = get('age_range');
  if (age === '55_63') {
    score += 20;
    reasons.push('age_favourable_grid_rules');
  } else if (age === '50_54') {
    score += 15;
    reasons.push('age_favourable_grid_rules');
  } else if (age === '64_plus') {
    score += 5;
    reasons.push('age_near_retirement');
  } else if (age === 'under_40') {
    score -= 15;
    reasons.push('age_unfavourable');
  }

  if (get('under_medical_care') === 'yes') {
    score += 15;
    reasons.push('active_medical_evidence');
  } else {
    score -= 20;
    reasons.push('no_active_medical_evidence');
  }

  const years = get('years_employed');
  if (years === 'over_6' || years === '4_to_6') {
    score += 10;
    reasons.push('sufficient_work_credits');
  } else if (years === 'under_2') {
    score -= 5;
    reasons.push('limited_work_credits');
  }

  if (get('work_hours') === 'not_working') {
    score += 10;
    reasons.push('not_currently_working');
  }

  // Representation lowers commercial value: the lead is already spoken for.
  if (get('attorney_represented') === 'yes') {
    score -= 25;
    reasons.push('already_represented');
  }

  // A denial that is actively being appealed is a high-intent lead.
  if (get('application_denied') === 'yes') {
    score += 10;
    reasons.push('denied_and_appealing');
  }

  score = Math.max(0, Math.min(100, score));

  let outcome: QualificationOutcome;
  if (score >= 70) outcome = 'qualified';
  else if (score >= 45) outcome = 'review';
  else outcome = 'disqualified';

  return { outcome, score, reasons };
}

/** Only these outcomes are worth reporting to Meta as a conversion. */
export function isReportableConversion(outcome: QualificationOutcome): boolean {
  return outcome === 'qualified' || outcome === 'review';
}
