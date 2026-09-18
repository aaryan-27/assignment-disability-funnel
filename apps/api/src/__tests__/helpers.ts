import type { Server } from 'node:http';
import type { Express } from 'express';
import type { LeadSubmission } from '@funnel/shared';
import { newEventId, newSessionId } from '@funnel/shared';

/**
 * Bind ONE server for the whole test file.
 *
 * Passing an un-listening Express app to supertest makes it bind a fresh
 * ephemeral port for every single request. Under CPU contention those ports get
 * recycled fast enough that a new connection can land on a port a closing
 * server still holds, and the response from an earlier request is delivered to
 * a later one - which shows up as a bizarre status (a POST /api/leads answered
 * with the 401 belonging to an admin test). Binding once removes the whole
 * class of flake.
 */
export function listenOnce(app: Express): Server {
  return app.listen(0);
}

/** A complete, valid submission that qualifies. Override per test. */
export function buildSubmission(overrides: Partial<LeadSubmission> = {}): LeadSubmission {
  const eventId = newEventId();

  return {
    contact: {
      first_name: 'Dana',
      last_name: 'Whitfield',
      email: `dana.${Math.random().toString(36).slice(2, 10)}@example.com`,
      phone: '4155550132',
    },
    answers: {
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
    },
    attribution: {
      utm_source: 'facebook',
      utm_medium: 'paid_social',
      utm_campaign: 'ssdi_prospecting_q3',
      fbclid: 'IwAR0TestClickId',
      landing_page: 'https://funnel.example.com/qualification',
      funnel_version: 'qualification-v1',
    },
    client: {
      session_id: newSessionId(),
      event_id: eventId,
      pixel_fired: true,
    },
    ...overrides,
  } as LeadSubmission;
}

/** Polls until `predicate` is true or the budget runs out. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}
