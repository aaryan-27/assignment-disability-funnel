import { describe, expect, it } from 'vitest';
import {
  EVENT_DEFINITIONS,
  FUNNEL_EVENTS,
  META_ALLOWED_CUSTOM_PARAMS,
  evaluateQualification,
  funnelConfig,
  getMetaEventName,
  isReportableConversion,
  isValidId,
  newEventId,
  newLeadId,
  newSessionId,
  sanitiseMetaCustomData,
  shouldSendToMeta,
  toLeadQualityBucket,
  type FunnelAnswers,
} from '../index.js';

describe('id generation', () => {
  it('produces correctly prefixed ids', () => {
    expect(newLeadId()).toMatch(/^ld_[a-z0-9]{16}$/);
    expect(newEventId()).toMatch(/^evt_[a-z0-9]{18}$/);
    expect(newSessionId()).toMatch(/^ses_[a-z0-9]{16}$/);
  });

  it('does not collide across a large batch', () => {
    // Collisions here would mean two different conversions sharing a dedup key,
    // which would make Meta silently drop a real conversion.
    const ids = new Set(Array.from({ length: 20_000 }, () => newEventId()));
    expect(ids.size).toBe(20_000);
  });

  it('validates id shape and prefix', () => {
    const leadId = newLeadId();
    expect(isValidId(leadId)).toBe(true);
    expect(isValidId(leadId, 'ld')).toBe(true);
    expect(isValidId(leadId, 'evt')).toBe(false);
    expect(isValidId('not-an-id')).toBe(false);
    expect(isValidId('ld_SHORT')).toBe(false);
  });
});

describe('event taxonomy', () => {
  it('routes each event to the correct transport', () => {
    // PageView is browser-only: there is no server-side value in duplicating it.
    expect(shouldSendToMeta('PageView', 'browser')).toBe(true);
    expect(shouldSendToMeta('PageView', 'server')).toBe(false);

    // QualificationCompleted is server-only so an ad blocker cannot suppress it.
    expect(shouldSendToMeta('QualificationCompleted', 'server')).toBe(true);
    expect(shouldSendToMeta('QualificationCompleted', 'browser')).toBe(false);

    // Lead is dual-sent, which is exactly why it needs a shared event_id.
    expect(shouldSendToMeta('Lead', 'browser')).toBe(true);
    expect(shouldSendToMeta('Lead', 'server')).toBe(true);
  });

  it('never forwards internal-only events to Meta', () => {
    for (const source of ['browser', 'server'] as const) {
      expect(shouldSendToMeta('QuestionCompleted', source)).toBe(false);
      expect(shouldSendToMeta('QualificationStarted', source)).toBe(false);
    }
    expect(getMetaEventName('QuestionCompleted')).toBeUndefined();
  });

  it('requires a shared event id for every dual-sent event', () => {
    for (const definition of Object.values(EVENT_DEFINITIONS)) {
      if (definition.delivery === 'both') {
        expect(definition.requiresSharedEventId).toBe(true);
      }
    }
  });

  it('maps funnel events onto Meta standard events where one exists', () => {
    expect(getMetaEventName('Lead')).toBe('Lead');
    expect(getMetaEventName('EmailCaptured')).toBe('CompleteRegistration');
  });

  it('defines every event in the taxonomy', () => {
    for (const name of Object.values(FUNNEL_EVENTS)) {
      expect(EVENT_DEFINITIONS[name]).toBeDefined();
    }
  });
});

describe('privacy guard: sanitiseMetaCustomData', () => {
  it('keeps allowlisted parameters', () => {
    const { data, dropped } = sanitiseMetaCustomData({
      content_name: 'disability-qualification',
      funnel_version: 'qualification-v1',
      value: 120,
      currency: 'USD',
    });

    expect(data.content_name).toBe('disability-qualification');
    expect(data.value).toBe(120);
    expect(dropped).toEqual([]);
  });

  it('drops every sensitive questionnaire answer', () => {
    // This is the single most important test in the repo. If it ever fails,
    // health data is on its way to an ad platform.
    const { data, dropped } = sanitiseMetaCustomData({
      content_name: 'disability-qualification',
      receiving_benefits: 'ssi',
      under_medical_care: 'yes',
      asset_value: 'under_2000',
      appeal_stage: 'hearing',
      work_hours: 'not_working',
      qualification_reasons: 'active_medical_evidence',
      qualification_score: 85,
      email: 'user@example.com',
      phone: '4155550132',
    });

    expect(data.content_name).toBe('disability-qualification');
    for (const leaked of [
      'receiving_benefits',
      'under_medical_care',
      'asset_value',
      'appeal_stage',
      'work_hours',
      'qualification_reasons',
      'qualification_score',
      'email',
      'phone',
    ]) {
      expect(data[leaked]).toBeUndefined();
      expect(dropped).toContain(leaked);
    }
  });

  it('denies by default, so a newly added question cannot leak', () => {
    const { data, dropped } = sanitiseMetaCustomData({ brand_new_question: 'sensitive answer' });
    expect(data.brand_new_question).toBeUndefined();
    expect(dropped).toContain('brand_new_question');
  });

  it('never allowlists a real question id', () => {
    // Structural guarantee: no funnel question id may appear in the allowlist.
    for (const question of funnelConfig.questions) {
      expect(META_ALLOWED_CUSTOM_PARAMS.has(question.id)).toBe(false);
    }
  });

  it('strips empty values so match quality is not diluted', () => {
    const { data } = sanitiseMetaCustomData({ content_name: '', value: undefined, currency: 'USD' });
    expect(data.content_name).toBeUndefined();
    expect(data.value).toBeUndefined();
    expect(data.currency).toBe('USD');
  });

  it('reduces the qualification outcome to a coarse bucket', () => {
    // Meta gets 'priority' / 'standard', never the numeric score or reasons.
    expect(toLeadQualityBucket('qualified')).toBe('priority');
    expect(toLeadQualityBucket('review')).toBe('standard');
    expect(toLeadQualityBucket('disqualified')).toBe('standard');
  });
});

describe('qualification scoring', () => {
  const qualifying: FunnelAnswers = {
    age_range: '55_63',
    receiving_benefits: 'none',
    work_hours: 'not_working',
    years_employed: 'over_6',
    out_of_work_year: 'yes',
    under_medical_care: 'yes',
    application_pending: 'no',
  };

  it('qualifies a strong candidate', () => {
    const result = evaluateQualification(qualifying);
    expect(result.outcome).toBe('qualified');
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons).toContain('age_favourable_grid_rules');
  });

  it('disqualifies work above the SGA threshold immediately', () => {
    const result = evaluateQualification({ ...qualifying, work_hours: 'over_20' });
    expect(result.outcome).toBe('disqualified');
    expect(result.score).toBe(0);
    expect(result.reasons).toContain('working_above_sga_threshold');
  });

  it('disqualifies when the 12-month duration test fails', () => {
    const result = evaluateQualification({ ...qualifying, out_of_work_year: 'no' });
    expect(result.outcome).toBe('disqualified');
    expect(result.reasons).toContain('does_not_meet_duration_requirement');
  });

  it('disqualifies someone already receiving both programmes', () => {
    const result = evaluateQualification({ ...qualifying, receiving_benefits: 'both' });
    expect(result.outcome).toBe('disqualified');
    expect(result.reasons).toContain('already_receiving_full_benefits');
  });

  it('penalises an already-represented lead', () => {
    const represented = evaluateQualification({
      ...qualifying,
      application_pending: 'yes',
      attorney_represented: 'yes',
    });
    const unrepresented = evaluateQualification({
      ...qualifying,
      application_pending: 'yes',
      attorney_represented: 'no',
    });

    expect(represented.score).toBeLessThan(unrepresented.score);
    expect(represented.reasons).toContain('already_represented');
  });

  it('penalises the absence of medical evidence', () => {
    const result = evaluateQualification({ ...qualifying, under_medical_care: 'no' });
    expect(result.score).toBeLessThan(evaluateQualification(qualifying).score);
    expect(result.reasons).toContain('no_active_medical_evidence');
  });

  it('keeps the score inside 0-100 for every option combination', () => {
    for (const age of ['under_40', '40_49', '50_54', '55_63', '64_plus']) {
      for (const care of ['yes', 'no']) {
        for (const years of ['under_2', '2_to_4', '4_to_6', 'over_6']) {
          const result = evaluateQualification({
            ...qualifying,
            age_range: age,
            under_medical_care: care,
            years_employed: years,
          });
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('is deterministic', () => {
    // The same answers must always produce the same routing decision.
    expect(evaluateQualification(qualifying)).toEqual(evaluateQualification(qualifying));
  });

  it('only reports qualified and review outcomes as conversions', () => {
    // Reporting unqualified leads to Meta would train the algorithm to find
    // more unqualified people.
    expect(isReportableConversion('qualified')).toBe(true);
    expect(isReportableConversion('review')).toBe(true);
    expect(isReportableConversion('disqualified')).toBe(false);
  });
});
